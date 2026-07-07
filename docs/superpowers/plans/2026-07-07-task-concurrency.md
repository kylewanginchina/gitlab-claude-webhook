# Task Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make webhook task processing safely concurrent by isolating per-run state and adding an in-memory queue that serializes the same GitLab resource while allowing different resources to run in parallel.

**Architecture:** Add a focused `RunQueue` service for global concurrency and per-resource locking. Refactor `EventProcessor` to pass a per-run `EventRunContext` instead of storing mutable progress state on the singleton instance. Integrate the queue in `WebhookServer` without changing review strategy, plugin behavior, CodeRabbit, or runner execution.

**Tech Stack:** TypeScript, Jest, Express, existing GitLab webhook/event types.

## Global Constraints

- Do not change review prompts, review tool policies, CodeRabbit, plugin support, or runner/deepflow behavior in this task.
- Preserve existing webhook response behavior as much as possible; returning extra queue metadata is allowed.
- Same GitLab resource must run sequentially: key is `projectId + resourceType + resourceIid`.
- Different GitLab resources may run concurrently up to a configurable global limit.
- Production concurrency is read from `WEBHOOK_TASK_CONCURRENCY`; invalid or missing values fall back to `2`.
- Default global concurrency is `2`.
- Existing review pass concurrency and scoring concurrency are unrelated and must remain unchanged.
- Use TDD: every production behavior change needs a failing test first.

---

## File Structure

- Create `src/services/runQueue.ts`
  - Owns in-memory task queue, global concurrency, per-resource serialization, run ids, and resource key derivation.
- Create `src/__tests__/runQueue.test.ts`
  - Tests queue scheduling and resource key derivation.
- Modify `src/services/eventProcessor.ts`
  - Adds `EventRunContext`.
  - Removes per-run mutable class state from `currentCommentId`, `currentDiscussionId`, and `progressMessages`.
  - Passes `EventRunContext` through instruction extraction, execution, comment creation, comment posting, and progress updates.
- Modify `src/__tests__/runtimeConfigExecution.test.ts`
  - Updates existing progress formatting test to use `EventRunContext`.
  - Adds a regression test proving two contexts do not share progress comment state.
- Modify `src/server/webhookServer.ts`
  - Adds `RunQueue` integration.
  - Enqueues event processing instead of calling `processEvent` directly.
  - Adds optional constructor injection for tests.
- Create `src/__tests__/webhookServerQueue.test.ts`
  - Tests that webhook handling enqueues work and returns without waiting.
  - Tests same MR events are serialized through the queue.

---

### Task 1: Add RunQueue

**Files:**
- Create: `src/services/runQueue.ts`
- Create: `src/__tests__/runQueue.test.ts`

**Interfaces:**
- Produces: `RunQueue`, `RunQueueOptions`, `QueuedRun`, `getGitLabEventResourceKey(event: GitLabWebhookEvent): string`
- Consumes: `GitLabWebhookEvent` from `src/types/gitlab.ts`

- [ ] **Step 1: Write the failing queue tests**

Create `src/__tests__/runQueue.test.ts`:

```typescript
import { RunQueue, getGitLabEventResourceKey } from '../services/runQueue';
import { GitLabWebhookEvent } from '../types/gitlab';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

function createEvent(overrides: Partial<GitLabWebhookEvent> = {}): GitLabWebhookEvent {
  return {
    object_kind: 'merge_request',
    user: { id: 1, name: 'Test User', username: 'tester', email: 'tester@example.com' },
    project: {
      id: 10,
      name: 'demo',
      web_url: 'https://gitlab.example.com/group/demo',
      default_branch: 'main',
      http_url_to_repo: 'https://gitlab.example.com/group/demo.git',
    },
    object_attributes: {},
    merge_request: {
      id: 100,
      iid: 7,
      title: 'MR 7',
      description: '@claude test',
      state: 'opened',
      web_url: 'https://gitlab.example.com/group/demo/-/merge_requests/7',
      source_branch: 'feature',
      target_branch: 'main',
      author: { id: 1, name: 'Test User', username: 'tester', email: 'tester@example.com' },
    },
    ...overrides,
  };
}

describe('RunQueue', () => {
  it('runs different resources concurrently but serializes the same resource', async () => {
    const queue = new RunQueue({ globalConcurrency: 2 });
    const firstSameResource = deferred();
    const events: string[] = [];

    const runA1 = queue.enqueue({
      resourceKey: 'project:10:mr:1',
      run: async () => {
        events.push('a1:start');
        await firstSameResource.promise;
        events.push('a1:end');
      },
    });

    const runA2 = queue.enqueue({
      resourceKey: 'project:10:mr:1',
      run: async () => {
        events.push('a2:start');
      },
    });

    const runB1 = queue.enqueue({
      resourceKey: 'project:10:mr:2',
      run: async () => {
        events.push('b1:start');
      },
    });

    await flushPromises();

    expect(events).toEqual(['a1:start', 'b1:start']);
    expect(queue.getStats()).toMatchObject({ running: 1, queued: 1 });

    firstSameResource.resolve();
    await Promise.all([runA1.promise, runA2.promise, runB1.promise]);

    expect(events).toEqual(['a1:start', 'b1:start', 'a1:end', 'a2:start']);
    expect(queue.getStats()).toMatchObject({ running: 0, queued: 0 });
  });

  it('rejects queued run promises when the task fails and continues draining', async () => {
    const queue = new RunQueue({ globalConcurrency: 1 });
    const events: string[] = [];

    const failed = queue.enqueue({
      resourceKey: 'project:10:mr:1',
      run: async () => {
        events.push('first');
        throw new Error('boom');
      },
    });

    const next = queue.enqueue({
      resourceKey: 'project:10:mr:2',
      run: async () => {
        events.push('second');
      },
    });

    await expect(failed.promise).rejects.toThrow('boom');
    await next.promise;

    expect(events).toEqual(['first', 'second']);
  });

  it('builds resource keys for merge request notes using the merge request iid', () => {
    const event = createEvent({
      object_kind: 'note',
      object_attributes: { id: 555, note: '@claude review' },
    });

    expect(getGitLabEventResourceKey(event)).toBe('project:10:merge_request:7');
  });

  it('builds resource keys for issue events using the issue iid', () => {
    const event = createEvent({
      object_kind: 'issue',
      merge_request: undefined,
      issue: {
        id: 200,
        iid: 3,
        title: 'Issue 3',
        description: '@claude fix',
        state: 'opened',
        web_url: 'https://gitlab.example.com/group/demo/-/issues/3',
        author: { id: 1, name: 'Test User', username: 'tester', email: 'tester@example.com' },
      },
    });

    expect(getGitLabEventResourceKey(event)).toBe('project:10:issue:3');
  });
});
```

- [ ] **Step 2: Run the failing queue tests**

Run:

```bash
npm test -- src/__tests__/runQueue.test.ts
```

Expected:

```text
FAIL src/__tests__/runQueue.test.ts
Cannot find module '../services/runQueue'
```

- [ ] **Step 3: Implement `RunQueue`**

Create `src/services/runQueue.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import { GitLabWebhookEvent } from '../types/gitlab';

export interface RunQueueOptions {
  globalConcurrency?: number;
}

export interface RunQueueJob<T> {
  id?: string;
  resourceKey: string;
  run: () => Promise<T>;
}

export interface QueuedRun<T> {
  id: string;
  resourceKey: string;
  promise: Promise<T>;
}

interface PendingRun<T> extends QueuedRun<T> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function getGitLabEventResourceKey(event: GitLabWebhookEvent): string {
  const projectId = event.project?.id ?? 'unknown';

  if (event.merge_request) {
    return `project:${projectId}:merge_request:${event.merge_request.iid}`;
  }

  if (event.issue) {
    return `project:${projectId}:issue:${event.issue.iid}`;
  }

  const objectAttributes = event.object_attributes as { id?: number | string };
  const fallbackId = objectAttributes?.id ?? 'unknown';
  return `project:${projectId}:${event.object_kind}:${fallbackId}`;
}

export class RunQueue {
  private readonly globalConcurrency: number;
  private readonly pendingRuns: Array<PendingRun<unknown>> = [];
  private readonly activeResourceKeys = new Set<string>();
  private runningCount = 0;

  constructor(options: RunQueueOptions = {}) {
    this.globalConcurrency = Math.max(1, Math.floor(options.globalConcurrency ?? 2));
  }

  public enqueue<T>(job: RunQueueJob<T>): QueuedRun<T> {
    const id = job.id || uuidv4();

    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const pendingRun: PendingRun<T> = {
      id,
      resourceKey: job.resourceKey,
      run: job.run,
      promise,
      resolve,
      reject,
    };

    this.pendingRuns.push(pendingRun as PendingRun<unknown>);
    this.drain();

    return { id, resourceKey: job.resourceKey, promise };
  }

  public getStats(): { queued: number; running: number; activeResourceKeys: string[] } {
    return {
      queued: this.pendingRuns.length,
      running: this.runningCount,
      activeResourceKeys: [...this.activeResourceKeys],
    };
  }

  private drain(): void {
    while (this.runningCount < this.globalConcurrency) {
      const nextIndex = this.pendingRuns.findIndex(
        run => !this.activeResourceKeys.has(run.resourceKey)
      );

      if (nextIndex < 0) {
        return;
      }

      const [nextRun] = this.pendingRuns.splice(nextIndex, 1);
      this.start(nextRun);
    }
  }

  private start<T>(pendingRun: PendingRun<T>): void {
    this.runningCount += 1;
    this.activeResourceKeys.add(pendingRun.resourceKey);

    Promise.resolve()
      .then(() => pendingRun.run())
      .then(pendingRun.resolve, pendingRun.reject)
      .finally(() => {
        this.runningCount -= 1;
        this.activeResourceKeys.delete(pendingRun.resourceKey);
        this.drain();
      });
  }
}
```

- [ ] **Step 4: Verify queue tests pass**

Run:

```bash
npm test -- src/__tests__/runQueue.test.ts
```

Expected:

```text
PASS src/__tests__/runQueue.test.ts
```

- [ ] **Step 5: Commit Task 1**

```bash
git add src/services/runQueue.ts src/__tests__/runQueue.test.ts
git commit -m "feat: add webhook task run queue"
```

---

### Task 2: Isolate EventProcessor Run State

**Files:**
- Modify: `src/services/eventProcessor.ts`
- Modify: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**
- Consumes: existing `EventProcessor.processEvent(event)` entry point.
- Produces: private `EventRunContext` flow used by `extractInstruction`, `executeInstruction`, `postComment`, `createProgressComment`, and `updateProgressComment`.

- [ ] **Step 1: Write the failing isolation test**

Add this test near the existing progress comment tests in `src/__tests__/runtimeConfigExecution.test.ts`:

```typescript
  it('keeps progress comment state isolated per run context', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-06T09:20:31.817Z'));

    const processor = new EventProcessor();
    const eventA = createMergeRequestEvent();
    const eventB = createMergeRequestEvent();
    if (eventB.merge_request) {
      eventB.merge_request.iid = 99;
    }

    const contextA = (processor as any).createRunContext();
    const contextB = (processor as any).createRunContext();
    contextA.currentCommentId = 101;
    contextB.currentCommentId = 202;

    (processor as any).updateComment = jest.fn().mockResolvedValue(undefined);

    await Promise.all([
      (processor as any).updateProgressComment(eventA, contextA, 'Task A progress', false),
      (processor as any).updateProgressComment(eventB, contextB, 'Task B progress', false),
    ]);

    const calls = (processor as any).updateComment.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe(101);
    expect(calls[0][2]).toContain('Task A progress');
    expect(calls[0][2]).not.toContain('Task B progress');
    expect(calls[1][1]).toBe(202);
    expect(calls[1][2]).toContain('Task B progress');
    expect(calls[1][2]).not.toContain('Task A progress');

    jest.useRealTimers();
  });
```

Update the existing `formats progress comments as an aligned enterprise review table` test to use a run context:

```typescript
    const context = (processor as any).createRunContext();
    context.currentCommentId = 101;
    (processor as any).updateComment = jest.fn().mockResolvedValue(undefined);

    await (processor as any).updateProgressComment(
      event,
      context,
      '🔎 Grep infer_l7_class_1 in /tmp/gitlab-claude-work/agent/src/ebpf/k...',
      false
    );
```

- [ ] **Step 2: Run the failing EventProcessor test**

Run:

```bash
npm test -- src/__tests__/runtimeConfigExecution.test.ts --runInBand
```

Expected:

```text
FAIL src/__tests__/runtimeConfigExecution.test.ts
createRunContext is not a function
```

- [ ] **Step 3: Add `EventRunContext` and thread it through EventProcessor**

In `src/services/eventProcessor.ts`, add the interface near the imports:

```typescript
interface EventRunContext {
  currentCommentId: number | null;
  currentDiscussionId: string | null;
  progressMessages: ProgressEntry[];
}
```

Replace the class fields:

```typescript
  private currentCommentId: number | null = null;
  private currentDiscussionId: string | null = null;
```

with:

```typescript
  private createRunContext(): EventRunContext {
    return {
      currentCommentId: null,
      currentDiscussionId: null,
      progressMessages: [],
    };
  }
```

Change `processEvent` to create and pass the context:

```typescript
  public async processEvent(event: GitLabWebhookEvent): Promise<void> {
    const runContext = this.createRunContext();

    try {
      const instruction = await this.extractInstruction(event, runContext);

      if (!instruction) {
        logger.debug('No Claude instruction found in event', {
          eventType: event.object_kind,
          projectId: event.project.id,
        });
        return;
      }

      logger.info('Processing AI instruction', {
        eventType: event.object_kind,
        projectId: event.project.id,
        provider: instruction.provider,
        instruction: instruction.command.substring(0, 100),
      });

      await this.executeInstruction(event, instruction, runContext);
    } catch (error) {
      logger.error('Error processing event:', error);
      await this.reportError(event, error, runContext);
    }
  }
```

Update method signatures and call sites:

```typescript
  private async extractInstruction(
    event: GitLabWebhookEvent,
    runContext: EventRunContext
  ): Promise<AIInstruction | null>
```

```typescript
  private async getThreadContext(
    type: 'issue' | 'merge_request',
    projectId: number,
    itemIid: number,
    noteId: number,
    runContext: EventRunContext
  ): Promise<string | null>
```

Inside `getThreadContext`, replace:

```typescript
        this.currentDiscussionId = result.discussionId;
```

with:

```typescript
        runContext.currentDiscussionId = result.discussionId;
```

Continue threading `runContext` through:

```typescript
  private async executeInstruction(
    event: GitLabWebhookEvent,
    instruction: AIInstruction,
    runContext: EventRunContext
  ): Promise<void>
```

```typescript
  private async executeCodeReview(
    event: GitLabWebhookEvent,
    instruction: AIInstruction,
    baseBranch: string,
    projectPath: string,
    callback: StreamingProgressCallback,
    runContext: EventRunContext,
    reviewSettings: RuntimeConfig['review'] = runtimeConfigService.getConfig().review,
    userFocus: string | undefined = extractCodeReviewFocus(
      instruction.command,
      reviewSettings.allowedCommands
    )
  ): Promise<void>
```

```typescript
  private async handleSuccess(
    event: GitLabWebhookEvent,
    instruction: AIInstruction,
    result: any,
    baseBranch: string,
    projectPath: string,
    runContext: EventRunContext
  ): Promise<void>
```

```typescript
  private async handleFailure(
    event: GitLabWebhookEvent,
    instruction: AIInstruction,
    result: any,
    runContext: EventRunContext
  ): Promise<void>
```

```typescript
  private async reportError(
    event: GitLabWebhookEvent,
    error: any,
    runContext: EventRunContext
  ): Promise<void>
```

```typescript
  private async postComment(
    event: GitLabWebhookEvent,
    message: string,
    runContext: EventRunContext
  ): Promise<void>
```

```typescript
  private async createProgressComment(
    event: GitLabWebhookEvent,
    message: string,
    runContext: EventRunContext
  ): Promise<number | null>
```

```typescript
  private async updateProgressComment(
    event: GitLabWebhookEvent,
    runContext: EventRunContext,
    message: string,
    isComplete?: boolean,
    isError?: boolean
  ): Promise<void>
```

Inside `updateProgressComment`, use context fields:

```typescript
    if (!runContext.currentCommentId) {
      return;
    }
```

```typescript
      const isDuplicate = runContext.progressMessages.some(existingMsg => {
        return sanitizeProgressMessage(existingMsg.message) === sanitizeProgressMessage(message);
      });
```

```typescript
        runContext.progressMessages.push({ timestamp, status, message });
```

```typescript
      const recentMessages = runContext.progressMessages.slice(-10);
```

```typescript
      await this.updateComment(event, runContext.currentCommentId, commentBody);
```

Remove:

```typescript
  private progressMessages: ProgressEntry[] = [];
```

- [ ] **Step 4: Update every call site**

Use this search until no old signatures remain:

```bash
rg -n "this\\.currentCommentId|this\\.currentDiscussionId|this\\.progressMessages|postComment\\(event,|updateProgressComment\\(event,|createProgressComment\\(" src/services/eventProcessor.ts
```

Expected remaining matches:

```text
No matches for this.currentCommentId, this.currentDiscussionId, or this.progressMessages.
```

For `postComment(event, ...)`, `updateProgressComment(event, ...)`, and `createProgressComment(...)`, every call should pass `runContext`.

- [ ] **Step 5: Verify EventProcessor tests pass**

Run:

```bash
npm test -- src/__tests__/runtimeConfigExecution.test.ts --runInBand
```

Expected:

```text
PASS src/__tests__/runtimeConfigExecution.test.ts
```

- [ ] **Step 6: Commit Task 2**

```bash
git add src/services/eventProcessor.ts src/__tests__/runtimeConfigExecution.test.ts
git commit -m "fix: isolate webhook event processor run state"
```

---

### Task 3: Integrate Queue Into WebhookServer

**Files:**
- Modify: `src/server/webhookServer.ts`
- Create: `src/__tests__/webhookServerQueue.test.ts`

**Interfaces:**
- Consumes: `RunQueue`, `getGitLabEventResourceKey`
- Produces: webhook route that enqueues work and responds immediately with `{ message, queued, runId, resourceKey }`

- [ ] **Step 1: Write the failing webhook queue tests**

Create `src/__tests__/webhookServerQueue.test.ts`:

```typescript
import request from 'supertest';
import { WebhookServer } from '../server/webhookServer';
import { GitLabWebhookEvent } from '../types/gitlab';

jest.mock('../utils/webhook', () => {
  const actual = jest.requireActual('../utils/webhook');
  return {
    ...actual,
    verifyGitLabSignature: jest.fn(() => true),
  };
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMergeRequestEvent(iid: number): GitLabWebhookEvent {
  return {
    object_kind: 'merge_request',
    user: { id: 1, name: 'Test User', username: 'tester', email: 'tester@example.com' },
    project: {
      id: 10,
      name: 'demo',
      web_url: 'https://gitlab.example.com/group/demo',
      default_branch: 'main',
      http_url_to_repo: 'https://gitlab.example.com/group/demo.git',
    },
    object_attributes: {},
    merge_request: {
      id: iid,
      iid,
      title: `MR ${iid}`,
      description: '@claude test',
      state: 'opened',
      web_url: `https://gitlab.example.com/group/demo/-/merge_requests/${iid}`,
      source_branch: `feature-${iid}`,
      target_branch: 'main',
      author: { id: 1, name: 'Test User', username: 'tester', email: 'tester@example.com' },
    },
  };
}

describe('WebhookServer task queue', () => {
  it('responds after enqueueing without waiting for event processing to finish', async () => {
    const blocked = deferred();
    const eventProcessor = {
      processEvent: jest.fn(async () => {
        await blocked.promise;
      }),
    };
    const server = new WebhookServer({ eventProcessor: eventProcessor as any, taskConcurrency: 1 });

    const response = await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(1));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: 'Webhook received',
      queued: true,
      resourceKey: 'project:10:merge_request:1',
    });
    expect(response.body.runId).toEqual(expect.any(String));
    expect(eventProcessor.processEvent).toHaveBeenCalledTimes(1);

    blocked.resolve();
  });

  it('serializes webhook processing for the same merge request', async () => {
    const first = deferred();
    const events: string[] = [];
    const eventProcessor = {
      processEvent: jest.fn(async event => {
        events.push(`start:${event.merge_request.iid}`);
        if (event.merge_request.iid === 1 && events.length === 1) {
          await first.promise;
        }
        events.push(`end:${event.merge_request.iid}`);
      }),
    };
    const server = new WebhookServer({ eventProcessor: eventProcessor as any, taskConcurrency: 2 });

    await request(server.getApp()).post('/webhook').set('x-gitlab-token', 'test-secret').send(createMergeRequestEvent(1));
    await request(server.getApp()).post('/webhook').set('x-gitlab-token', 'test-secret').send(createMergeRequestEvent(1));

    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual(['start:1']);

    first.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual(['start:1', 'end:1', 'start:1', 'end:1']);
  });

  it('allows different merge requests to process concurrently', async () => {
    const first = deferred();
    const events: string[] = [];
    const eventProcessor = {
      processEvent: jest.fn(async event => {
        events.push(`start:${event.merge_request.iid}`);
        if (event.merge_request.iid === 1) {
          await first.promise;
        }
        events.push(`end:${event.merge_request.iid}`);
      }),
    };
    const server = new WebhookServer({ eventProcessor: eventProcessor as any, taskConcurrency: 2 });

    await request(server.getApp()).post('/webhook').set('x-gitlab-token', 'test-secret').send(createMergeRequestEvent(1));
    await request(server.getApp()).post('/webhook').set('x-gitlab-token', 'test-secret').send(createMergeRequestEvent(2));

    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual(['start:1', 'start:2', 'end:2']);

    first.resolve();
  });
});
```

- [ ] **Step 2: Run the failing webhook queue tests**

Run:

```bash
npm test -- src/__tests__/webhookServerQueue.test.ts --runInBand
```

Expected:

```text
FAIL src/__tests__/webhookServerQueue.test.ts
Object literal may only specify known properties, and 'eventProcessor' does not exist
```

- [ ] **Step 3: Add queue injection and enqueue behavior**

Modify `src/server/webhookServer.ts` imports:

```typescript
import { EventProcessor } from '../services/eventProcessor';
import { RunQueue, getGitLabEventResourceKey } from '../services/runQueue';
```

Update `WebhookServerOptions`:

```typescript
  eventProcessor?: Pick<EventProcessor, 'processEvent'>;
  taskConcurrency?: number;
```

Update class fields:

```typescript
  private eventProcessor: Pick<EventProcessor, 'processEvent'>;
  private runQueue: RunQueue;
```

Update constructor:

```typescript
    this.eventProcessor = options.eventProcessor || new EventProcessor();
    this.runQueue = new RunQueue({
      globalConcurrency: options.taskConcurrency ?? this.resolveTaskConcurrency(),
    });
```

Add a private helper:

```typescript
  private resolveTaskConcurrency(): number {
    const parsed = Number.parseInt(this.env.WEBHOOK_TASK_CONCURRENCY || '2', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  }
```

Replace direct processing in `handleWebhook`:

```typescript
      const resourceKey = getGitLabEventResourceKey(event);
      const queuedRun = this.runQueue.enqueue({
        resourceKey,
        run: () => this.eventProcessor.processEvent(event),
      });

      queuedRun.promise.catch(error => {
        logger.error('Error processing GitLab event:', {
          runId: queuedRun.id,
          resourceKey,
          error,
        });
      });

      res.status(200).json({
        message: 'Webhook received',
        queued: true,
        runId: queuedRun.id,
        resourceKey,
      });
```

- [ ] **Step 4: Verify webhook queue tests pass**

Run:

```bash
npm test -- src/__tests__/webhookServerQueue.test.ts --runInBand
```

Expected:

```text
PASS src/__tests__/webhookServerQueue.test.ts
```

- [ ] **Step 5: Commit Task 3**

```bash
git add src/server/webhookServer.ts src/__tests__/webhookServerQueue.test.ts
git commit -m "feat: queue webhook event processing"
```

---

### Task 4: Final Verification

**Files:**
- No new files.
- Verify all files changed in Tasks 1-3.

**Interfaces:**
- Consumes: completed queue and run-context implementation.
- Produces: verified build and test result.

- [ ] **Step 1: Run focused tests**

```bash
npm test -- src/__tests__/runQueue.test.ts src/__tests__/webhookServerQueue.test.ts src/__tests__/runtimeConfigExecution.test.ts --runInBand
```

Expected:

```text
PASS src/__tests__/runQueue.test.ts
PASS src/__tests__/webhookServerQueue.test.ts
PASS src/__tests__/runtimeConfigExecution.test.ts
```

- [ ] **Step 2: Run full test suite**

```bash
npm test -- --runInBand
```

Expected:

```text
Test Suites: all passed
```

- [ ] **Step 3: Run type check**

```bash
npm run type-check
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 4: Inspect git diff**

```bash
git status --short
git diff --stat
```

Expected:

```text
Only task concurrency files are modified.
```

- [ ] **Step 5: Commit final fixes if needed**

If Task 4 required any follow-up changes:

```bash
git add src docs
git commit -m "test: verify webhook task concurrency"
```

If no follow-up changes were needed, do not create an empty commit.

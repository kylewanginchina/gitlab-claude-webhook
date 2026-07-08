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
  it.each([0, -1, Number.NaN])(
    'falls back to concurrency 2 for invalid globalConcurrency=%s',
    async globalConcurrency => {
      const queue = new RunQueue({ globalConcurrency });
      const firstRun = deferred();
      const secondRun = deferred();
      const events: string[] = [];

      const runA = queue.enqueue({
        resourceKey: 'project:10:mr:1',
        run: async () => {
          events.push('a:start');
          await firstRun.promise;
          events.push('a:end');
        },
      });

      const runB = queue.enqueue({
        resourceKey: 'project:10:mr:2',
        run: async () => {
          events.push('b:start');
          await secondRun.promise;
          events.push('b:end');
        },
      });

      const runC = queue.enqueue({
        resourceKey: 'project:10:mr:3',
        run: async () => {
          events.push('c:start');
        },
      });

      await flushPromises();

      expect(events).toEqual(['a:start', 'b:start']);
      expect(queue.getStats()).toMatchObject({ running: 2, queued: 1 });

      firstRun.resolve();
      secondRun.resolve();
      await Promise.all([runA.promise, runB.promise, runC.promise]);

      expect(events).toEqual(['a:start', 'b:start', 'a:end', 'b:end', 'c:start']);
      expect(queue.getStats()).toMatchObject({ running: 0, queued: 0 });
    }
  );

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

  it('reports whether a run started immediately and where queued runs are waiting', async () => {
    const queue = new RunQueue({ globalConcurrency: 2 });
    const firstSameResource = deferred();
    const secondResource = deferred();

    const runA1 = queue.enqueue({
      resourceKey: 'project:10:mr:1',
      run: async () => {
        await firstSameResource.promise;
      },
    });

    const runB1 = queue.enqueue({
      resourceKey: 'project:10:mr:2',
      run: async () => {
        await secondResource.promise;
      },
    });

    const runA2 = queue.enqueue({
      resourceKey: 'project:10:mr:1',
      run: async () => undefined,
    });

    expect(runA1).toMatchObject({
      startedImmediately: true,
      queuePosition: 0,
      resourceQueuePosition: 0,
      globalConcurrency: 2,
    });
    expect(runB1).toMatchObject({
      startedImmediately: true,
      queuePosition: 0,
      resourceQueuePosition: 0,
      globalConcurrency: 2,
    });
    expect(runA2).toMatchObject({
      startedImmediately: false,
      queuePosition: 1,
      resourceQueuePosition: 1,
      queuedAhead: 0,
      running: 2,
      globalConcurrency: 2,
    });

    firstSameResource.resolve();
    secondResource.resolve();
    await Promise.all([runA1.promise, runB1.promise, runA2.promise]);
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

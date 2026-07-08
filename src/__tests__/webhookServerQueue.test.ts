import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { GitLabWebhookEvent } from '../types/gitlab';
import { RuntimeConfigService } from '../admin/runtimeConfigService';

jest.mock('../services/eventProcessor', () => ({
  EventProcessor: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockResolvedValue(undefined),
    postQueueStatus: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../utils/webhook', () => {
  const actual = jest.requireActual('../utils/webhook');
  return {
    ...actual,
    verifyGitLabSignature: jest.fn(() => true),
  };
});

import { WebhookServer } from '../server/webhookServer';
import { verifyGitLabSignature } from '../utils/webhook';

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

function createMergeRequestNoteEvent(iid: number, note: string): GitLabWebhookEvent {
  const event = createMergeRequestEvent(iid);
  return {
    ...event,
    object_kind: 'note',
    object_attributes: {
      id: 555,
      note,
    },
  };
}

function createServerWithEnv(
  eventProcessor: {
    processEvent: jest.Mock<Promise<void>, [GitLabWebhookEvent]>;
    postQueueStatus?: jest.Mock<Promise<void>, any>;
  },
  env: NodeJS.ProcessEnv
): WebhookServer {
  return new WebhookServer({ eventProcessor: eventProcessor as any, env });
}

describe('WebhookServer task queue', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

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

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(1));
    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(1));

    await flushPromises();

    expect(events).toEqual(['start:1']);

    first.resolve();
    await flushPromises();
    await flushPromises();

    expect(events).toEqual(['start:1', 'end:1', 'start:1', 'end:1']);
  });

  it('posts queue status for an AI request waiting behind the same merge request', async () => {
    const first = deferred();
    const eventProcessor = {
      processEvent: jest.fn(async event => {
        if (event.merge_request.iid === 1) {
          await first.promise;
        }
      }),
      postQueueStatus: jest.fn().mockResolvedValue(undefined),
    };
    const server = new WebhookServer({ eventProcessor: eventProcessor as any, taskConcurrency: 2 });

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestNoteEvent(1, '@claude review this MR'));

    const response = await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestNoteEvent(1, '@codex review this MR'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: 'Webhook received',
      queued: true,
      startedImmediately: false,
      queuePosition: 1,
      resourceQueuePosition: 1,
      running: 1,
      globalConcurrency: 2,
      resourceKey: 'project:10:merge_request:1',
    });
    expect(eventProcessor.postQueueStatus).toHaveBeenCalledTimes(1);
    expect(eventProcessor.postQueueStatus).toHaveBeenCalledWith(
      expect.objectContaining({ object_kind: 'note' }),
      expect.objectContaining({
        queuePosition: 1,
        resourceQueuePosition: 1,
        resourceKey: 'project:10:merge_request:1',
        globalConcurrency: 2,
      })
    );

    first.resolve();
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

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(1));
    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(2));

    await flushPromises();

    expect(events).toEqual(['start:1', 'start:2', 'end:2']);

    first.resolve();
  });

  it('does not post queue status when a different merge request starts immediately', async () => {
    const first = deferred();
    const eventProcessor = {
      processEvent: jest.fn(async event => {
        if (event.merge_request.iid === 1) {
          await first.promise;
        }
      }),
      postQueueStatus: jest.fn().mockResolvedValue(undefined),
    };
    const server = new WebhookServer({ eventProcessor: eventProcessor as any, taskConcurrency: 2 });

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestNoteEvent(1, '@claude review this MR'));
    const response = await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestNoteEvent(2, '@codex review this other MR'));

    expect(response.body).toMatchObject({
      queued: true,
      startedImmediately: true,
      queuePosition: 0,
      resourceQueuePosition: 0,
    });
    expect(eventProcessor.postQueueStatus).not.toHaveBeenCalled();

    first.resolve();
  });

  it('defaults missing WEBHOOK_TASK_CONCURRENCY to 2 so different merge requests can run concurrently', async () => {
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
    const server = createServerWithEnv(eventProcessor as any, {});

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(1));
    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(2));

    await flushPromises();

    expect(events).toEqual(['start:1', 'start:2', 'end:2']);

    first.resolve();
  });

  it.each(['2abc', '2.5', '3abc', '3.5', '0', '-1', 'NaN', 'Infinity', ''])(
    'falls back to concurrency 2 for invalid WEBHOOK_TASK_CONCURRENCY=%p',
    invalidValue => {
      const server = createServerWithEnv(
        { processEvent: jest.fn().mockResolvedValue(undefined) } as any,
        { WEBHOOK_TASK_CONCURRENCY: invalidValue }
      );

      expect((server as any).resolveTaskConcurrency()).toBe(2);
    }
  );

  it('uses a valid integer WEBHOOK_TASK_CONCURRENCY=1 to serialize globally', async () => {
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
    const server = createServerWithEnv(eventProcessor as any, {
      WEBHOOK_TASK_CONCURRENCY: '1',
    });

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(1));
    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(2));

    await flushPromises();

    expect(events).toEqual(['start:1']);

    first.resolve();
    await flushPromises();
    await flushPromises();

    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('hot-applies webhook task concurrency updates from the admin config API', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-runtime-concurrency-'));
    const runtimeConfigService = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'test-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
        WEBHOOK_TASK_CONCURRENCY: '1',
      } as NodeJS.ProcessEnv,
    });
    await runtimeConfigService.initialize();

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
    const server = new WebhookServer({
      eventProcessor: eventProcessor as any,
      runtimeConfigService,
      env: { ADMIN_TOKEN: 'admin-secret' },
    });

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(1));
    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(createMergeRequestEvent(2));

    await flushPromises();
    expect(events).toEqual(['start:1']);

    await request(server.getApp())
      .put('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .send({ webhook: { taskConcurrency: 2 } })
      .expect(200);

    await flushPromises();
    expect(events).toEqual(['start:1', 'start:2', 'end:2']);

    first.resolve();
  });

  it('does not enqueue webhook processing when the signature is invalid', async () => {
    const eventProcessor = {
      processEvent: jest.fn().mockResolvedValue(undefined),
    };
    const server = new WebhookServer({ eventProcessor: eventProcessor as any });

    jest.mocked(verifyGitLabSignature).mockReturnValue(false);

    await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'bad-secret')
      .send(createMergeRequestEvent(1))
      .expect(401, { error: 'Invalid signature' });

    expect(verifyGitLabSignature).toHaveBeenCalled();
    expect(eventProcessor.processEvent).not.toHaveBeenCalled();
  });

  it('ignores service status note webhooks before enqueueing work', async () => {
    const eventProcessor = {
      processEvent: jest.fn().mockResolvedValue(undefined),
      postQueueStatus: jest.fn().mockResolvedValue(undefined),
    };
    const server = new WebhookServer({ eventProcessor: eventProcessor as any });
    jest.mocked(verifyGitLabSignature).mockReturnValue(true);

    const response = await request(server.getApp())
      .post('/webhook')
      .set('x-gitlab-token', 'test-secret')
      .send(
        createMergeRequestNoteEvent(
          1,
          [
            '### AI Agent Queue Status',
            '',
            '当前请求已进入后台队列，前序任务完成后会自动开始处理。',
          ].join('\n')
        )
      );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'Webhook ignored',
      ignored: true,
      reason: 'service_status_note',
    });
    expect(eventProcessor.processEvent).not.toHaveBeenCalled();
    expect(eventProcessor.postQueueStatus).not.toHaveBeenCalled();
  });
});

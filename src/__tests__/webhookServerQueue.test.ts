import request from 'supertest';
import { GitLabWebhookEvent } from '../types/gitlab';

jest.mock('../services/eventProcessor', () => ({
  EventProcessor: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockResolvedValue(undefined),
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

function createServerWithEnv(
  eventProcessor: { processEvent: jest.Mock<Promise<void>, [GitLabWebhookEvent]> },
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
});

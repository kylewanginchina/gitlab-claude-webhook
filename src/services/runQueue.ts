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

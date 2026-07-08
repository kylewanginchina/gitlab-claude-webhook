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
  startedImmediately: boolean;
  queuePosition: number;
  resourceQueuePosition: number;
  queuedAhead: number;
  pendingCount: number;
  running: number;
  activeResourceKeys: string[];
  globalConcurrency: number;
}

interface PendingRun<T> {
  id: string;
  resourceKey: string;
  promise: Promise<T>;
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
  private globalConcurrency: number;
  private readonly pendingRuns: Array<PendingRun<unknown>> = [];
  private readonly activeResourceKeys = new Set<string>();
  private runningCount = 0;

  constructor(options: RunQueueOptions = {}) {
    const globalConcurrency = options.globalConcurrency;

    if (typeof globalConcurrency !== 'number' || !Number.isFinite(globalConcurrency) || globalConcurrency <= 0) {
      this.globalConcurrency = 2;
      return;
    }

    this.globalConcurrency = Math.max(1, Math.floor(globalConcurrency));
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

    const pendingIndex = this.pendingRuns.findIndex(run => run.id === id);
    const startedImmediately = pendingIndex < 0;
    const queuePosition = startedImmediately ? 0 : pendingIndex + 1;
    const resourceQueuePosition = startedImmediately
      ? 0
      : this.pendingRuns
          .slice(0, pendingIndex + 1)
          .filter(run => run.resourceKey === job.resourceKey).length;
    const stats = this.getStats();

    return {
      id,
      resourceKey: job.resourceKey,
      promise,
      startedImmediately,
      queuePosition,
      resourceQueuePosition,
      queuedAhead: Math.max(0, queuePosition - 1),
      pendingCount: stats.queued,
      running: stats.running,
      activeResourceKeys: stats.activeResourceKeys,
      globalConcurrency: stats.globalConcurrency,
    };
  }

  public getStats(): {
    queued: number;
    running: number;
    activeResourceKeys: string[];
    globalConcurrency: number;
  } {
    return {
      queued: this.pendingRuns.length,
      running: this.runningCount,
      activeResourceKeys: [...this.activeResourceKeys],
      globalConcurrency: this.globalConcurrency,
    };
  }

  public setGlobalConcurrency(globalConcurrency: number): void {
    if (
      typeof globalConcurrency !== 'number' ||
      !Number.isFinite(globalConcurrency) ||
      globalConcurrency <= 0
    ) {
      this.globalConcurrency = 2;
    } else {
      this.globalConcurrency = Math.max(1, Math.floor(globalConcurrency));
    }

    this.drain();
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

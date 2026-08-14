import express, { Request, Response } from 'express';
import path from 'path';
import { createAdminRouter } from '../admin/adminRoutes';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';
import { RuntimeConfigService } from '../admin/runtimeConfigService';
import { reviewCustomizationService as defaultReviewCustomizationService } from '../utils/reviewCustomization';
import { runtimeConfigService as defaultRuntimeConfigService } from '../utils/runtimeConfig';
import { extractAIInstructions, verifyGitLabSignature } from '../utils/webhook';
import { isServiceStatusCommentBody } from '../utils/gitlabMarkdown';
import logger from '../utils/logger';
import { GitLabWebhookEvent } from '../types/gitlab';
import { EventProcessor, QueueStatusDetails } from '../services/eventProcessor';
import { RunQueue, getGitLabEventResourceKey } from '../services/runQueue';

interface WebhookEventProcessor {
  processEvent(event: GitLabWebhookEvent): Promise<void>;
  postQueueStatus?(event: GitLabWebhookEvent, details: QueueStatusDetails): Promise<void>;
}

export interface WebhookServerOptions {
  runtimeConfigService?: RuntimeConfigService;
  reviewCustomizationService?: ReviewCustomizationService;
  eventProcessor?: WebhookEventProcessor;
  taskConcurrency?: number;
  env?: NodeJS.ProcessEnv;
  adminStaticPath?: string;
}

export class WebhookServer {
  private app: express.Application;
  private eventProcessor: WebhookEventProcessor;
  private runQueue: RunQueue;
  private runtimeConfigService: RuntimeConfigService;
  private reviewCustomizationService: ReviewCustomizationService;
  private env: NodeJS.ProcessEnv;
  private adminStaticPath: string;

  constructor(options: WebhookServerOptions = {}) {
    this.app = express();
    this.env = options.env || process.env;
    this.eventProcessor = options.eventProcessor || new EventProcessor();
    this.runtimeConfigService = options.runtimeConfigService || defaultRuntimeConfigService;
    this.reviewCustomizationService =
      options.reviewCustomizationService || defaultReviewCustomizationService;
    this.runQueue = new RunQueue({
      globalConcurrency: options.taskConcurrency ?? this.resolveTaskConcurrency(),
    });
    this.adminStaticPath =
      options.adminStaticPath || path.resolve(process.cwd(), 'dist/public/admin');
    this.setupMiddleware();
    this.setupRoutes();
  }

  public getApp(): express.Application {
    return this.app;
  }

  private resolveTaskConcurrency(): number {
    if (this.runtimeConfigService.isLoaded()) {
      return this.runtimeConfigService.getConfig().webhook.taskConcurrency;
    }

    const raw = this.env.WEBHOOK_TASK_CONCURRENCY;
    if (!raw || !/^[1-9]\d*$/.test(raw)) {
      return 2;
    }

    return Number(raw);
  }

  private setupMiddleware(): void {
    // Use raw middleware to preserve original request body for signature verification
    this.app.use('/webhook', express.raw({ type: 'application/json', limit: '10mb' }));
    this.app.use(express.json({ limit: '10mb' }));
  }

  private setupRoutes(): void {
    this.app.post('/webhook', this.handleWebhook.bind(this));

    this.app.use(
      '/api/admin',
      createAdminRouter({
        runtimeConfigService: this.runtimeConfigService,
        reviewCustomizationService: this.reviewCustomizationService,
        env: this.env,
        onRuntimeConfigUpdated: config => {
          this.runQueue.setGlobalConcurrency(config.webhook.taskConcurrency);
        },
      })
    );

    this.app.get('/admin', (_req: Request, res: Response) => {
      res.sendFile(path.join(this.adminStaticPath, 'index.html'));
    });
    this.app.use('/admin', express.static(this.adminStaticPath, { redirect: false }));
    this.app.get('/admin/*', (_req: Request, res: Response) => {
      res.sendFile(path.join(this.adminStaticPath, 'index.html'));
    });

    this.app.get('/health', (req: Request, res: Response) => {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
      };
      res.json(health);
    });

    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        service: 'GitLab Claude Webhook',
        version: '1.0.0',
        status: 'running',
      });
    });
  }

  private async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      const signature = req.headers['x-gitlab-token'] as string;
      const rawBody =
        req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

      if (!verifyGitLabSignature(rawBody, signature)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      // Parse JSON if we have raw body
      const event: GitLabWebhookEvent = req.body instanceof Buffer ? JSON.parse(rawBody) : req.body;

      logger.info(`Received GitLab webhook: ${event.object_kind}`, {
        eventType: event.object_kind,
        projectId: event.project?.id,
        userId: event.user?.id,
      });

      if (this.isServiceStatusNoteWebhook(event)) {
        logger.info('Ignoring service status note webhook before queueing', {
          eventType: event.object_kind,
          projectId: event.project?.id,
          noteId: (event.object_attributes as { id?: number }).id,
        });
        res.status(200).json({
          message: 'Webhook ignored',
          ignored: true,
          reason: 'service_status_note',
        });
        return;
      }

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

      if (!queuedRun.startedImmediately && this.hasAIInstruction(event)) {
        this.eventProcessor
          .postQueueStatus?.(event, {
            runId: queuedRun.id,
            resourceKey: queuedRun.resourceKey,
            queuePosition: queuedRun.queuePosition,
            resourceQueuePosition: queuedRun.resourceQueuePosition,
            queuedAhead: queuedRun.queuedAhead,
            queued: queuedRun.pendingCount,
            running: queuedRun.running,
            globalConcurrency: queuedRun.globalConcurrency,
          })
          .catch(error => {
            logger.warn('Failed to post queue status comment:', {
              runId: queuedRun.id,
              resourceKey,
              error,
            });
          });
      }

      res.status(200).json({
        message: 'Webhook received',
        queued: true,
        runId: queuedRun.id,
        resourceKey,
        startedImmediately: queuedRun.startedImmediately,
        queuePosition: queuedRun.queuePosition,
        resourceQueuePosition: queuedRun.resourceQueuePosition,
        queuedAhead: queuedRun.queuedAhead,
        running: queuedRun.running,
        globalConcurrency: queuedRun.globalConcurrency,
      });
    } catch (error) {
      logger.error('Error handling webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  private isServiceStatusNoteWebhook(event: GitLabWebhookEvent): boolean {
    if (event.object_kind !== 'note') {
      return false;
    }

    const note = (event.object_attributes as { note?: unknown }).note;
    return typeof note === 'string' && isServiceStatusCommentBody(note);
  }

  private hasAIInstruction(event: GitLabWebhookEvent): boolean {
    return Boolean(extractAIInstructions(this.getInstructionText(event)));
  }

  private getInstructionText(event: GitLabWebhookEvent): string {
    switch (event.object_kind) {
      case 'issue':
        return event.issue?.description || '';
      case 'merge_request':
        return event.merge_request?.description || '';
      case 'note':
        return typeof (event.object_attributes as { note?: unknown }).note === 'string'
          ? ((event.object_attributes as { note?: string }).note ?? '')
          : '';
      default:
        return '';
    }
  }

  public start(): void {
    try {
      if (!this.runtimeConfigService.isLoaded()) {
        throw new Error('Runtime config service must be initialized before starting the server');
      }

      const port = this.runtimeConfigService.getConfig().webhook.port;
      this.app.listen(port, () => {
        logger.info(`GitLab Claude Webhook server started on port ${port}`);
      });
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

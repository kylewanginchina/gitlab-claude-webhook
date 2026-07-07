import express, { Request, Response } from 'express';
import path from 'path';
import { createAdminRouter } from '../admin/adminRoutes';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';
import { RuntimeConfigService } from '../admin/runtimeConfigService';
import { reviewCustomizationService as defaultReviewCustomizationService } from '../utils/reviewCustomization';
import { runtimeConfigService as defaultRuntimeConfigService } from '../utils/runtimeConfig';
import { verifyGitLabSignature } from '../utils/webhook';
import logger from '../utils/logger';
import { GitLabWebhookEvent } from '../types/gitlab';
import { EventProcessor } from '../services/eventProcessor';
import { RunQueue, getGitLabEventResourceKey } from '../services/runQueue';

export interface WebhookServerOptions {
  runtimeConfigService?: RuntimeConfigService;
  reviewCustomizationService?: ReviewCustomizationService;
  eventProcessor?: Pick<EventProcessor, 'processEvent'>;
  taskConcurrency?: number;
  env?: NodeJS.ProcessEnv;
  adminStaticPath?: string;
}

export class WebhookServer {
  private app: express.Application;
  private eventProcessor: Pick<EventProcessor, 'processEvent'>;
  private runQueue: RunQueue;
  private runtimeConfigService: RuntimeConfigService;
  private reviewCustomizationService: ReviewCustomizationService;
  private env: NodeJS.ProcessEnv;
  private adminStaticPath: string;

  constructor(options: WebhookServerOptions = {}) {
    this.app = express();
    this.env = options.env || process.env;
    this.eventProcessor = options.eventProcessor || new EventProcessor();
    this.runQueue = new RunQueue({
      globalConcurrency: options.taskConcurrency ?? this.resolveTaskConcurrency(),
    });
    this.runtimeConfigService = options.runtimeConfigService || defaultRuntimeConfigService;
    this.reviewCustomizationService =
      options.reviewCustomizationService || defaultReviewCustomizationService;
    this.adminStaticPath =
      options.adminStaticPath || path.resolve(process.cwd(), 'dist/public/admin');
    this.setupMiddleware();
    this.setupRoutes();
  }

  public getApp(): express.Application {
    return this.app;
  }

  private resolveTaskConcurrency(): number {
    const parsed = Number.parseInt(this.env.WEBHOOK_TASK_CONCURRENCY || '2', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
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
    } catch (error) {
      logger.error('Error handling webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
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

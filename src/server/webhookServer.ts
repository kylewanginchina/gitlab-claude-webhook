import express, { Request, Response } from 'express';
import { config, validateConfig } from '../utils/config';
import { verifyGitLabSignature } from '../utils/webhook';
import logger from '../utils/logger';
import { GitLabWebhookEvent } from '../types/gitlab';
import { EventProcessor } from '../services/eventProcessor';

export class WebhookServer {
  private app: express.Application;
  private eventProcessor: EventProcessor;

  constructor() {
    this.app = express();
    this.eventProcessor = new EventProcessor();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Use raw middleware to preserve original request body for signature verification
    this.app.use('/webhook', express.raw({ type: 'application/json', limit: '10mb' }));
    this.app.use(express.json({ limit: '10mb' }));
  }

  private setupRoutes(): void {
    this.app.post('/webhook', this.handleWebhook.bind(this));

    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        service: 'GitLab Claude Webhook',
        version: '1.0.0',
        status: 'running'
      });
    });
  }

  private async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      const signature = req.headers['x-gitlab-token'] as string;
      const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

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

      // Process the event asynchronously
      this.eventProcessor.processEvent(event).catch((error) => {
        logger.error('Error processing GitLab event:', error);
      });

      res.status(200).json({ message: 'Webhook received' });
    } catch (error) {
      logger.error('Error handling webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  public start(): void {
    try {
      validateConfig();

      this.app.listen(config.webhook.port, () => {
        logger.info(`GitLab Claude Webhook server started on port ${config.webhook.port}`);
      });
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}
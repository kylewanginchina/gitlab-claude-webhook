import { WebhookServer } from './server/webhookServer';
import logger from './utils/logger';

async function main(): Promise<void> {
  try {
    logger.info('Starting GitLab Claude Webhook Service...');

    const server = new WebhookServer();
    server.start();

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      process.exit(0);
    });

    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start service:', error);
    process.exit(1);
  }
}

main();
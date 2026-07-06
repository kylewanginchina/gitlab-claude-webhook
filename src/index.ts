import './env';
import { WebhookServer } from './server/webhookServer';
import logger from './utils/logger';
import { debugConfig, validateRequiredConfig } from './utils/configDebug';
import { generateCodexConfig } from './utils/codexConfig';
import { runtimeConfigService } from './utils/runtimeConfig';
import { reviewCustomizationService } from './utils/reviewCustomization';

async function main(): Promise<void> {
  try {
    await runtimeConfigService.initialize();
    await reviewCustomizationService.initialize();

    // Debug configuration loading in development
    if (process.env.NODE_ENV !== 'production') {
      debugConfig();
    }

    // Validate required configuration
    const { isValid, missing } = validateRequiredConfig();
    if (!isValid) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Generate Codex config.toml from environment variables
    generateCodexConfig();

    logger.info('Starting GitLab Claude Webhook Service...');

    const server = new WebhookServer({ runtimeConfigService, reviewCustomizationService });
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

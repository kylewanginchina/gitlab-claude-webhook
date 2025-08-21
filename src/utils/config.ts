import dotenv from 'dotenv';
import { Config } from '../types/common';

dotenv.config();

export const config: Config = {
  anthropic: {
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
  },
  gitlab: {
    baseUrl: process.env.GITLAB_BASE_URL || 'https://gitlab.com',
    token: process.env.GITLAB_TOKEN || '',
  },
  webhook: {
    secret: process.env.WEBHOOK_SECRET || '',
    port: parseInt(process.env.PORT || '3000'),
  },
  workDir: process.env.WORK_DIR || '/tmp/gitlab-claude-work',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export function validateConfig(): void {
  const required = ['anthropic.authToken', 'gitlab.token', 'webhook.secret'];

  for (const path of required) {
    const keys = path.split('.');
    let value = config as unknown as Record<string, unknown>;

    for (const key of keys) {
      value = value?.[key] as Record<string, unknown>;
    }

    if (!value) {
      throw new Error(`Missing required environment variable for ${path}`);
    }
  }
}

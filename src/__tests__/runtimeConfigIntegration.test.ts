import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { RuntimeConfigService } from '../admin/runtimeConfigService';

jest.mock('../services/eventProcessor', () => ({
  EventProcessor: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { WebhookServer } from '../server/webhookServer';

async function runtimeService(): Promise<RuntimeConfigService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-runtime-'));
  const service = new RuntimeConfigService({
    dataDir: dir,
    env: {
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    } as NodeJS.ProcessEnv,
  });
  await service.initialize();
  return service;
}

describe('WebhookServer admin integration', () => {
  it('keeps /health public and protects /api/admin/status', async () => {
    const server = new WebhookServer({
      runtimeConfigService: await runtimeService(),
      env: { ADMIN_TOKEN: 'admin-secret' },
    });

    await request(server.getApp()).get('/health').expect(200);
    await request(server.getApp()).get('/api/admin/status').expect(401);
    await request(server.getApp())
      .get('/api/admin/status')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);
  });
});

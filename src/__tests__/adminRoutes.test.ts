import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRoutes';
import { RuntimeConfigService } from '../admin/runtimeConfigService';

async function buildApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-routes-'));
  const runtimeConfigService = new RuntimeConfigService({
    dataDir: dir,
    env: {
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    } as NodeJS.ProcessEnv,
  });
  await runtimeConfigService.initialize();

  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin',
    createAdminRouter({
      runtimeConfigService,
      env: { ADMIN_TOKEN: 'admin-secret' },
    })
  );
  return app;
}

describe('admin routes', () => {
  it('returns status with valid admin key', async () => {
    const app = await buildApp();

    const response = await request(app)
      .get('/api/admin/status')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.configLoaded).toBe(true);
    expect(typeof response.body.uptime).toBe('number');
  });

  it('returns public config without raw secrets', async () => {
    const app = await buildApp();

    const response = await request(app)
      .get('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(response.body.gitlab.token).toEqual({
      configured: true,
      masked: '********cret',
    });
    expect(JSON.stringify(response.body)).not.toContain('glpat-secret');
  });

  it('updates runtime config', async () => {
    const app = await buildApp();

    const response = await request(app)
      .put('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .send({
        claude: {
          defaultModel: 'claude-opus-test',
          defaultTimeoutMinutes: 42,
        },
      })
      .expect(200);

    expect(response.body.requiresRestart).toEqual([]);
    expect(response.body.config.claude.defaultModel).toBe('claude-opus-test');
    expect(response.body.config.claude.defaultTimeoutMinutes).toBe(42);
  });

  it('reloads runtime config', async () => {
    const app = await buildApp();

    await request(app)
      .post('/api/admin/config/reload')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200, { ok: true });
  });
});

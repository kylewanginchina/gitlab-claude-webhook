import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ConfigUpdateResult, PublicRuntimeConfig } from '../admin/adminTypes';
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

function buildAppWithLeakyUpdateResult() {
  const publicConfig: PublicRuntimeConfig = {
    claude: {
      baseUrl: 'https://api.anthropic.com',
      authToken: { configured: true, masked: '********cret' },
      defaultModel: 'claude-sonnet-4-20250514',
      defaultTimeoutMinutes: 30,
    },
    codex: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: { configured: false, masked: '' },
      defaultModel: 'gpt-5.1-codex-max',
      reasoningEffort: 'high',
      defaultTimeoutMinutes: 30,
    },
    gitlab: {
      baseUrl: 'https://gitlab.com',
      token: { configured: true, masked: '********cret' },
    },
    webhook: {
      secret: { configured: true, masked: '********cret' },
      port: 3000,
    },
    ai: {
      defaultProvider: 'claude',
    },
    review: {
      enabled: true,
      defaultProvider: 'claude-multipass',
      minConfidence: 80,
      maxCandidateFindings: 12,
      maxFinalFindings: 8,
      passConcurrency: 4,
      scoringConcurrency: 4,
      skipDraft: true,
      skipExistingSha: true,
      allowedCommands: ['/code-review'],
    },
    workDir: '/tmp/gitlab-claude-work',
    logLevel: 'info',
  };

  const leakyUpdateResult: ConfigUpdateResult = {
    config: {
      ...publicConfig,
      gitlab: {
        ...publicConfig.gitlab,
        token: { configured: true, masked: '********cret', raw: 'glpat-secret' } as never,
      },
    },
    requiresRestart: ['webhook.port'],
  };

  const runtimeConfigService = {
    updateConfig: jest.fn(async () => leakyUpdateResult),
    getPublicConfig: jest.fn(() => publicConfig),
  } as unknown as RuntimeConfigService;

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

  it('returns masked public config for update responses', async () => {
    const app = buildAppWithLeakyUpdateResult();

    const response = await request(app)
      .put('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .send({ gitlab: { token: 'glpat-secret' } })
      .expect(200);

    expect(response.body.requiresRestart).toEqual(['webhook.port']);
    expect(response.body.config).toEqual({
      claude: {
        baseUrl: 'https://api.anthropic.com',
        authToken: { configured: true, masked: '********cret' },
        defaultModel: 'claude-sonnet-4-20250514',
        defaultTimeoutMinutes: 30,
      },
      codex: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: { configured: false, masked: '' },
        defaultModel: 'gpt-5.1-codex-max',
        reasoningEffort: 'high',
        defaultTimeoutMinutes: 30,
      },
      gitlab: {
        baseUrl: 'https://gitlab.com',
        token: { configured: true, masked: '********cret' },
      },
      webhook: {
        secret: { configured: true, masked: '********cret' },
        port: 3000,
      },
      ai: {
        defaultProvider: 'claude',
      },
      review: {
        enabled: true,
        defaultProvider: 'claude-multipass',
        minConfidence: 80,
        maxCandidateFindings: 12,
        maxFinalFindings: 8,
        passConcurrency: 4,
        scoringConcurrency: 4,
        skipDraft: true,
        skipExistingSha: true,
        allowedCommands: ['/code-review'],
      },
      workDir: '/tmp/gitlab-claude-work',
      logLevel: 'info',
    });
    expect(JSON.stringify(response.body)).not.toContain('glpat-secret');
  });

  it('reloads runtime config', async () => {
    const app = await buildApp();

    await request(app)
      .post('/api/admin/config/reload')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200, { ok: true });
  });
});

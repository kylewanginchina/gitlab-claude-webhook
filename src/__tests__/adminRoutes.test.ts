import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ConfigUpdateResult, PublicRuntimeConfig } from '../admin/adminTypes';
import { createAdminRouter } from '../admin/adminRoutes';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';
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
  const reviewCustomizationService = new ReviewCustomizationService({ dataDir: dir });
  await reviewCustomizationService.initialize();

  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin',
    createAdminRouter({
      runtimeConfigService,
      reviewCustomizationService,
      env: { ADMIN_TOKEN: 'admin-secret' },
    })
  );
  return app;
}

function buildAppWithStubbedService(runtimeConfigService: Partial<RuntimeConfigService>) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin',
    createAdminRouter({
      runtimeConfigService: runtimeConfigService as RuntimeConfigService,
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
      reasoningEffort: 'high',
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
      taskConcurrency: 2,
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

function buildPublicConfig(overrides: Partial<PublicRuntimeConfig> = {}): PublicRuntimeConfig {
  return {
    claude: {
      baseUrl: 'https://api.anthropic.com',
      authToken: { configured: true, masked: '********cret' },
      defaultModel: 'claude-sonnet-4-20250514',
      reasoningEffort: 'high',
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
      taskConcurrency: 2,
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
    ...overrides,
  };
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
          reasoningEffort: 'xhigh',
          defaultTimeoutMinutes: 42,
        },
      })
      .expect(200);

    expect(response.body.requiresRestart).toEqual([]);
    expect(response.body.config.claude.defaultModel).toBe('claude-opus-test');
    expect(response.body.config.claude.reasoningEffort).toBe('xhigh');
    expect(response.body.config.claude.defaultTimeoutMinutes).toBe(42);
  });

  it('notifies the host service after runtime config updates', async () => {
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
    const onRuntimeConfigUpdated = jest.fn();

    const app = express();
    app.use(express.json());
    app.use(
      '/api/admin',
      createAdminRouter({
        runtimeConfigService,
        env: { ADMIN_TOKEN: 'admin-secret' },
        onRuntimeConfigUpdated,
      })
    );

    await request(app)
      .put('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .send({ webhook: { taskConcurrency: 3 } })
      .expect(200);

    expect(onRuntimeConfigUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        webhook: expect.objectContaining({ taskConcurrency: 3 }),
      })
    );
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
        reasoningEffort: 'high',
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
        taskConcurrency: 2,
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

  it('tests GitLab config from public secret metadata without reading raw config', async () => {
    const getConfig = jest.fn(() => {
      throw new Error('raw config should not be used');
    });
    const app = buildAppWithStubbedService({
      getConfig,
      getPublicConfig: jest.fn(() =>
        buildPublicConfig({
          gitlab: {
            baseUrl: 'https://gitlab.example.com',
            token: { configured: true, masked: '********cret' },
          },
        })
      ),
    });

    const response = await request(app)
      .post('/api/admin/test/gitlab')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(response.body).toEqual({
      provider: 'gitlab',
      ok: true,
      message: 'GitLab token is configured',
    });
    expect(getConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('cret');
  });

  it('reports missing Claude config from public secret metadata', async () => {
    const app = buildAppWithStubbedService({
      getConfig: jest.fn(() => {
        throw new Error('raw config should not be used');
      }),
      getPublicConfig: jest.fn(() =>
        buildPublicConfig({
          claude: {
            baseUrl: 'https://api.anthropic.com',
            authToken: { configured: false, masked: '' },
            defaultModel: 'claude-sonnet-4-20250514',
            reasoningEffort: 'high',
            defaultTimeoutMinutes: 30,
          },
        })
      ),
    });

    const response = await request(app)
      .post('/api/admin/test/claude')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(response.body).toEqual({
      provider: 'claude',
      ok: false,
      message: 'Claude token is missing',
    });
    expect(JSON.stringify(response.body)).not.toContain('masked');
  });

  it('tests Codex config from public secret metadata without reading raw config', async () => {
    const getConfig = jest.fn(() => {
      throw new Error('raw config should not be used');
    });
    const app = buildAppWithStubbedService({
      getConfig,
      getPublicConfig: jest.fn(() =>
        buildPublicConfig({
          codex: {
            baseUrl: 'https://openai.example.com/v1',
            apiKey: { configured: true, masked: '********ikey' },
            defaultModel: 'gpt-5.1-codex-max',
            reasoningEffort: 'high',
            defaultTimeoutMinutes: 30,
          },
        })
      ),
    });

    const response = await request(app)
      .post('/api/admin/test/codex')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(response.body).toEqual({
      provider: 'codex',
      ok: true,
      message: 'Codex API key is configured',
    });
    expect(getConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('openai.example.com');
    expect(JSON.stringify(response.body)).not.toContain('********ikey');
    expect(JSON.stringify(response.body)).not.toContain('apikey');
  });

  it('rejects missing admin key on provider test routes', async () => {
    const app = buildAppWithStubbedService({
      getPublicConfig: jest.fn(() => buildPublicConfig()),
    });

    await request(app).post('/api/admin/test/codex').expect(401, { error: 'Unauthorized' });
  });

  it('returns 400 for runtime config validation failures', async () => {
    const app = buildAppWithStubbedService({
      updateConfig: jest.fn(async () => {
        throw new Error('webhook.port must be between 1 and 65535');
      }),
    });

    await request(app)
      .put('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .send({ webhook: { port: 70000 } })
      .expect(400, { error: 'webhook.port must be between 1 and 65535' });
  });

  it('returns 400 for future runtime config validation-style failures', async () => {
    const app = buildAppWithStubbedService({
      updateConfig: jest.fn(async () => {
        throw new Error('review.passConcurrency must be at least 1');
      }),
    });

    await request(app)
      .put('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .send({ review: { passConcurrency: 0 } })
      .expect(400, { error: 'review.passConcurrency must be at least 1' });
  });

  it.each([
    ['root patch', 'runtime config patch must be an object', []],
    ['section patch', 'claude section must be an object', { claude: 'invalid' }],
    ['top-level field', 'logLevel must be one of: debug, info, warn, error', { logLevel: 'trace' }],
  ])('returns 400 for malformed runtime config payloads: %s', async (_label, message, payload) => {
    const app = buildAppWithStubbedService({
      updateConfig: jest.fn(async () => {
        throw new Error(message);
      }),
    });

    await request(app)
      .put('/api/admin/config')
      .set('X-Admin-Key', 'admin-secret')
      .send(payload)
      .expect(400, { error: message });
  });

  it('returns 500 for parse/store failures instead of misclassifying them as validation errors', async () => {
    const app = buildAppWithStubbedService({
      reload: jest.fn(async () => {
        throw new Error('Failed to parse JSON store /tmp/runtime-config.json: Unexpected token }');
      }),
    });

    await request(app)
      .post('/api/admin/config/reload')
      .set('X-Admin-Key', 'admin-secret')
      .expect(500, {
        error: 'Failed to parse JSON store /tmp/runtime-config.json: Unexpected token }',
      });
  });

  it('returns 500 for unexpected reload failures', async () => {
    const app = buildAppWithStubbedService({
      reload: jest.fn(async () => {
        throw new Error('disk offline');
      }),
    });

    await request(app)
      .post('/api/admin/config/reload')
      .set('X-Admin-Key', 'admin-secret')
      .expect(500, { error: 'disk offline' });
  });

  it('lists review prompts', async () => {
    const app = await buildApp();

    const response = await request(app)
      .get('/api/admin/prompts')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(response.body.prompts).toHaveLength(4);
    expect(response.body.prompts[0]).toMatchObject({
      id: 'claude-guidelines',
      label: 'CLAUDE.md compliance',
      currentVersion: 1,
    });
  });

  it('updates and publishes a review prompt', async () => {
    const app = await buildApp();

    const update = await request(app)
      .put('/api/admin/prompts/bug-scan')
      .set('X-Admin-Key', 'admin-secret')
      .send({
        draft: {
          focus: ['Look for transaction regressions.'],
          systemInstructions: 'Prefer concrete evidence.',
        },
      })
      .expect(200);

    expect(update.body.prompt.draft.focus).toEqual(['Look for transaction regressions.']);

    const publish = await request(app)
      .post('/api/admin/prompts/bug-scan/publish')
      .set('X-Admin-Key', 'admin-secret')
      .send({ changelog: 'Transaction focus' })
      .expect(200);

    expect(publish.body.prompt.currentVersion).toBe(2);
    expect(publish.body.prompt.versions[1].changelog).toBe('Transaction focus');
  });

  it('rolls a prompt back by creating a new published version', async () => {
    const app = await buildApp();

    await request(app)
      .put('/api/admin/prompts/bug-scan')
      .set('X-Admin-Key', 'admin-secret')
      .send({ draft: { focus: ['Temporary focus.'], systemInstructions: '' } })
      .expect(200);
    await request(app)
      .post('/api/admin/prompts/bug-scan/publish')
      .set('X-Admin-Key', 'admin-secret')
      .send({ changelog: 'Temporary' })
      .expect(200);

    const response = await request(app)
      .post('/api/admin/prompts/bug-scan/rollback')
      .set('X-Admin-Key', 'admin-secret')
      .send({ version: 1, changelog: 'Back to default' })
      .expect(200);

    expect(response.body.prompt.currentVersion).toBe(3);
    expect(response.body.prompt.draft.focus[0]).toContain('Read only the merge request changes');
  });

  it('lists and updates prompt templates', async () => {
    const app = await buildApp();

    const listed = await request(app)
      .get('/api/admin/prompt-templates')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(listed.body.templates).toHaveLength(9);
    expect(listed.body.templates[0]).toMatchObject({
      id: 'claude.edit.system',
      provider: 'claude',
      scope: 'edit',
      currentVersion: 1,
    });

    const updated = await request(app)
      .put('/api/admin/prompt-templates/claude.edit.system')
      .set('X-Admin-Key', 'admin-secret')
      .send({
        label: 'Claude edit system',
        draft: {
          body: 'Custom Claude edit prompt.',
        },
      })
      .expect(200);

    expect(updated.body.template.draft.body).toBe('Custom Claude edit prompt.');

    const published = await request(app)
      .post('/api/admin/prompt-templates/claude.edit.system/publish')
      .set('X-Admin-Key', 'admin-secret')
      .send({ changelog: 'Custom Claude behavior' })
      .expect(200);

    expect(published.body.template.currentVersion).toBe(2);
    expect(published.body.template.versions[1].changelog).toBe('Custom Claude behavior');
  });

  it('rolls a prompt template back by creating a new published version', async () => {
    const app = await buildApp();

    await request(app)
      .put('/api/admin/prompt-templates/codex.edit.instructions')
      .set('X-Admin-Key', 'admin-secret')
      .send({ draft: { body: 'Temporary Codex behavior.' } })
      .expect(200);
    await request(app)
      .post('/api/admin/prompt-templates/codex.edit.instructions/publish')
      .set('X-Admin-Key', 'admin-secret')
      .send({ changelog: 'Temporary' })
      .expect(200);

    const response = await request(app)
      .post('/api/admin/prompt-templates/codex.edit.instructions/rollback')
      .set('X-Admin-Key', 'admin-secret')
      .send({ version: 1, changelog: 'Back to default' })
      .expect(200);

    expect(response.body.template.currentVersion).toBe(3);
    expect(response.body.template.draft.body).toContain('Make code changes directly');
  });

  it('creates and toggles review skills', async () => {
    const app = await buildApp();

    const created = await request(app)
      .post('/api/admin/skills')
      .set('X-Admin-Key', 'admin-secret')
      .send({
        name: 'Security review',
        description: 'Security-sensitive review hints.',
        provider: 'any',
        fileGlobs: ['src/**'],
        languageHints: ['typescript'],
        promptIds: ['bug-scan'],
        systemInstructions: 'Prioritize auth bypasses.',
        priority: 10,
      })
      .expect(200);

    expect(created.body.skill.enabled).toBe(true);

    const disabled = await request(app)
      .post(`/api/admin/skills/${created.body.skill.id}/disable`)
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);
    expect(disabled.body.skill.enabled).toBe(false);

    const enabled = await request(app)
      .post(`/api/admin/skills/${created.body.skill.id}/enable`)
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);
    expect(enabled.body.skill.enabled).toBe(true);
  });

  it('records feedback and applies an optimizer proposal', async () => {
    const app = await buildApp();

    await request(app)
      .post('/api/admin/feedback')
      .set('X-Admin-Key', 'admin-secret')
      .send({
        promptId: 'bug-scan',
        label: 'false_positive',
        note: 'Generated schema noise should not be flagged.',
        source: 'admin',
      })
      .expect(200);

    const analyzed = await request(app)
      .post('/api/admin/prompt-optimizer/analyze')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(analyzed.body.proposals).toHaveLength(1);

    const applied = await request(app)
      .post(`/api/admin/prompt-optimizer/proposals/${analyzed.body.proposals[0].id}/apply`)
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(applied.body.proposal.status).toBe('applied');

    const prompt = await request(app)
      .get('/api/admin/prompts/bug-scan')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);

    expect(prompt.body.prompt.draft.focus.join('\n')).toContain('Generated schema noise');
    expect(prompt.body.prompt.currentVersion).toBe(1);
  });

  it('returns 404 for missing prompt IDs and 400 for malformed customization payloads', async () => {
    const app = await buildApp();

    await request(app)
      .put('/api/admin/prompts/missing')
      .set('X-Admin-Key', 'admin-secret')
      .send({ label: 'Missing' })
      .expect(404, { error: 'prompt not found' });

    await request(app)
      .put('/api/admin/prompt-templates/missing')
      .set('X-Admin-Key', 'admin-secret')
      .send({ draft: { body: 'Missing' } })
      .expect(404, { error: 'prompt template not found' });

    await request(app)
      .post('/api/admin/skills')
      .set('X-Admin-Key', 'admin-secret')
      .send({
        name: '',
        systemInstructions: 'Invalid skill',
      })
      .expect(400, { error: 'skill.name is required' });
  });
});

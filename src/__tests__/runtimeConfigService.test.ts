import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  RuntimeConfigService,
  createConfigFromEnv,
} from '../admin/runtimeConfigService';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runtime-config-'));
}

async function buildRuntimeConfigService() {
  const dir = await tempDir();
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

describe('RuntimeConfigService', () => {
  it('notifies subscribers after initialize persists the current config', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
        LOG_LEVEL: 'warn',
      } as NodeJS.ProcessEnv,
    });
    const observed: Array<{ notified: string; current: string; persisted: boolean }> = [];
    let persisted = false;
    const originalWrite = (service as any).store.write.bind((service as any).store);
    jest.spyOn((service as any).store, 'write').mockImplementation(async config => {
      await originalWrite(config);
      persisted = true;
    });
    service.subscribe(config => {
      observed.push({
        notified: config.logLevel,
        current: service.getConfig().logLevel,
        persisted,
      });
    });

    expect(observed).toEqual([]);
    await service.initialize();

    expect(observed).toEqual([{ notified: 'warn', current: 'warn', persisted: true }]);
  });

  it('notifies subscribers with the reloaded config after reload completes', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });
    await service.initialize();
    const observed: Array<{ notified: string; current: string }> = [];
    service.subscribe(config => {
      observed.push({ notified: config.logLevel, current: service.getConfig().logLevel });
    });
    const reloaded = service.getConfig();
    reloaded.logLevel = 'debug';
    await fs.writeFile(path.join(dir, 'runtime-config.json'), JSON.stringify(reloaded));

    expect(observed).toEqual([]);
    await service.reload();

    expect(observed).toEqual([{ notified: 'debug', current: 'debug' }]);
  });

  it('notifies subscribers only after a runtime config update is persisted', async () => {
    const service = await buildRuntimeConfigService();
    const observed: string[] = [];
    const unsubscribe = service.subscribe(config => observed.push(config.logLevel));

    await service.updateConfig({ logLevel: 'debug' }, 'admin');

    expect(observed.at(-1)).toBe('debug');
    unsubscribe();
  });

  it('does not notify subscribers when persistence fails', async () => {
    const service = await buildRuntimeConfigService();
    const observed: string[] = [];
    service.subscribe(config => observed.push(config.logLevel));
    jest.spyOn((service as any).store, 'write').mockRejectedValueOnce(new Error('disk full'));

    await expect(service.updateConfig({ logLevel: 'debug' }, 'admin')).rejects.toThrow('disk full');
    expect(observed).toEqual([]);
  });

  it('creates config from environment variables with defaults', () => {
    const config = createConfigFromEnv({
      GITLAB_BASE_URL: 'https://gitlab.example.com',
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
    } as NodeJS.ProcessEnv);

    expect(config.gitlab.baseUrl).toBe('https://gitlab.example.com');
    expect(config.gitlab.token).toBe('glpat-secret');
    expect(config.webhook.secret).toBe('webhook-secret');
    expect(config.webhook.port).toBe(3000);
    expect(config.webhook.taskConcurrency).toBe(2);
    expect(config.ai.defaultProvider).toBe('claude');
    expect((config.claude as any).reasoningEffort).toBe('high');
    expect(config.review.minConfidence).toBe(80);
    expect(config.review.maxCandidateFindings).toBe(12);
    expect(config.review.maxFinalFindings).toBe(8);
  });

  it('creates Claude reasoning effort from environment variables', () => {
    const config = createConfigFromEnv({
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      CLAUDE_REASONING_EFFORT: 'max',
    } as NodeJS.ProcessEnv);

    expect((config.claude as any).reasoningEffort).toBe('max');
  });

  it('creates webhook task concurrency from environment variables', () => {
    const config = createConfigFromEnv({
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      WEBHOOK_TASK_CONCURRENCY: '5',
    } as NodeJS.ProcessEnv);

    expect(config.webhook.taskConcurrency).toBe(5);
  });

  it('expands environment variable references from the injected env when creating config', () => {
    const config = createConfigFromEnv({
      TOKEN_SOURCE: 'anthropic-expanded-token',
      SECRET_SOURCE: 'expanded-webhook-secret',
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: '$SECRET_SOURCE',
      ANTHROPIC_AUTH_TOKEN: '${TOKEN_SOURCE}',
      OPENAI_API_KEY: 'openai-secret',
    } as NodeJS.ProcessEnv);

    expect(config.claude.authToken).toBe('anthropic-expanded-token');
    expect(config.webhook.secret).toBe('expanded-webhook-secret');
  });

  it('initializes from env and writes runtime config file', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const config = service.getConfig();
    expect(config.gitlab.token).toBe('glpat-secret');
    await expect(fs.readFile(path.join(dir, 'runtime-config.json'), 'utf8')).resolves.toContain(
      '"gitlab"'
    );
  });

  it('returns public config with secret statuses instead of raw secrets', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
        OPENAI_API_KEY: '',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const publicConfig = service.getPublicConfig();
    expect(publicConfig.gitlab.token).toEqual({
      configured: true,
      masked: '********cret',
    });
    expect(publicConfig.claude.authToken.configured).toBe(true);
    expect(publicConfig.codex.apiKey.configured).toBe(false);
  });

  it('updates hot config fields while keeping existing secrets when omitted', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const result = await service.updateConfig(
      {
        claude: {
          defaultModel: 'claude-opus-test',
          reasoningEffort: 'max',
          defaultTimeoutMinutes: 45,
        } as any,
        review: {
          minConfidence: 85,
        },
      },
      'admin'
    );

    expect(result.requiresRestart).toEqual([]);
    expect(service.getConfig().claude.authToken).toBe('anthropic-secret');
    expect(service.getConfig().claude.defaultModel).toBe('claude-opus-test');
    expect((service.getConfig().claude as any).reasoningEffort).toBe('max');
    expect(service.getConfig().claude.defaultTimeoutMinutes).toBe(45);
    expect(service.getConfig().review.minConfidence).toBe(85);
  });

  it('updates webhook task concurrency without requiring restart', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const result = await service.updateConfig(
      {
        webhook: {
          taskConcurrency: 4,
        },
      },
      'admin'
    );

    expect(result.requiresRestart).toEqual([]);
    expect(service.getConfig().webhook.taskConcurrency).toBe(4);
    expect(service.getPublicConfig().webhook.taskConcurrency).toBe(4);
  });

  it('adds webhook task concurrency when loading older persisted config files', async () => {
    const dir = await tempDir();
    const stored = createConfigFromEnv({
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    } as NodeJS.ProcessEnv);
    delete (stored.webhook as Partial<typeof stored.webhook>).taskConcurrency;

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'runtime-config.json'), JSON.stringify(stored, null, 2));

    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    expect(service.getConfig().webhook.taskConcurrency).toBe(2);
    await expect(fs.readFile(path.join(dir, 'runtime-config.json'), 'utf8')).resolves.toContain(
      '"taskConcurrency": 2'
    );
  });

  it('keeps existing secrets on blank secret patches and drops unknown nested fields', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    await service.updateConfig(
      {
        claude: {
          authToken: '',
          defaultModel: 'claude-opus-test',
          unexpectedField: 'ignored',
        } as any,
        review: {
          allowedCommands: ['/review-me'],
          extraSetting: true,
        } as any,
        webhook: {
          secret: '',
          anotherUnknownField: 'ignored',
        } as any,
      } as any,
      'admin'
    );

    const config = service.getConfig();
    const persisted = await fs.readFile(path.join(dir, 'runtime-config.json'), 'utf8');

    expect(config.claude.authToken).toBe('anthropic-secret');
    expect(config.claude.defaultModel).toBe('claude-opus-test');
    expect(config.webhook.secret).toBe('webhook-secret');
    expect(config.review.allowedCommands).toEqual(['/review-me']);
    expect((config.claude as any).unexpectedField).toBeUndefined();
    expect((config.review as any).extraSetting).toBeUndefined();
    expect((config.webhook as any).anotherUnknownField).toBeUndefined();
    expect(persisted).not.toContain('unexpectedField');
    expect(persisted).not.toContain('extraSetting');
    expect(persisted).not.toContain('anotherUnknownField');
  });

  it('reports restart-required fields when webhook port changes', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const result = await service.updateConfig({ webhook: { port: 3999 } }, 'admin');

    expect(result.requiresRestart).toEqual(['webhook.port']);
    expect(service.getConfig().webhook.port).toBe(3999);
  });

  it('reloads using env/default fallback when runtime config file is missing', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
        LOG_LEVEL: 'warn',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();
    await service.updateConfig({ logLevel: 'debug' }, 'admin');

    await fs.unlink(path.join(dir, 'runtime-config.json'));

    await service.reload();

    expect(service.getConfig().logLevel).toBe('warn');
  });

  it.each([
    ['claude', 'claude section must be an object', { claude: 'bad' }],
    ['codex', 'codex section must be an object', { codex: 'bad' }],
    ['gitlab', 'gitlab section must be an object', { gitlab: 'bad' }],
    ['webhook', 'webhook section must be an object', { webhook: 'bad' }],
    ['ai', 'ai section must be an object', { ai: 'bad' }],
    ['review', 'review section must be an object', { review: 'bad' }],
    ['ai.defaultProvider', 'ai.defaultProvider must be one of: claude, codex', { ai: { defaultProvider: 'other' } }],
    [
      'review.defaultProvider',
      'review.defaultProvider must be one of: claude-multipass, codex-multipass',
      { review: { defaultProvider: 'other' } },
    ],
    [
      'claude.reasoningEffort',
      'claude.reasoningEffort must be one of: low, medium, high, xhigh, max',
      { claude: { reasoningEffort: 'ultra' } },
    ],
    [
      'codex.reasoningEffort',
      'codex.reasoningEffort must be one of: minimal, low, medium, high, xhigh',
      { codex: { reasoningEffort: 'ultra' } },
    ],
    [
      'claude.defaultTimeoutMinutes',
      'claude.defaultTimeoutMinutes must be at least 1',
      { claude: { defaultTimeoutMinutes: 0 } },
    ],
    [
      'codex.defaultTimeoutMinutes',
      'codex.defaultTimeoutMinutes must be at least 1',
      { codex: { defaultTimeoutMinutes: 0 } },
    ],
    [
      'review.maxCandidateFindings',
      'review.maxCandidateFindings must be at least 1',
      { review: { maxCandidateFindings: 0 } },
    ],
    [
      'review.maxFinalFindings',
      'review.maxFinalFindings must be at least 1',
      { review: { maxFinalFindings: 0 } },
    ],
    [
      'review.passConcurrency',
      'review.passConcurrency must be at least 1',
      { review: { passConcurrency: 0 } },
    ],
    [
      'review.scoringConcurrency',
      'review.scoringConcurrency must be at least 1',
      { review: { scoringConcurrency: 0 } },
    ],
    ['review.enabled', 'review.enabled must be a boolean', { review: { enabled: 'true' } }],
    ['review.skipDraft', 'review.skipDraft must be a boolean', { review: { skipDraft: 'true' } }],
    [
      'review.skipExistingSha',
      'review.skipExistingSha must be a boolean',
      { review: { skipExistingSha: 'true' } },
    ],
    [
      'review.allowedCommands',
      'review.allowedCommands must be an array of strings',
      { review: { allowedCommands: '/code-review' } },
    ],
    [
      'review.allowedCommands item',
      'review.allowedCommands must be an array of strings',
      { review: { allowedCommands: ['/code-review', 4] } },
    ],
    ['logLevel', 'logLevel must be one of: debug, info, warn, error', { logLevel: 'trace' }],
    ['webhook.port', 'webhook.port must be between 1 and 65535', { webhook: { port: 0 } }],
    [
      'webhook.taskConcurrency',
      'webhook.taskConcurrency must be at least 1',
      { webhook: { taskConcurrency: 0 } },
    ],
    [
      'review.minConfidence',
      'review.minConfidence must be between 0 and 100',
      { review: { minConfidence: 101 } },
    ],
  ])('rejects invalid runtime config patch for %s', async (_label, errorMessage, patch) => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    await expect(service.updateConfig(patch as any, 'admin')).rejects.toThrow(errorMessage);
  });

  it('keeps in-memory config unchanged when persistence fails during update', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const before = service.getConfig();
    const writeSpy = jest
      .spyOn((service as unknown as { store: { write: (config: unknown) => Promise<void> } }).store, 'write')
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(
      service.updateConfig(
        {
          review: {
            minConfidence: 91,
          },
        },
        'admin'
      )
    ).rejects.toThrow('disk full');

    expect(service.getConfig()).toEqual(before);
    writeSpy.mockRestore();
  });

  it('reports restart-required fields when workDir changes', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const result = await service.updateConfig({ workDir: '/tmp/alternate-workdir' }, 'admin');

    expect(result.requiresRestart).toEqual(['workDir']);
    expect(service.getConfig().workDir).toBe('/tmp/alternate-workdir');
  });

  it('returns a defensive copy from getConfig', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const config = service.getConfig();
    config.review.minConfidence = 5;
    config.review.allowedCommands.push('/admin');
    config.gitlab.token = 'mutated-secret';

    expect(service.getConfig().review.minConfidence).toBe(80);
    expect(service.getConfig().review.allowedCommands).toEqual(['/code-review']);
    expect(service.getConfig().gitlab.token).toBe('glpat-secret');
  });

  it('returns a defensive copy from getPublicConfig', async () => {
    const dir = await tempDir();
    const service = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });

    await service.initialize();

    const publicConfig = service.getPublicConfig();
    publicConfig.ai.defaultProvider = 'codex';
    publicConfig.review.minConfidence = 5;
    publicConfig.review.allowedCommands.push('/admin');

    expect(service.getPublicConfig().ai.defaultProvider).toBe('claude');
    expect(service.getPublicConfig().review.minConfidence).toBe(80);
    expect(service.getPublicConfig().review.allowedCommands).toEqual(['/code-review']);
    expect(service.getConfig().ai.defaultProvider).toBe('claude');
    expect(service.getConfig().review.minConfidence).toBe(80);
    expect(service.getConfig().review.allowedCommands).toEqual(['/code-review']);
  });
});

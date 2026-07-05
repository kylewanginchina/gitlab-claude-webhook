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

describe('RuntimeConfigService', () => {
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
    expect(config.ai.defaultProvider).toBe('claude');
    expect(config.review.minConfidence).toBe(80);
    expect(config.review.maxCandidateFindings).toBe(12);
    expect(config.review.maxFinalFindings).toBe(8);
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
          defaultTimeoutMinutes: 45,
        },
        review: {
          minConfidence: 85,
        },
      },
      'admin'
    );

    expect(result.requiresRestart).toEqual([]);
    expect(service.getConfig().claude.authToken).toBe('anthropic-secret');
    expect(service.getConfig().claude.defaultModel).toBe('claude-opus-test');
    expect(service.getConfig().claude.defaultTimeoutMinutes).toBe(45);
    expect(service.getConfig().review.minConfidence).toBe(85);
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
});

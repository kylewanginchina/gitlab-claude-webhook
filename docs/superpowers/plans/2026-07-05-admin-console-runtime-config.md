# Admin Console Runtime Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working slice of the GitLab Claude Webhook admin console: authenticated `/admin` UI, `/api/admin/*` backend APIs, runtime configuration storage, and hot-effective model/timeout/review settings for new tasks.

**Architecture:** Add a small runtime configuration service backed by atomic JSON files under `data/`, then expose it through authenticated Express admin routes. Keep existing `.env` behavior as the fallback source while converting execution paths to read current config at task start instead of relying on the static imported `config` object. Add a Vite React frontend that follows the dense admin layout pattern from `/home/server/codex2api`, built into `dist/public/admin` and served by Express.

**Tech Stack:** Node.js 20, TypeScript `NodeNext`, Express 4, Jest with `ts-jest`, React 19, Vite, lucide-react, Docker Compose.

## Global Constraints

- Current webhook behavior must remain compatible with existing GitLab setup.
- `/health` must remain unauthenticated.
- Admin API prefix must be `/api/admin`.
- Admin frontend path must be `/admin`.
- Admin API authentication uses `X-Admin-Key`.
- Admin API must fail closed when `ADMIN_TOKEN` is not configured.
- Secret values must never be returned in full by admin APIs.
- Runtime config source priority is admin runtime config, environment variables, then code defaults.
- Settings that can hot-apply must affect new tasks without process restart.
- `webhook.port`, `workDir`, Docker volume, and Docker network changes require restart.
- Do not implement Prompt/Skill management or CodeRabbit provider in this plan; those are separate subsystem plans.
- Keep dependencies minimal and scoped to the feature.

---

## Scope Check

The source design covers three independent subsystems:

1. Management console and runtime configuration.
2. Prompt/Skill management and feedback optimization.
3. CodeRabbit provider integration.

This plan implements only subsystem 1 because it produces a working, independently testable admin console. Prompt/Skill management and CodeRabbit provider work should be planned separately after this plan lands.

## File Structure

Create backend admin and storage modules:

- `src/admin/adminTypes.ts` - shared backend types for runtime config, public config, update results, status, and provider test results.
- `src/admin/secretMask.ts` - secret masking and "configured" metadata helpers.
- `src/storage/jsonStore.ts` - atomic JSON read/write utility for config and audit files.
- `src/admin/runtimeConfigService.ts` - environment fallback, file-backed config loading, validation, update, audit writing, and public config projection.
- `src/admin/adminAuth.ts` - Express middleware enforcing `X-Admin-Key`.
- `src/admin/adminRoutes.ts` - Express router for `/api/admin/status`, `/api/admin/config`, `/api/admin/config/reload`, and provider test endpoints.
- `src/utils/runtimeConfig.ts` - singleton accessor for runtime config service.

Modify existing backend modules:

- `src/server/webhookServer.ts` - mount admin routes and serve `/admin` static assets.
- `src/index.ts` - initialize runtime config service before starting server.
- `src/utils/configDebug.ts` - report runtime config status without exposing secrets.
- `src/services/streamingClaudeExecutor.ts` - read current Claude model/base URL/token/default timeout per execution.
- `src/services/codexExecutor.ts` - read current Codex model/base URL/key/reasoning/default timeout per execution.
- `src/services/gitlabService.ts` - build GitLab API client from runtime config per instance.
- `src/services/gitlabReviewService.ts` - read review thresholds and caps from runtime config.
- `src/types/common.ts` - add runtime config-related shared types only when they are used outside admin modules.
- `Dockerfile` - build frontend and copy admin assets.
- `docker-compose.yml` - add `ADMIN_TOKEN`, mount `./data:/app/data`, and preserve existing volumes.
- `package.json` - add admin build script and backend route test dependency.

Create frontend modules:

- `frontend/package.json` - Vite React admin package.
- `frontend/index.html` - admin root HTML.
- `frontend/vite.config.ts` - builds to `../dist/public/admin`.
- `frontend/tsconfig.json` - frontend TypeScript config.
- `frontend/src/main.tsx` - React entrypoint.
- `frontend/src/App.tsx` - route shell.
- `frontend/src/api.ts` - admin API client using `X-Admin-Key`.
- `frontend/src/types.ts` - frontend API types matching `src/admin/adminTypes.ts`.
- `frontend/src/index.css` - dense admin styling.
- `frontend/src/components/AuthGate.tsx` - admin key login gate.
- `frontend/src/components/Layout.tsx` - sidebar layout.
- `frontend/src/pages/Dashboard.tsx` - status cards and config summary.
- `frontend/src/pages/Settings.tsx` - runtime config editor and provider tests.

Create tests:

- `src/__tests__/secretMask.test.ts`
- `src/__tests__/jsonStore.test.ts`
- `src/__tests__/runtimeConfigService.test.ts`
- `src/__tests__/adminAuth.test.ts`
- `src/__tests__/adminRoutes.test.ts`
- `src/__tests__/runtimeConfigIntegration.test.ts`

## Task 1: Secret Masking And JSON Store

**Files:**
- Create: `src/admin/secretMask.ts`
- Create: `src/storage/jsonStore.ts`
- Test: `src/__tests__/secretMask.test.ts`
- Test: `src/__tests__/jsonStore.test.ts`

**Interfaces:**
- Produces: `maskSecret(value: string | undefined): string`
- Produces: `secretStatus(value: string | undefined): { configured: boolean; masked: string }`
- Produces: `JsonStore<T>` with `read(defaultValue: T): Promise<T>` and `write(value: T): Promise<void>`

- [ ] **Step 1: Write failing tests for secret masking**

Create `src/__tests__/secretMask.test.ts`:

```ts
import { maskSecret, secretStatus } from '../admin/secretMask';

describe('secretMask', () => {
  it('masks missing secrets as empty strings', () => {
    expect(maskSecret(undefined)).toBe('');
    expect(secretStatus(undefined)).toEqual({ configured: false, masked: '' });
  });

  it('masks short secrets without leaking characters', () => {
    expect(maskSecret('abc')).toBe('***');
    expect(secretStatus('abc')).toEqual({ configured: true, masked: '***' });
  });

  it('keeps only the last four characters for longer secrets', () => {
    expect(maskSecret('glpat-1234567890')).toBe('***********7890');
    expect(secretStatus('glpat-1234567890')).toEqual({
      configured: true,
      masked: '***********7890',
    });
  });
});
```

- [ ] **Step 2: Run the masking test and verify it fails**

Run:

```bash
npm test -- src/__tests__/secretMask.test.ts
```

Expected: FAIL with `Cannot find module '../admin/secretMask'`.

- [ ] **Step 3: Implement secret masking**

Create `src/admin/secretMask.ts`:

```ts
export interface SecretStatus {
  configured: boolean;
  masked: string;
}

export function maskSecret(value: string | undefined): string {
  if (!value) {
    return '';
  }

  if (value.length <= 4) {
    return '***';
  }

  return `${'*'.repeat(Math.max(8, value.length - 4))}${value.slice(-4)}`;
}

export function secretStatus(value: string | undefined): SecretStatus {
  return {
    configured: Boolean(value && value.length > 0),
    masked: maskSecret(value),
  };
}
```

- [ ] **Step 4: Run the masking test and verify it passes**

Run:

```bash
npm test -- src/__tests__/secretMask.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing tests for atomic JSON storage**

Create `src/__tests__/jsonStore.test.ts`:

```ts
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { JsonStore } from '../storage/jsonStore';

interface SampleRecord {
  name: string;
  count: number;
}

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-store-'));
  return path.join(dir, 'record.json');
}

describe('JsonStore', () => {
  it('returns the default value when the file does not exist', async () => {
    const filePath = await tempFile();
    const store = new JsonStore<SampleRecord>(filePath);

    await expect(store.read({ name: 'default', count: 1 })).resolves.toEqual({
      name: 'default',
      count: 1,
    });
  });

  it('writes and reads JSON values', async () => {
    const filePath = await tempFile();
    const store = new JsonStore<SampleRecord>(filePath);

    await store.write({ name: 'saved', count: 2 });

    await expect(store.read({ name: 'default', count: 1 })).resolves.toEqual({
      name: 'saved',
      count: 2,
    });
  });

  it('throws a helpful error for invalid JSON', async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, '{bad json', 'utf8');
    const store = new JsonStore<SampleRecord>(filePath);

    await expect(store.read({ name: 'default', count: 1 })).rejects.toThrow(
      `Failed to parse JSON store ${filePath}`
    );
  });
});
```

- [ ] **Step 6: Run the JSON store test and verify it fails**

Run:

```bash
npm test -- src/__tests__/jsonStore.test.ts
```

Expected: FAIL with `Cannot find module '../storage/jsonStore'`.

- [ ] **Step 7: Implement JsonStore**

Create `src/storage/jsonStore.ts`:

```ts
import fs from 'fs/promises';
import path from 'path';

export class JsonStore<T> {
  constructor(private readonly filePath: string) {}

  public async read(defaultValue: T): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return defaultValue;
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Failed to parse JSON store ${this.filePath}: ${error.message}`);
      }

      throw error;
    }
  }

  public async write(value: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = `${JSON.stringify(value, null, 2)}\n`;

    await fs.writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }
}
```

- [ ] **Step 8: Run storage tests**

Run:

```bash
npm test -- src/__tests__/secretMask.test.ts src/__tests__/jsonStore.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/admin/secretMask.ts src/storage/jsonStore.ts src/__tests__/secretMask.test.ts src/__tests__/jsonStore.test.ts
git commit -m "feat(admin): add secret masking and json store"
```

## Task 2: Runtime Config Types And Service

**Files:**
- Create: `src/admin/adminTypes.ts`
- Create: `src/admin/runtimeConfigService.ts`
- Create: `src/utils/runtimeConfig.ts`
- Test: `src/__tests__/runtimeConfigService.test.ts`

**Interfaces:**
- Consumes: `JsonStore<T>` from Task 1
- Consumes: `secretStatus(value: string | undefined)` from Task 1
- Produces: `RuntimeConfigService`
- Produces: `RuntimeConfig`
- Produces: `PublicRuntimeConfig`
- Produces: `createConfigFromEnv(env: NodeJS.ProcessEnv): RuntimeConfig`
- Produces: `runtimeConfigService`

- [ ] **Step 1: Write failing runtime config service tests**

Create `src/__tests__/runtimeConfigService.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the runtime config tests and verify they fail**

Run:

```bash
npm test -- src/__tests__/runtimeConfigService.test.ts
```

Expected: FAIL with `Cannot find module '../admin/runtimeConfigService'`.

- [ ] **Step 3: Create admin types**

Create `src/admin/adminTypes.ts`:

```ts
import { AIProvider, ReasoningEffort } from '../types/common';
import { SecretStatus } from './secretMask';

export interface RuntimeConfig {
  claude: {
    baseUrl: string;
    authToken: string;
    defaultModel: string;
    defaultTimeoutMinutes: number;
  };
  codex: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    reasoningEffort: ReasoningEffort;
    defaultTimeoutMinutes: number;
  };
  gitlab: {
    baseUrl: string;
    token: string;
  };
  webhook: {
    secret: string;
    port: number;
  };
  ai: {
    defaultProvider: AIProvider;
  };
  review: {
    enabled: boolean;
    defaultProvider: 'claude-multipass' | 'codex-multipass';
    minConfidence: number;
    maxCandidateFindings: number;
    maxFinalFindings: number;
    passConcurrency: number;
    scoringConcurrency: number;
    skipDraft: boolean;
    skipExistingSha: boolean;
    allowedCommands: string[];
  };
  workDir: string;
  logLevel: string;
}

export type RuntimeConfigPatch = {
  claude?: Partial<RuntimeConfig['claude']>;
  codex?: Partial<RuntimeConfig['codex']>;
  gitlab?: Partial<RuntimeConfig['gitlab']>;
  webhook?: Partial<RuntimeConfig['webhook']>;
  ai?: Partial<RuntimeConfig['ai']>;
  review?: Partial<RuntimeConfig['review']>;
  workDir?: string;
  logLevel?: string;
};

export interface PublicRuntimeConfig
  extends Omit<RuntimeConfig, 'claude' | 'codex' | 'gitlab' | 'webhook'> {
  claude: Omit<RuntimeConfig['claude'], 'authToken'> & {
    authToken: SecretStatus;
  };
  codex: Omit<RuntimeConfig['codex'], 'apiKey'> & {
    apiKey: SecretStatus;
  };
  gitlab: Omit<RuntimeConfig['gitlab'], 'token'> & {
    token: SecretStatus;
  };
  webhook: Omit<RuntimeConfig['webhook'], 'secret'> & {
    secret: SecretStatus;
  };
}

export interface ConfigUpdateResult {
  config: PublicRuntimeConfig;
  requiresRestart: string[];
}

export interface AdminStatus {
  status: 'ok';
  uptime: number;
  version: string;
  configLoaded: boolean;
  timestamp: string;
}

export interface ProviderTestResult {
  provider: 'gitlab' | 'claude' | 'codex';
  ok: boolean;
  message: string;
}
```

- [ ] **Step 4: Implement runtime config service**

Create `src/admin/runtimeConfigService.ts`:

```ts
import path from 'path';
import { JsonStore } from '../storage/jsonStore';
import { AIProvider, ReasoningEffort } from '../types/common';
import { secretStatus } from './secretMask';
import {
  ConfigUpdateResult,
  PublicRuntimeConfig,
  RuntimeConfig,
  RuntimeConfigPatch,
} from './adminTypes';

export interface RuntimeConfigServiceOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

const VALID_REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

function envValue(env: NodeJS.ProcessEnv, key: string, defaultValue = ''): string {
  return env[key] || defaultValue;
}

function intValue(value: string, defaultValue: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function providerValue(value: string): AIProvider {
  return value === 'codex' ? 'codex' : 'claude';
}

function reasoningValue(value: string): ReasoningEffort {
  return VALID_REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : 'high';
}

export function createConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    claude: {
      baseUrl: envValue(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
      authToken: envValue(env, 'ANTHROPIC_AUTH_TOKEN'),
      defaultModel: envValue(env, 'CLAUDE_DEFAULT_MODEL', 'claude-sonnet-4-20250514'),
      defaultTimeoutMinutes: intValue(envValue(env, 'CLAUDE_DEFAULT_TIMEOUT_MINUTES', '30'), 30),
    },
    codex: {
      baseUrl: envValue(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      apiKey: envValue(env, 'OPENAI_API_KEY'),
      defaultModel: envValue(env, 'CODEX_DEFAULT_MODEL', 'gpt-5.1-codex-max'),
      reasoningEffort: reasoningValue(envValue(env, 'CODEX_REASONING_EFFORT', 'high')),
      defaultTimeoutMinutes: intValue(envValue(env, 'CODEX_DEFAULT_TIMEOUT_MINUTES', '30'), 30),
    },
    gitlab: {
      baseUrl: envValue(env, 'GITLAB_BASE_URL', 'https://gitlab.com'),
      token: envValue(env, 'GITLAB_TOKEN'),
    },
    webhook: {
      secret: envValue(env, 'WEBHOOK_SECRET'),
      port: intValue(envValue(env, 'PORT', '3000'), 3000),
    },
    ai: {
      defaultProvider: providerValue(envValue(env, 'AI_DEFAULT_PROVIDER', 'claude')),
    },
    review: {
      enabled: envValue(env, 'REVIEW_ENABLED', 'true') !== 'false',
      defaultProvider: 'claude-multipass',
      minConfidence: intValue(envValue(env, 'REVIEW_MIN_CONFIDENCE', '80'), 80),
      maxCandidateFindings: intValue(envValue(env, 'REVIEW_MAX_CANDIDATE_FINDINGS', '12'), 12),
      maxFinalFindings: intValue(envValue(env, 'REVIEW_MAX_FINAL_FINDINGS', '8'), 8),
      passConcurrency: intValue(envValue(env, 'REVIEW_PASS_CONCURRENCY', '4'), 4),
      scoringConcurrency: intValue(envValue(env, 'REVIEW_SCORING_CONCURRENCY', '4'), 4),
      skipDraft: true,
      skipExistingSha: true,
      allowedCommands: ['/code-review'],
    },
    workDir: envValue(env, 'WORK_DIR', '/tmp/gitlab-claude-work'),
    logLevel: envValue(env, 'LOG_LEVEL', 'info'),
  };
}

export class RuntimeConfigService {
  private readonly store: JsonStore<RuntimeConfig>;
  private config: RuntimeConfig;
  private loaded = false;

  constructor(private readonly options: RuntimeConfigServiceOptions = {}) {
    const dataDir = options.dataDir || process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
    this.store = new JsonStore<RuntimeConfig>(path.join(dataDir, 'runtime-config.json'));
    this.config = createConfigFromEnv(options.env || process.env);
  }

  public async initialize(): Promise<void> {
    const fallback = createConfigFromEnv(this.options.env || process.env);
    this.config = await this.store.read(fallback);
    this.validateConfig(this.config);
    await this.store.write(this.config);
    this.loaded = true;
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  public getConfig(): RuntimeConfig {
    return this.config;
  }

  public getPublicConfig(): PublicRuntimeConfig {
    const config = this.config;
    return {
      claude: {
        baseUrl: config.claude.baseUrl,
        authToken: secretStatus(config.claude.authToken),
        defaultModel: config.claude.defaultModel,
        defaultTimeoutMinutes: config.claude.defaultTimeoutMinutes,
      },
      codex: {
        baseUrl: config.codex.baseUrl,
        apiKey: secretStatus(config.codex.apiKey),
        defaultModel: config.codex.defaultModel,
        reasoningEffort: config.codex.reasoningEffort,
        defaultTimeoutMinutes: config.codex.defaultTimeoutMinutes,
      },
      gitlab: {
        baseUrl: config.gitlab.baseUrl,
        token: secretStatus(config.gitlab.token),
      },
      webhook: {
        secret: secretStatus(config.webhook.secret),
        port: config.webhook.port,
      },
      ai: config.ai,
      review: config.review,
      workDir: config.workDir,
      logLevel: config.logLevel,
    };
  }

  public async updateConfig(patch: RuntimeConfigPatch, _actor: string): Promise<ConfigUpdateResult> {
    const before = this.config;
    const next: RuntimeConfig = {
      ...before,
      claude: {
        ...before.claude,
        ...this.cleanSecretPatch(patch.claude, 'authToken'),
      },
      codex: {
        ...before.codex,
        ...this.cleanSecretPatch(patch.codex, 'apiKey'),
      },
      gitlab: {
        ...before.gitlab,
        ...this.cleanSecretPatch(patch.gitlab, 'token'),
      },
      webhook: {
        ...before.webhook,
        ...this.cleanSecretPatch(patch.webhook, 'secret'),
      },
      ai: {
        ...before.ai,
        ...(patch.ai || {}),
      },
      review: {
        ...before.review,
        ...(patch.review || {}),
      },
      workDir: patch.workDir ?? before.workDir,
      logLevel: patch.logLevel ?? before.logLevel,
    };

    this.validateConfig(next);
    this.config = next;
    await this.store.write(next);

    return {
      config: this.getPublicConfig(),
      requiresRestart: this.restartRequiredFields(before, next),
    };
  }

  public async reload(): Promise<void> {
    this.config = await this.store.read(this.config);
    this.validateConfig(this.config);
  }

  public validateConfig(config: RuntimeConfig): void {
    if (!config.gitlab.token) {
      throw new Error('GITLAB_TOKEN is required');
    }
    if (!config.webhook.secret) {
      throw new Error('WEBHOOK_SECRET is required');
    }
    if (!config.claude.authToken && !config.codex.apiKey) {
      throw new Error('ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY is required');
    }
    if (config.webhook.port < 1 || config.webhook.port > 65535) {
      throw new Error('webhook.port must be between 1 and 65535');
    }
    if (config.review.minConfidence < 0 || config.review.minConfidence > 100) {
      throw new Error('review.minConfidence must be between 0 and 100');
    }
  }

  private cleanSecretPatch<T extends Record<string, unknown>, K extends keyof T>(
    patch: T | undefined,
    secretKey: K
  ): Partial<T> {
    if (!patch) {
      return {};
    }

    const cleaned: Partial<T> = { ...patch };
    if (cleaned[secretKey] === '') {
      delete cleaned[secretKey];
    }
    return cleaned;
  }

  private restartRequiredFields(before: RuntimeConfig, next: RuntimeConfig): string[] {
    const fields: string[] = [];
    if (before.webhook.port !== next.webhook.port) {
      fields.push('webhook.port');
    }
    if (before.workDir !== next.workDir) {
      fields.push('workDir');
    }
    return fields;
  }
}
```

- [ ] **Step 5: Create singleton runtime config accessor**

Create `src/utils/runtimeConfig.ts`:

```ts
import { RuntimeConfigService } from '../admin/runtimeConfigService';

export const runtimeConfigService = new RuntimeConfigService();

export function getRuntimeConfigService(): RuntimeConfigService {
  return runtimeConfigService;
}
```

- [ ] **Step 6: Run runtime config tests**

Run:

```bash
npm test -- src/__tests__/runtimeConfigService.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin/adminTypes.ts src/admin/runtimeConfigService.ts src/utils/runtimeConfig.ts src/__tests__/runtimeConfigService.test.ts
git commit -m "feat(admin): add runtime config service"
```

## Task 3: Admin Authentication And Backend Routes

**Files:**
- Modify: `package.json`
- Create: `src/admin/adminAuth.ts`
- Create: `src/admin/adminRoutes.ts`
- Test: `src/__tests__/adminAuth.test.ts`
- Test: `src/__tests__/adminRoutes.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfigService` from Task 2
- Produces: `createAdminAuthMiddleware(env?: NodeJS.ProcessEnv): express.RequestHandler`
- Produces: `createAdminRouter(options: { runtimeConfigService: RuntimeConfigService; env?: NodeJS.ProcessEnv }): express.Router`

- [ ] **Step 1: Add route test dependencies**

Run:

```bash
npm install --save-dev supertest @types/supertest
```

Expected: `package.json` and `package-lock.json` update with `supertest` and `@types/supertest`.

- [ ] **Step 2: Write failing auth middleware tests**

Create `src/__tests__/adminAuth.test.ts`:

```ts
import express from 'express';
import request from 'supertest';
import { createAdminAuthMiddleware } from '../admin/adminAuth';

function appWithAuth(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(createAdminAuthMiddleware(env));
  app.get('/private', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('admin auth middleware', () => {
  it('fails closed when ADMIN_TOKEN is missing', async () => {
    const app = appWithAuth({});

    await request(app).get('/private').expect(503, {
      error: 'Admin API is disabled because ADMIN_TOKEN is not configured',
    });
  });

  it('rejects missing admin key', async () => {
    const app = appWithAuth({ ADMIN_TOKEN: 'secret-key' });

    await request(app).get('/private').expect(401, { error: 'Unauthorized' });
  });

  it('rejects invalid admin key', async () => {
    const app = appWithAuth({ ADMIN_TOKEN: 'secret-key' });

    await request(app).get('/private').set('X-Admin-Key', 'wrong').expect(401, {
      error: 'Unauthorized',
    });
  });

  it('allows valid admin key', async () => {
    const app = appWithAuth({ ADMIN_TOKEN: 'secret-key' });

    await request(app).get('/private').set('X-Admin-Key', 'secret-key').expect(200, {
      ok: true,
    });
  });
});
```

- [ ] **Step 3: Run auth tests and verify they fail**

Run:

```bash
npm test -- src/__tests__/adminAuth.test.ts
```

Expected: FAIL with `Cannot find module '../admin/adminAuth'`.

- [ ] **Step 4: Implement admin auth middleware**

Create `src/admin/adminAuth.ts`:

```ts
import { RequestHandler } from 'express';
import crypto from 'crypto';

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdminAuthMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req, res, next) => {
    const expected = env.ADMIN_TOKEN;

    if (!expected) {
      res.status(503).json({
        error: 'Admin API is disabled because ADMIN_TOKEN is not configured',
      });
      return;
    }

    const provided = req.header('X-Admin-Key') || '';
    if (!provided || !timingSafeStringEqual(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
```

- [ ] **Step 5: Run auth tests and verify they pass**

Run:

```bash
npm test -- src/__tests__/adminAuth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing admin route tests**

Create `src/__tests__/adminRoutes.test.ts`:

```ts
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
```

- [ ] **Step 7: Run admin route tests and verify they fail**

Run:

```bash
npm test -- src/__tests__/adminRoutes.test.ts
```

Expected: FAIL with `Cannot find module '../admin/adminRoutes'`.

- [ ] **Step 8: Implement admin routes**

Create `src/admin/adminRoutes.ts`:

```ts
import express from 'express';
import { RuntimeConfigService } from './runtimeConfigService';
import { createAdminAuthMiddleware } from './adminAuth';

export interface CreateAdminRouterOptions {
  runtimeConfigService: RuntimeConfigService;
  env?: NodeJS.ProcessEnv;
}

export function createAdminRouter(options: CreateAdminRouterOptions): express.Router {
  const router = express.Router();
  const { runtimeConfigService } = options;

  router.use(createAdminAuthMiddleware(options.env || process.env));

  router.get('/status', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      version: '1.0.0',
      configLoaded: runtimeConfigService.isLoaded(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/config', (_req, res) => {
    res.json(runtimeConfigService.getPublicConfig());
  });

  router.put('/config', async (req, res, next) => {
    try {
      const result = await runtimeConfigService.updateConfig(req.body, 'admin');
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/config/reload', async (_req, res, next) => {
    try {
      await runtimeConfigService.reload();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/test/gitlab', (_req, res) => {
    const config = runtimeConfigService.getConfig();
    res.json({
      provider: 'gitlab',
      ok: Boolean(config.gitlab.baseUrl && config.gitlab.token),
      message: config.gitlab.token ? 'GitLab token is configured' : 'GitLab token is missing',
    });
  });

  router.post('/test/claude', (_req, res) => {
    const config = runtimeConfigService.getConfig();
    res.json({
      provider: 'claude',
      ok: Boolean(config.claude.baseUrl && config.claude.authToken),
      message: config.claude.authToken ? 'Claude token is configured' : 'Claude token is missing',
    });
  });

  router.post('/test/codex', (_req, res) => {
    const config = runtimeConfigService.getConfig();
    res.json({
      provider: 'codex',
      ok: Boolean(config.codex.baseUrl && config.codex.apiKey),
      message: config.codex.apiKey ? 'Codex API key is configured' : 'Codex API key is missing',
    });
  });

  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  });

  return router;
}
```

- [ ] **Step 9: Run admin backend tests**

Run:

```bash
npm test -- src/__tests__/adminAuth.test.ts src/__tests__/adminRoutes.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/admin/adminAuth.ts src/admin/adminRoutes.ts src/__tests__/adminAuth.test.ts src/__tests__/adminRoutes.test.ts
git commit -m "feat(admin): add authenticated admin api routes"
```

## Task 4: Mount Admin Routes And Initialize Runtime Config

**Files:**
- Modify: `src/index.ts`
- Modify: `src/server/webhookServer.ts`
- Modify: `src/utils/configDebug.ts`
- Test: `src/__tests__/runtimeConfigIntegration.test.ts`

**Interfaces:**
- Consumes: `runtimeConfigService` from Task 2
- Consumes: `createAdminRouter(options)` from Task 3
- Produces: `WebhookServer` that mounts `/api/admin` and serves `/admin`

- [ ] **Step 1: Write failing integration tests for mounted admin API**

Create `src/__tests__/runtimeConfigIntegration.test.ts`:

```ts
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { WebhookServer } from '../server/webhookServer';
import { RuntimeConfigService } from '../admin/runtimeConfigService';

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
```

- [ ] **Step 2: Run integration test and verify it fails**

Run:

```bash
npm test -- src/__tests__/runtimeConfigIntegration.test.ts
```

Expected: FAIL because `WebhookServer` does not accept constructor options and does not expose `getApp()`.

- [ ] **Step 3: Modify WebhookServer constructor and routes**

Edit `src/server/webhookServer.ts`:

```ts
import express, { Request, Response } from 'express';
import path from 'path';
import { config } from '../utils/config';
import { verifyGitLabSignature } from '../utils/webhook';
import logger from '../utils/logger';
import { GitLabWebhookEvent } from '../types/gitlab';
import { EventProcessor } from '../services/eventProcessor';
import { RuntimeConfigService } from '../admin/runtimeConfigService';
import { createAdminRouter } from '../admin/adminRoutes';
import { runtimeConfigService as defaultRuntimeConfigService } from '../utils/runtimeConfig';

export interface WebhookServerOptions {
  runtimeConfigService?: RuntimeConfigService;
  env?: NodeJS.ProcessEnv;
}

export class WebhookServer {
  private app: express.Application;
  private eventProcessor: EventProcessor;
  private runtimeConfigService: RuntimeConfigService;
  private env: NodeJS.ProcessEnv;

  constructor(options: WebhookServerOptions = {}) {
    this.app = express();
    this.eventProcessor = new EventProcessor();
    this.runtimeConfigService = options.runtimeConfigService || defaultRuntimeConfigService;
    this.env = options.env || process.env;
    this.setupMiddleware();
    this.setupRoutes();
  }

  public getApp(): express.Application {
    return this.app;
  }

  private setupMiddleware(): void {
    this.app.use('/webhook', express.raw({ type: 'application/json', limit: '10mb' }));
    this.app.use(express.json({ limit: '10mb' }));
  }

  private setupRoutes(): void {
    this.app.post('/webhook', this.handleWebhook.bind(this));

    this.app.use(
      '/api/admin',
      createAdminRouter({
        runtimeConfigService: this.runtimeConfigService,
        env: this.env,
      })
    );

    const adminStaticPath = path.resolve(process.cwd(), 'dist/public/admin');
    this.app.use('/admin', express.static(adminStaticPath));
    this.app.get('/admin/*', (_req: Request, res: Response) => {
      res.sendFile(path.join(adminStaticPath, 'index.html'));
    });

    this.app.get('/health', (req: Request, res: Response) => {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
      };
      res.json(health);
    });

    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        service: 'GitLab Claude Webhook',
        version: '1.0.0',
        status: 'running',
      });
    });
  }

  private async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      const signature = req.headers['x-gitlab-token'] as string;
      const rawBody =
        req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

      if (!verifyGitLabSignature(rawBody, signature)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      const event: GitLabWebhookEvent = req.body instanceof Buffer ? JSON.parse(rawBody) : req.body;

      logger.info(`Received GitLab webhook: ${event.object_kind}`, {
        eventType: event.object_kind,
        projectId: event.project?.id,
        userId: event.user?.id,
      });

      this.eventProcessor.processEvent(event).catch(error => {
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
      this.app.listen(config.webhook.port, () => {
        logger.info(`GitLab Claude Webhook server started on port ${config.webhook.port}`);
      });
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}
```

- [ ] **Step 4: Initialize runtime config in application startup**

Edit `src/index.ts`:

```ts
import './env';
import { WebhookServer } from './server/webhookServer';
import logger from './utils/logger';
import { debugConfig, validateRequiredConfig } from './utils/configDebug';
import { generateCodexConfig } from './utils/codexConfig';
import { runtimeConfigService } from './utils/runtimeConfig';

async function main(): Promise<void> {
  try {
    await runtimeConfigService.initialize();

    if (process.env.NODE_ENV !== 'production') {
      debugConfig();
    }

    const { isValid, missing } = validateRequiredConfig();
    if (!isValid) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    generateCodexConfig();

    logger.info('Starting GitLab Claude Webhook Service...');

    const server = new WebhookServer({ runtimeConfigService });
    server.start();

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
```

- [ ] **Step 5: Update config validation to use runtime config**

Edit `src/utils/configDebug.ts`:

```ts
import { config } from './config';
import { runtimeConfigService } from './runtimeConfig';

/* eslint-disable no-console */

export function debugConfig(): void {
  const runtimeConfig = runtimeConfigService.getConfig();

  console.log('🔧 Configuration Debug Information:');
  console.log('=====================================');
  console.log('\n📁 Environment Files:');
  console.log(`Working Directory: ${process.cwd()}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV || 'undefined'}`);
  console.log(`Runtime Config Loaded: ${runtimeConfigService.isLoaded()}`);

  console.log('\n🔑 Loaded Runtime Configuration:');
  console.log(`Default Provider: ${runtimeConfig.ai.defaultProvider}`);
  console.log(`Claude Base URL: ${runtimeConfig.claude.baseUrl}`);
  console.log(`Claude Auth Token: ${runtimeConfig.claude.authToken ? '********' : 'NOT SET'}`);
  console.log(`Claude Default Model: ${runtimeConfig.claude.defaultModel}`);
  console.log(`Claude Default Timeout: ${runtimeConfig.claude.defaultTimeoutMinutes} minutes`);
  console.log(`OpenAI Base URL: ${runtimeConfig.codex.baseUrl}`);
  console.log(`OpenAI API Key: ${runtimeConfig.codex.apiKey ? '********' : 'NOT SET'}`);
  console.log(`Codex Default Model: ${runtimeConfig.codex.defaultModel}`);
  console.log(`Codex Reasoning Effort: ${runtimeConfig.codex.reasoningEffort}`);
  console.log(`GitLab Base URL: ${runtimeConfig.gitlab.baseUrl}`);
  console.log(`GitLab Token: ${runtimeConfig.gitlab.token ? '********' : 'NOT SET'}`);
  console.log(`Webhook Secret: ${runtimeConfig.webhook.secret ? '********' : 'NOT SET'}`);
  console.log(`Port: ${runtimeConfig.webhook.port}`);
  console.log(`Work Directory: ${runtimeConfig.workDir}`);
  console.log(`Log Level: ${runtimeConfig.logLevel}`);

  console.log('\n=====================================');
}

export function validateRequiredConfig(): { isValid: boolean; missing: string[] } {
  const runtimeConfig = runtimeConfigService.isLoaded()
    ? runtimeConfigService.getConfig()
    : {
        gitlab: { token: config.gitlab.token },
        webhook: { secret: config.webhook.secret },
        claude: { authToken: config.anthropic.authToken },
        codex: { apiKey: config.openai.apiKey },
      };

  const missing: string[] = [];

  if (!runtimeConfig.gitlab.token) missing.push('GITLAB_TOKEN');
  if (!runtimeConfig.webhook.secret) missing.push('WEBHOOK_SECRET');
  if (!runtimeConfig.claude.authToken && !runtimeConfig.codex.apiKey) {
    missing.push('ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY (at least one required)');
  }

  return {
    isValid: missing.length === 0,
    missing,
  };
}
```

- [ ] **Step 6: Run integration tests**

Run:

```bash
npm test -- src/__tests__/runtimeConfigIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run backend admin tests together**

Run:

```bash
npm test -- src/__tests__/runtimeConfigService.test.ts src/__tests__/adminAuth.test.ts src/__tests__/adminRoutes.test.ts src/__tests__/runtimeConfigIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/server/webhookServer.ts src/utils/configDebug.ts src/__tests__/runtimeConfigIntegration.test.ts
git commit -m "feat(admin): mount admin api and initialize runtime config"
```

## Task 5: Use Runtime Config In Execution Paths

**Files:**
- Modify: `src/services/streamingClaudeExecutor.ts`
- Modify: `src/services/codexExecutor.ts`
- Modify: `src/services/gitlabService.ts`
- Modify: `src/services/gitlabReviewService.ts`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**
- Consumes: `runtimeConfigService.getConfig()`
- Produces: Executors and review service using current config for new executions.

- [ ] **Step 1: Write failing execution config tests**

Create `src/__tests__/runtimeConfigExecution.test.ts`:

```ts
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RuntimeConfigService } from '../admin/runtimeConfigService';

async function initializedService(): Promise<RuntimeConfigService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-config-'));
  const service = new RuntimeConfigService({
    dataDir: dir,
    env: {
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
    } as NodeJS.ProcessEnv,
  });
  await service.initialize();
  return service;
}

describe('runtime execution config', () => {
  it('updates default Claude timeout for new tasks', async () => {
    const service = await initializedService();

    await service.updateConfig({ claude: { defaultTimeoutMinutes: 41 } }, 'admin');

    expect(service.getConfig().claude.defaultTimeoutMinutes * 60 * 1000).toBe(2460000);
  });

  it('updates default review thresholds for new tasks', async () => {
    const service = await initializedService();

    await service.updateConfig(
      {
        review: {
          minConfidence: 88,
          maxCandidateFindings: 6,
          maxFinalFindings: 3,
        },
      },
      'admin'
    );

    expect(service.getConfig().review.minConfidence).toBe(88);
    expect(service.getConfig().review.maxCandidateFindings).toBe(6);
    expect(service.getConfig().review.maxFinalFindings).toBe(3);
  });
});
```

- [ ] **Step 2: Run execution config tests**

Run:

```bash
npm test -- src/__tests__/runtimeConfigExecution.test.ts
```

Expected: PASS. This test confirms the runtime service behavior before wiring consumers.

- [ ] **Step 3: Update Claude executor to read runtime config per execution**

In `src/services/streamingClaudeExecutor.ts`, add the import:

```ts
import { runtimeConfigService } from '../utils/runtimeConfig';
```

In `runClaudeWithSDK`, replace the static config reads with:

```ts
const runtimeConfig = runtimeConfigService.getConfig();
const model = context.model || runtimeConfig.claude.defaultModel;
const timeoutMs =
  context.timeoutMs || runtimeConfig.claude.defaultTimeoutMinutes * 60 * 1000;
const isReviewMode = context.mode === 'review';

const env: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ),
  ANTHROPIC_BASE_URL: runtimeConfig.claude.baseUrl,
  ANTHROPIC_API_KEY: runtimeConfig.claude.authToken,
};
```

Remove only the now-unused import of `config` if TypeScript reports it unused.

- [ ] **Step 4: Update Codex executor to read runtime config per execution**

In `src/services/codexExecutor.ts`, add the import:

```ts
import { runtimeConfigService } from '../utils/runtimeConfig';
```

In `runCodexWithSDK`, replace static config reads with:

```ts
const runtimeConfig = runtimeConfigService.getConfig();
const model = context.model || runtimeConfig.codex.defaultModel;
const timeoutMs =
  context.timeoutMs || runtimeConfig.codex.defaultTimeoutMinutes * 60 * 1000;
const reasoningEffort = runtimeConfig.codex.reasoningEffort;
```

Create the Codex SDK instance with:

```ts
const codex = new (sdk.Codex || sdk.default?.Codex || sdk.default || sdk)({
  apiKey: runtimeConfig.codex.apiKey,
  baseUrl: runtimeConfig.codex.baseUrl,
});
```

Remove only the now-unused import of `config` if TypeScript reports it unused.

- [ ] **Step 5: Update GitLabService to use runtime config at construction**

In `src/services/gitlabService.ts`, replace the import:

```ts
import { config } from '../utils/config';
```

with:

```ts
import { runtimeConfigService } from '../utils/runtimeConfig';
```

Update the constructor:

```ts
constructor() {
  const runtimeConfig = runtimeConfigService.getConfig();
  this.gitlab = new Gitlab({
    host: runtimeConfig.gitlab.baseUrl,
    token: runtimeConfig.gitlab.token,
  });
}
```

- [ ] **Step 6: Update review service thresholds**

In `src/services/gitlabReviewService.ts`, add:

```ts
import { runtimeConfigService } from '../utils/runtimeConfig';
```

Replace fixed readonly values:

```ts
private readonly maxCandidateFindings = 12;
private readonly maxFinalFindings = 8;
```

with helper methods:

```ts
private getReviewConfig() {
  return runtimeConfigService.getConfig().review;
}
```

In `mergeCandidateFindings`, replace:

```ts
.slice(0, this.maxCandidateFindings);
```

with:

```ts
.slice(0, this.getReviewConfig().maxCandidateFindings);
```

In `buildFinalReview`, replace:

```ts
.slice(0, this.maxFinalFindings);
```

with:

```ts
.slice(0, this.getReviewConfig().maxFinalFindings);
```

In `parseReviewOutput`, keep the parameter default for compatibility, but callers in `EventProcessor` should pass `runtimeConfigService.getConfig().review.minConfidence` when they want the runtime threshold.

- [ ] **Step 7: Run type check**

Run:

```bash
npm run type-check
```

Expected: PASS.

- [ ] **Step 8: Run backend tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/services/streamingClaudeExecutor.ts src/services/codexExecutor.ts src/services/gitlabService.ts src/services/gitlabReviewService.ts src/__tests__/runtimeConfigExecution.test.ts
git commit -m "feat(admin): use runtime config in execution paths"
```

## Task 6: Frontend Admin App

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/index.html`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/api.ts`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/index.css`
- Create: `frontend/src/components/AuthGate.tsx`
- Create: `frontend/src/components/Layout.tsx`
- Create: `frontend/src/pages/Dashboard.tsx`
- Create: `frontend/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `/api/admin/status`
- Consumes: `/api/admin/config`
- Consumes: `PUT /api/admin/config`
- Consumes: `POST /api/admin/test/gitlab`
- Consumes: `POST /api/admin/test/claude`
- Consumes: `POST /api/admin/test/codex`
- Produces: static admin assets under `dist/public/admin`

- [ ] **Step 1: Create frontend package**

Create `frontend/package.json`:

```json
{
  "name": "gitlab-claude-webhook-admin",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^7.0.0",
    "typescript": "^5.3.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "lucide-react": "^0.468.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

- [ ] **Step 2: Create Vite config and HTML**

Create `frontend/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: '../dist/public/admin',
    emptyOutDir: true,
  },
});
```

Create `frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GitLab Claude Webhook Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2020"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Node",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create frontend types and API client**

Create `frontend/src/types.ts`:

```ts
export interface SecretStatus {
  configured: boolean;
  masked: string;
}

export interface PublicRuntimeConfig {
  claude: {
    baseUrl: string;
    authToken: SecretStatus;
    defaultModel: string;
    defaultTimeoutMinutes: number;
  };
  codex: {
    baseUrl: string;
    apiKey: SecretStatus;
    defaultModel: string;
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    defaultTimeoutMinutes: number;
  };
  gitlab: {
    baseUrl: string;
    token: SecretStatus;
  };
  webhook: {
    secret: SecretStatus;
    port: number;
  };
  ai: {
    defaultProvider: 'claude' | 'codex';
  };
  review: {
    enabled: boolean;
    defaultProvider: 'claude-multipass' | 'codex-multipass';
    minConfidence: number;
    maxCandidateFindings: number;
    maxFinalFindings: number;
    passConcurrency: number;
    scoringConcurrency: number;
    skipDraft: boolean;
    skipExistingSha: boolean;
    allowedCommands: string[];
  };
  workDir: string;
  logLevel: string;
}

export type RuntimeConfigPatch = Partial<{
  claude: Partial<{
    baseUrl: string;
    authToken: string;
    defaultModel: string;
    defaultTimeoutMinutes: number;
  }>;
  codex: Partial<{
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    defaultTimeoutMinutes: number;
  }>;
  gitlab: Partial<{
    baseUrl: string;
    token: string;
  }>;
  webhook: Partial<{
    secret: string;
    port: number;
  }>;
  ai: Partial<{
    defaultProvider: 'claude' | 'codex';
  }>;
  review: Partial<PublicRuntimeConfig['review']>;
  workDir: string;
  logLevel: string;
}>;

export interface AdminStatus {
  status: 'ok';
  uptime: number;
  version: string;
  configLoaded: boolean;
  timestamp: string;
}

export interface ConfigUpdateResult {
  config: PublicRuntimeConfig;
  requiresRestart: string[];
}

export interface ProviderTestResult {
  provider: 'gitlab' | 'claude' | 'codex';
  ok: boolean;
  message: string;
}
```

Create `frontend/src/api.ts`:

```ts
import type {
  AdminStatus,
  ConfigUpdateResult,
  ProviderTestResult,
  PublicRuntimeConfig,
  RuntimeConfigPatch,
} from './types';

const BASE = '/api/admin';
const ADMIN_KEY_STORAGE = 'gitlab_claude_admin_key';

export function getAdminKey(): string {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || '';
}

export function setAdminKey(value: string): void {
  if (value) {
    localStorage.setItem(ADMIN_KEY_STORAGE, value);
  } else {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Admin-Key', getAdminKey());
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: string };
      throw new Error(parsed.error || `HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message !== text) {
        throw error;
      }
      throw new Error(text || `HTTP ${response.status}`);
    }
  }

  return response.json() as Promise<T>;
}

export const api = {
  getStatus: () => request<AdminStatus>('/status'),
  getConfig: () => request<PublicRuntimeConfig>('/config'),
  updateConfig: (patch: RuntimeConfigPatch) =>
    request<ConfigUpdateResult>('/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  testProvider: (provider: 'gitlab' | 'claude' | 'codex') =>
    request<ProviderTestResult>(`/test/${provider}`, { method: 'POST' }),
};
```

- [ ] **Step 4: Create app shell and CSS**

Create `frontend/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

Create `frontend/src/App.tsx`:

```tsx
import { useState } from 'react';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';

export type AdminPage = 'dashboard' | 'settings';

export default function App() {
  const [page, setPage] = useState<AdminPage>('dashboard');

  return (
    <AuthGate>
      <Layout page={page} onPageChange={setPage}>
        {page === 'dashboard' ? <Dashboard /> : <Settings />}
      </Layout>
    </AuthGate>
  );
}
```

Create `frontend/src/index.css`:

```css
:root {
  color-scheme: light;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #162033;
  background: #f5f7fb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

button,
input,
select {
  font: inherit;
}

.auth-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
}

.auth-card,
.panel,
.metric-card {
  border: 1px solid #d9e0ec;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 10px 28px rgb(32 46 73 / 8%);
}

.auth-card {
  width: min(440px, 100%);
  padding: 24px;
}

.admin-shell {
  display: grid;
  grid-template-columns: 248px 1fr;
  min-height: 100vh;
}

.sidebar {
  border-right: 1px solid #d9e0ec;
  background: #ffffff;
  padding: 16px;
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 20px;
}

.brand strong {
  font-size: 16px;
}

.brand span {
  color: #6b778c;
  font-size: 12px;
}

.nav-button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #334155;
  cursor: pointer;
  padding: 9px 10px;
  text-align: left;
}

.nav-button.active {
  background: #e9f0ff;
  color: #1d4ed8;
}

.content {
  padding: 24px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.page-header h1 {
  margin: 0;
  font-size: 22px;
}

.grid {
  display: grid;
  gap: 16px;
}

.grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.panel,
.metric-card {
  padding: 16px;
}

.panel h2,
.metric-card h2 {
  margin: 0 0 12px;
  font-size: 16px;
}

.field {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}

.field label {
  color: #46566f;
  font-size: 13px;
  font-weight: 600;
}

.field input,
.field select {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  padding: 8px 10px;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.button {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  cursor: pointer;
  padding: 8px 12px;
}

.button.primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #ffffff;
}

.status-ok {
  color: #047857;
}

.status-warn {
  color: #b45309;
}

@media (max-width: 860px) {
  .admin-shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid #d9e0ec;
  }

  .grid.two,
  .grid.three {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 5: Create AuthGate and Layout**

Create `frontend/src/components/AuthGate.tsx`:

```tsx
import { FormEvent, PropsWithChildren, useEffect, useState } from 'react';
import { api, getAdminKey, setAdminKey } from '../api';

export default function AuthGate({ children }: PropsWithChildren) {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [adminKey, setAdminKeyInput] = useState(getAdminKey());
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getStatus()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false))
      .finally(() => setChecking(false));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setAdminKey(adminKey);
    try {
      await api.getStatus();
      setAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAuthenticated(false);
    }
  }

  if (checking) {
    return <div className="auth-shell">Loading admin console...</div>;
  }

  if (!authenticated) {
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={submit}>
          <h1>GitLab Claude Webhook</h1>
          <p>Enter the admin key to manage runtime configuration.</p>
          <div className="field">
            <label htmlFor="admin-key">Admin key</label>
            <input
              id="admin-key"
              type="password"
              value={adminKey}
              onChange={event => setAdminKeyInput(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error ? <p className="status-warn">{error}</p> : null}
          <button className="button primary" type="submit">
            Sign in
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
```

Create `frontend/src/components/Layout.tsx`:

```tsx
import { PropsWithChildren } from 'react';
import { Activity, LayoutDashboard, Settings } from 'lucide-react';
import type { AdminPage } from '../App';

interface LayoutProps extends PropsWithChildren {
  page: AdminPage;
  onPageChange: (page: AdminPage) => void;
}

export default function Layout({ page, onPageChange, children }: LayoutProps) {
  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>GitLab Claude</strong>
          <span>Webhook Admin</span>
        </div>
        <button
          className={`nav-button ${page === 'dashboard' ? 'active' : ''}`}
          onClick={() => onPageChange('dashboard')}
          type="button"
        >
          <LayoutDashboard size={18} />
          Dashboard
        </button>
        <button
          className={`nav-button ${page === 'settings' ? 'active' : ''}`}
          onClick={() => onPageChange('settings')}
          type="button"
        >
          <Settings size={18} />
          Settings
        </button>
        <div style={{ marginTop: 18, color: '#6b778c', fontSize: 12 }}>
          <Activity size={14} /> Runtime config controls new tasks immediately.
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
```

- [ ] **Step 6: Create Dashboard page**

Create `frontend/src/pages/Dashboard.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AdminStatus, PublicRuntimeConfig } from '../types';

export default function Dashboard() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [config, setConfig] = useState<PublicRuntimeConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getStatus(), api.getConfig()])
      .then(([statusResult, configResult]) => {
        setStatus(statusResult);
        setConfig(configResult);
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>
      {error ? <p className="status-warn">{error}</p> : null}
      <div className="grid three">
        <section className="metric-card">
          <h2>Service</h2>
          <p className={status?.status === 'ok' ? 'status-ok' : 'status-warn'}>
            {status?.status || 'loading'}
          </p>
          <p>Uptime: {status ? Math.round(status.uptime) : 0}s</p>
        </section>
        <section className="metric-card">
          <h2>Default Provider</h2>
          <p>{config?.ai.defaultProvider || 'loading'}</p>
          <p>Review: {config?.review.enabled ? 'enabled' : 'disabled'}</p>
        </section>
        <section className="metric-card">
          <h2>Secrets</h2>
          <p>GitLab: {config?.gitlab.token.configured ? 'configured' : 'missing'}</p>
          <p>Claude: {config?.claude.authToken.configured ? 'configured' : 'missing'}</p>
          <p>Codex: {config?.codex.apiKey.configured ? 'configured' : 'missing'}</p>
        </section>
      </div>
    </>
  );
}
```

- [ ] **Step 7: Create Settings page**

Create `frontend/src/pages/Settings.tsx`:

```tsx
import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import type { ProviderTestResult, PublicRuntimeConfig, RuntimeConfigPatch } from '../types';

export default function Settings() {
  const [config, setConfig] = useState<PublicRuntimeConfig | null>(null);
  const [message, setMessage] = useState('');
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(err => setMessage(err instanceof Error ? err.message : String(err)));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config) return;

    const patch: RuntimeConfigPatch = {
      ai: config.ai,
      claude: {
        baseUrl: config.claude.baseUrl,
        defaultModel: config.claude.defaultModel,
        defaultTimeoutMinutes: config.claude.defaultTimeoutMinutes,
      },
      codex: {
        baseUrl: config.codex.baseUrl,
        defaultModel: config.codex.defaultModel,
        reasoningEffort: config.codex.reasoningEffort,
        defaultTimeoutMinutes: config.codex.defaultTimeoutMinutes,
      },
      gitlab: {
        baseUrl: config.gitlab.baseUrl,
      },
      review: config.review,
      logLevel: config.logLevel,
    };

    const result = await api.updateConfig(patch);
    setConfig(result.config);
    setMessage(
      result.requiresRestart.length
        ? `Saved. Restart required for ${result.requiresRestart.join(', ')}.`
        : 'Saved. New tasks will use this configuration.'
    );
  }

  async function testProvider(provider: 'gitlab' | 'claude' | 'codex') {
    setTestResult(await api.testProvider(provider));
  }

  if (!config) {
    return <div>Loading settings...</div>;
  }

  return (
    <form onSubmit={save}>
      <div className="page-header">
        <h1>Settings</h1>
        <button className="button primary" type="submit">
          Save
        </button>
      </div>
      {message ? <p>{message}</p> : null}
      {testResult ? (
        <p className={testResult.ok ? 'status-ok' : 'status-warn'}>
          {testResult.provider}: {testResult.message}
        </p>
      ) : null}
      <div className="grid two">
        <section className="panel">
          <h2>AI Defaults</h2>
          <div className="field">
            <label>Default provider</label>
            <select
              value={config.ai.defaultProvider}
              onChange={event =>
                setConfig({ ...config, ai: { defaultProvider: event.target.value as 'claude' | 'codex' } })
              }
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          <div className="field">
            <label>Claude model</label>
            <input
              value={config.claude.defaultModel}
              onChange={event =>
                setConfig({
                  ...config,
                  claude: { ...config.claude, defaultModel: event.target.value },
                })
              }
            />
          </div>
          <div className="field">
            <label>Claude timeout minutes</label>
            <input
              type="number"
              value={config.claude.defaultTimeoutMinutes}
              onChange={event =>
                setConfig({
                  ...config,
                  claude: { ...config.claude, defaultTimeoutMinutes: Number(event.target.value) },
                })
              }
            />
          </div>
          <div className="field">
            <label>Codex model</label>
            <input
              value={config.codex.defaultModel}
              onChange={event =>
                setConfig({
                  ...config,
                  codex: { ...config.codex, defaultModel: event.target.value },
                })
              }
            />
          </div>
          <div className="field">
            <label>Codex reasoning effort</label>
            <select
              value={config.codex.reasoningEffort}
              onChange={event =>
                setConfig({
                  ...config,
                  codex: {
                    ...config.codex,
                    reasoningEffort: event.target.value as PublicRuntimeConfig['codex']['reasoningEffort'],
                  },
                })
              }
            >
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </div>
        </section>
        <section className="panel">
          <h2>Review</h2>
          <div className="field">
            <label>Enabled</label>
            <select
              value={config.review.enabled ? 'true' : 'false'}
              onChange={event =>
                setConfig({
                  ...config,
                  review: { ...config.review, enabled: event.target.value === 'true' },
                })
              }
            >
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </div>
          <div className="field">
            <label>Minimum confidence</label>
            <input
              type="number"
              value={config.review.minConfidence}
              onChange={event =>
                setConfig({
                  ...config,
                  review: { ...config.review, minConfidence: Number(event.target.value) },
                })
              }
            />
          </div>
          <div className="field">
            <label>Max final findings</label>
            <input
              type="number"
              value={config.review.maxFinalFindings}
              onChange={event =>
                setConfig({
                  ...config,
                  review: { ...config.review, maxFinalFindings: Number(event.target.value) },
                })
              }
            />
          </div>
          <div className="button-row">
            <button className="button" type="button" onClick={() => testProvider('gitlab')}>
              Test GitLab
            </button>
            <button className="button" type="button" onClick={() => testProvider('claude')}>
              Test Claude
            </button>
            <button className="button" type="button" onClick={() => testProvider('codex')}>
              Test Codex
            </button>
          </div>
        </section>
        <section className="panel">
          <h2>GitLab</h2>
          <div className="field">
            <label>Base URL</label>
            <input
              value={config.gitlab.baseUrl}
              onChange={event =>
                setConfig({
                  ...config,
                  gitlab: { ...config.gitlab, baseUrl: event.target.value },
                })
              }
            />
          </div>
          <p>Token: {config.gitlab.token.configured ? config.gitlab.token.masked : 'missing'}</p>
        </section>
        <section className="panel">
          <h2>Runtime</h2>
          <div className="field">
            <label>Log level</label>
            <select
              value={config.logLevel}
              onChange={event => setConfig({ ...config, logLevel: event.target.value })}
            >
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </div>
          <p>Webhook port: {config.webhook.port} requires restart to change.</p>
        </section>
      </div>
    </form>
  );
}
```

- [ ] **Step 8: Install and build frontend**

Run:

```bash
cd frontend
npm install
npm run typecheck
npm run build
```

Expected: typecheck PASS and Vite writes files to `../dist/public/admin`.

- [ ] **Step 9: Commit**

```bash
git add frontend package-lock.json
git commit -m "feat(admin): add runtime settings frontend"
```

## Task 7: Build And Docker Integration

**Files:**
- Modify: `package.json`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `docs/CONFIG.md`

**Interfaces:**
- Consumes: frontend build from Task 6
- Produces: Docker image serving `/admin`
- Produces: documented `ADMIN_TOKEN` and `DATA_DIR`

- [ ] **Step 1: Add root scripts for admin frontend**

Modify `package.json` scripts:

```json
{
  "build": "tsc",
  "build:admin": "npm --prefix frontend install && npm --prefix frontend run build",
  "build:all": "npm run build && npm run build:admin",
  "start": "node dist/index.js",
  "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
  "lint": "eslint src/**/*.ts",
  "test": "jest",
  "type-check": "tsc --noEmit",
  "format:check": "prettier --check \"src/**/*.{ts,js}\"",
  "test:coverage": "jest --coverage"
}
```

Preserve all existing package metadata and dependencies.

- [ ] **Step 2: Update Dockerfile to build admin assets**

Modify `Dockerfile`:

```dockerfile
FROM node:20-alpine

RUN apk add --no-cache bash git curl ripgrep

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY frontend/package*.json ./frontend/
COPY frontend/tsconfig.json ./frontend/
COPY frontend/vite.config.ts ./frontend/
COPY frontend/index.html ./frontend/

RUN npm ci --ignore-scripts
RUN npm --prefix frontend ci --ignore-scripts

COPY src/ ./src/
COPY frontend/src/ ./frontend/src/
COPY .env.example ./

RUN npm run build
RUN npm --prefix frontend run build

RUN npm prune --omit=dev && npm --prefix frontend prune --omit=dev

RUN mkdir -p /tmp/gitlab-claude-work /app/data

RUN addgroup -g 1001 -S claude && \
    adduser -S claude -u 1001

RUN mkdir -p /home/claude/.codex && \
    chown -R claude:claude /home/claude/.codex

RUN chown -R claude:claude /tmp/gitlab-claude-work /app

USER claude

ENV HOME=/home/claude
ENV DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Update compose environment and volumes**

Modify `docker-compose.yml` service environment and volumes:

```yaml
      - ADMIN_TOKEN=${ADMIN_TOKEN}
      - DATA_DIR=/app/data
```

Add the data volume under service volumes:

```yaml
      - ./data:/app/data
```

Keep the existing `logs` and `webhook-work` volumes.

- [ ] **Step 4: Update `.env.example`**

Add:

```bash
# Admin Console
ADMIN_TOKEN=change-me-admin-token
DATA_DIR=/app/data

# Runtime defaults
CLAUDE_DEFAULT_TIMEOUT_MINUTES=30
CODEX_DEFAULT_TIMEOUT_MINUTES=30
REVIEW_ENABLED=true
REVIEW_MIN_CONFIDENCE=80
REVIEW_MAX_CANDIDATE_FINDINGS=12
REVIEW_MAX_FINAL_FINDINGS=8
```

- [ ] **Step 5: Update docs**

In `docs/CONFIG.md`, add this section:

```markdown
## 管理后台配置

管理后台路径为 `/admin`，管理 API 前缀为 `/api/admin`。

必需变量：

| 配置项 | 说明 |
|--------|------|
| `ADMIN_TOKEN` | 管理后台登录密钥，请使用长随机字符串 |
| `DATA_DIR` | 运行时配置目录，Docker 默认 `/app/data` |

保存到管理后台的运行时配置位于 `${DATA_DIR}/runtime-config.json`。第一次启动时如果文件不存在，服务会从 `.env` 生成初始配置。

以下配置保存后立即影响新任务：

- 默认 Claude/Codex 模型
- 默认 Claude/Codex 超时时间
- Codex reasoning effort
- 默认 AI provider
- review confidence 阈值
- review candidate/final finding 数量
- GitLab/Claude/Codex token

以下配置需要重启：

- webhook 监听端口
- 工作目录
- Docker volume 和 Docker network
```

- [ ] **Step 6: Build everything locally**

Run:

```bash
npm run build:all
npm run type-check
npm test
```

Expected: all commands PASS.

- [ ] **Step 7: Build Docker image**

Run:

```bash
docker compose build gitlab-claude-webhook
```

Expected: image builds successfully and includes `dist/public/admin/index.html`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json Dockerfile docker-compose.yml .env.example docs/CONFIG.md
git commit -m "feat(admin): integrate admin frontend build and docker config"
```

## Task 8: Manual Verification And Release Notes

**Files:**
- Create: `docs/admin-console.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed admin UI and APIs
- Produces: operator documentation and manual test checklist

- [ ] **Step 1: Add admin console operator docs**

Create `docs/admin-console.md`:

```markdown
# Admin Console

The admin console is available at `/admin`.

## Authentication

Set `ADMIN_TOKEN` to a long random value. The browser stores this value locally and sends it as `X-Admin-Key` to `/api/admin/*`.

If `ADMIN_TOKEN` is not configured, admin APIs fail closed with HTTP 503.

## Runtime Config

The service stores runtime configuration in `${DATA_DIR}/runtime-config.json`.

On first startup, the service creates this file from environment variables.

The following changes affect new tasks immediately:

- Default provider
- Claude base URL, token, default model, default timeout
- Codex base URL, key, default model, reasoning effort, default timeout
- GitLab base URL and token
- Review enabled state
- Review confidence threshold
- Review candidate and final finding caps
- Log level

The following changes require restart:

- Webhook port
- Work directory
- Docker volume settings
- Docker network settings

## Manual Test Checklist

1. Open `/health` and verify it returns `status: healthy`.
2. Open `/admin` and enter the admin token.
3. Open Settings and change the Claude default model to a test value.
4. Save settings and verify the success message says new tasks use the configuration.
5. Refresh the page and verify the model value persists.
6. Run Test GitLab and verify it reports configured or missing token.
7. Run Test Claude and Test Codex and verify their status reflects configured secrets.
8. Change webhook port in the API payload and verify the response lists `webhook.port` under `requiresRestart`.
```

- [ ] **Step 2: Link admin docs from README**

Add to `README.md` under the Configuration section:

```markdown
### Admin Console

The service includes an authenticated admin console at `/admin` for runtime configuration.

Set `ADMIN_TOKEN` before enabling the console in production. Runtime settings are stored in `${DATA_DIR}/runtime-config.json` and are initialized from `.env` on first startup.

See [Admin Console Guide](docs/admin-console.md).
```

- [ ] **Step 3: Run final verification**

Run:

```bash
npm run build:all
npm run type-check
npm test
```

Expected: all commands PASS.

- [ ] **Step 4: Run local smoke test**

Run:

```bash
ADMIN_TOKEN=local-admin GITLAB_TOKEN=glpat-test WEBHOOK_SECRET=webhook-test ANTHROPIC_AUTH_TOKEN=anthropic-test PORT=3099 npm start
```

In another terminal:

```bash
curl -fsS http://127.0.0.1:3099/health
curl -fsS -H 'X-Admin-Key: local-admin' http://127.0.0.1:3099/api/admin/status
curl -fsS -H 'X-Admin-Key: local-admin' http://127.0.0.1:3099/api/admin/config
```

Expected:

- `/health` returns JSON with `"status":"healthy"`.
- `/api/admin/status` returns JSON with `"status":"ok"`.
- `/api/admin/config` returns masked secret status fields and does not include `glpat-test`, `webhook-test`, or `anthropic-test`.

- [ ] **Step 5: Commit**

```bash
git add docs/admin-console.md README.md
git commit -m "docs(admin): document admin console runtime config"
```

## Self-Review

Spec coverage:

- `/admin` management page is covered by Tasks 6 and 7.
- `/api/admin/*` management API is covered by Tasks 3 and 4.
- Admin authentication is covered by Task 3.
- Runtime configuration and hot-effective settings are covered by Tasks 2 and 5.
- Basic runtime status, masked configuration display, and connection tests are covered by Tasks 3 and 6.
- Docker persistence via `data/` is covered by Task 7.
- Prompt/Skill management is intentionally deferred to a separate plan.
- CodeRabbit provider integration is intentionally deferred to a separate plan.

Placeholder scan:

- This plan avoids forbidden placeholder wording and provides concrete file paths, code, commands, and expected results.
- Every code-changing step includes concrete file content or concrete code replacements.
- Every task has exact test commands and expected results.

Type consistency:

- `RuntimeConfig`, `PublicRuntimeConfig`, `RuntimeConfigPatch`, `ConfigUpdateResult`, and `ProviderTestResult` are defined in Task 2 and mirrored in Task 6.
- `RuntimeConfigService` is created in Task 2 and consumed by Tasks 3, 4, and 5.
- `createAdminAuthMiddleware` and `createAdminRouter` signatures are defined in Task 3 and consumed by Task 4.

## Follow-Up Plans

Create separate implementation plans after this plan lands:

1. `YYYY-MM-DD-admin-console-prompts-skills.md` for prompt templates, skill packs, review run storage, feedback, and prompt optimization proposals.
2. `YYYY-MM-DD-coderabbit-review-provider.md` for CodeRabbit CLI adapter, provider orchestration, normalized findings, and hybrid scoring.

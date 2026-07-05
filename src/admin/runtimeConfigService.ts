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
    return this.toPublicConfig(this.config);
  }

  private toPublicConfig(config: RuntimeConfig): PublicRuntimeConfig {
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
    await this.store.write(next);
    this.config = next;

    return {
      config: this.toPublicConfig(next),
      requiresRestart: this.restartRequiredFields(before, next),
    };
  }

  public async reload(): Promise<void> {
    const next = await this.store.read(createConfigFromEnv(this.options.env || process.env));
    this.validateConfig(next);
    this.config = next;
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

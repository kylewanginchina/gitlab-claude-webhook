import path from 'path';
import { JsonStore } from '../storage/jsonStore';
import { AIProvider, ClaudeReasoningEffort, ReasoningEffort } from '../types/common';
import { expandEnvVars } from '../utils/config';
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
const VALID_CLAUDE_REASONING_EFFORTS: ClaudeReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const VALID_AI_PROVIDERS: AIProvider[] = ['claude', 'codex'];
const VALID_REVIEW_PROVIDERS: RuntimeConfig['review']['defaultProvider'][] = [
  'claude-multipass',
  'codex-multipass',
];
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

type LogLevel = (typeof VALID_LOG_LEVELS)[number];
type ConfigSectionName = 'claude' | 'codex' | 'gitlab' | 'webhook' | 'ai' | 'review';

function envValue(env: NodeJS.ProcessEnv, key: string, defaultValue = ''): string {
  return expandEnvVars(env[key] || defaultValue, env);
}

function intValue(value: string, defaultValue: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function positiveIntValue(value: string, defaultValue: number): number {
  const parsed = intValue(value, defaultValue);
  return parsed > 0 ? parsed : defaultValue;
}

function providerValue(value: string): AIProvider {
  return value === 'codex' ? 'codex' : 'claude';
}

function reviewProviderValue(value: string): RuntimeConfig['review']['defaultProvider'] {
  return value === 'codex-multipass' ? 'codex-multipass' : 'claude-multipass';
}

function reasoningValue(value: string): ReasoningEffort {
  return VALID_REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : 'high';
}

function claudeReasoningValue(value: string): ClaudeReasoningEffort {
  return VALID_CLAUDE_REASONING_EFFORTS.includes(value as ClaudeReasoningEffort)
    ? (value as ClaudeReasoningEffort)
    : 'high';
}

function booleanEnvValue(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const fallback = defaultValue ? 'true' : 'false';
  return envValue(env, key, fallback) !== 'false';
}

function arrayEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: string[]
): string[] {
  const raw = envValue(env, key);
  if (!raw.trim()) {
    return [...defaultValue];
  }

  return raw
    .split(/[\n,]/)
    .map(value => value.trim())
    .filter(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    claude: {
      baseUrl: envValue(env, 'ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
      authToken: envValue(env, 'ANTHROPIC_AUTH_TOKEN'),
      defaultModel: envValue(env, 'CLAUDE_DEFAULT_MODEL', 'claude-sonnet-4-20250514'),
      reasoningEffort: claudeReasoningValue(envValue(env, 'CLAUDE_REASONING_EFFORT', 'high')),
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
      taskConcurrency: positiveIntValue(envValue(env, 'WEBHOOK_TASK_CONCURRENCY', '2'), 2),
    },
    ai: {
      defaultProvider: providerValue(envValue(env, 'AI_DEFAULT_PROVIDER', 'claude')),
    },
    review: {
      enabled: booleanEnvValue(env, 'REVIEW_ENABLED', true),
      defaultProvider: reviewProviderValue(
        envValue(env, 'REVIEW_DEFAULT_PROVIDER', 'claude-multipass')
      ),
      minConfidence: intValue(envValue(env, 'REVIEW_MIN_CONFIDENCE', '80'), 80),
      maxCandidateFindings: intValue(envValue(env, 'REVIEW_MAX_CANDIDATE_FINDINGS', '12'), 12),
      maxFinalFindings: intValue(envValue(env, 'REVIEW_MAX_FINAL_FINDINGS', '8'), 8),
      passConcurrency: intValue(envValue(env, 'REVIEW_PASS_CONCURRENCY', '4'), 4),
      scoringConcurrency: intValue(envValue(env, 'REVIEW_SCORING_CONCURRENCY', '4'), 4),
      skipDraft: booleanEnvValue(env, 'REVIEW_SKIP_DRAFT', true),
      skipExistingSha: booleanEnvValue(env, 'REVIEW_SKIP_EXISTING_SHA', true),
      allowedCommands: arrayEnvValue(env, 'REVIEW_ALLOWED_COMMANDS', ['/code-review']),
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
    this.config = this.applyDefaults(await this.store.read(fallback), fallback);
    this.validateConfig(this.config);
    await this.store.write(this.config);
    this.loaded = true;
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  public getConfig(): RuntimeConfig {
    return this.cloneConfig(this.config);
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
        reasoningEffort: config.claude.reasoningEffort,
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
        taskConcurrency: config.webhook.taskConcurrency,
      },
      ai: {
        ...config.ai,
      },
      review: {
        ...config.review,
        allowedCommands: [...config.review.allowedCommands],
      },
      workDir: config.workDir,
      logLevel: config.logLevel,
    };
  }

  public async updateConfig(patch: RuntimeConfigPatch, _actor: string): Promise<ConfigUpdateResult> {
    void _actor;
    const sanitizedPatch = this.sanitizePatch(patch);
    const before = this.config;
    const next: RuntimeConfig = {
      ...before,
      claude: {
        ...before.claude,
        ...this.cleanSecretPatch(sanitizedPatch.claude, 'authToken'),
      },
      codex: {
        ...before.codex,
        ...this.cleanSecretPatch(sanitizedPatch.codex, 'apiKey'),
      },
      gitlab: {
        ...before.gitlab,
        ...this.cleanSecretPatch(sanitizedPatch.gitlab, 'token'),
      },
      webhook: {
        ...before.webhook,
        ...this.cleanSecretPatch(sanitizedPatch.webhook, 'secret'),
      },
      ai: {
        ...before.ai,
        ...(sanitizedPatch.ai || {}),
      },
      review: {
        ...before.review,
        ...(sanitizedPatch.review || {}),
      },
      workDir: sanitizedPatch.workDir ?? before.workDir,
      logLevel: sanitizedPatch.logLevel ?? before.logLevel,
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
    const fallback = createConfigFromEnv(this.options.env || process.env);
    const next = this.applyDefaults(await this.store.read(fallback), fallback);
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
    this.assertAIProvider(config.ai.defaultProvider, 'ai.defaultProvider');
    this.assertReviewProvider(config.review.defaultProvider, 'review.defaultProvider');
    this.assertClaudeReasoningEffort(config.claude.reasoningEffort, 'claude.reasoningEffort');
    this.assertReasoningEffort(config.codex.reasoningEffort, 'codex.reasoningEffort');
    this.assertPositiveInteger(
      config.claude.defaultTimeoutMinutes,
      'claude.defaultTimeoutMinutes'
    );
    this.assertPositiveInteger(config.codex.defaultTimeoutMinutes, 'codex.defaultTimeoutMinutes');
    this.assertPort(config.webhook.port);
    this.assertPositiveInteger(config.webhook.taskConcurrency, 'webhook.taskConcurrency');
    this.assertMinConfidence(config.review.minConfidence);
    this.assertPositiveInteger(
      config.review.maxCandidateFindings,
      'review.maxCandidateFindings'
    );
    this.assertPositiveInteger(config.review.maxFinalFindings, 'review.maxFinalFindings');
    this.assertPositiveInteger(config.review.passConcurrency, 'review.passConcurrency');
    this.assertPositiveInteger(config.review.scoringConcurrency, 'review.scoringConcurrency');
    this.assertBoolean(config.review.enabled, 'review.enabled');
    this.assertBoolean(config.review.skipDraft, 'review.skipDraft');
    this.assertBoolean(config.review.skipExistingSha, 'review.skipExistingSha');
    this.assertAllowedCommands(config.review.allowedCommands);
    this.assertLogLevel(config.logLevel, 'logLevel');
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

  private cloneConfig(config: RuntimeConfig): RuntimeConfig {
    return JSON.parse(JSON.stringify(config)) as RuntimeConfig;
  }

  private sanitizePatch(patch: RuntimeConfigPatch): RuntimeConfigPatch {
    if (!isPlainObject(patch)) {
      throw new Error('runtime config patch must be an object');
    }

    const sanitized: RuntimeConfigPatch = {};
    const claude = this.getSectionPatch(patch, 'claude');
    if (claude) {
      const next: NonNullable<RuntimeConfigPatch['claude']> = {};
      if ('baseUrl' in claude) {
        next.baseUrl = this.assertString(claude.baseUrl, 'claude.baseUrl');
      }
      if ('authToken' in claude) {
        next.authToken = this.assertString(claude.authToken, 'claude.authToken');
      }
      if ('defaultModel' in claude) {
        next.defaultModel = this.assertString(claude.defaultModel, 'claude.defaultModel');
      }
      if ('reasoningEffort' in claude) {
        next.reasoningEffort = this.assertClaudeReasoningEffort(
          claude.reasoningEffort,
          'claude.reasoningEffort'
        );
      }
      if ('defaultTimeoutMinutes' in claude) {
        next.defaultTimeoutMinutes = this.assertPositiveInteger(
          claude.defaultTimeoutMinutes,
          'claude.defaultTimeoutMinutes'
        );
      }
      sanitized.claude = next;
    }

    const codex = this.getSectionPatch(patch, 'codex');
    if (codex) {
      const next: NonNullable<RuntimeConfigPatch['codex']> = {};
      if ('baseUrl' in codex) {
        next.baseUrl = this.assertString(codex.baseUrl, 'codex.baseUrl');
      }
      if ('apiKey' in codex) {
        next.apiKey = this.assertString(codex.apiKey, 'codex.apiKey');
      }
      if ('defaultModel' in codex) {
        next.defaultModel = this.assertString(codex.defaultModel, 'codex.defaultModel');
      }
      if ('reasoningEffort' in codex) {
        next.reasoningEffort = this.assertReasoningEffort(
          codex.reasoningEffort,
          'codex.reasoningEffort'
        );
      }
      if ('defaultTimeoutMinutes' in codex) {
        next.defaultTimeoutMinutes = this.assertPositiveInteger(
          codex.defaultTimeoutMinutes,
          'codex.defaultTimeoutMinutes'
        );
      }
      sanitized.codex = next;
    }

    const gitlab = this.getSectionPatch(patch, 'gitlab');
    if (gitlab) {
      const next: NonNullable<RuntimeConfigPatch['gitlab']> = {};
      if ('baseUrl' in gitlab) {
        next.baseUrl = this.assertString(gitlab.baseUrl, 'gitlab.baseUrl');
      }
      if ('token' in gitlab) {
        next.token = this.assertString(gitlab.token, 'gitlab.token');
      }
      sanitized.gitlab = next;
    }

    const webhook = this.getSectionPatch(patch, 'webhook');
    if (webhook) {
      const next: NonNullable<RuntimeConfigPatch['webhook']> = {};
      if ('secret' in webhook) {
        next.secret = this.assertString(webhook.secret, 'webhook.secret');
      }
      if ('port' in webhook) {
        next.port = this.assertPort(webhook.port);
      }
      if ('taskConcurrency' in webhook) {
        next.taskConcurrency = this.assertPositiveInteger(
          webhook.taskConcurrency,
          'webhook.taskConcurrency'
        );
      }
      sanitized.webhook = next;
    }

    const ai = this.getSectionPatch(patch, 'ai');
    if (ai) {
      const next: NonNullable<RuntimeConfigPatch['ai']> = {};
      if ('defaultProvider' in ai) {
        next.defaultProvider = this.assertAIProvider(ai.defaultProvider, 'ai.defaultProvider');
      }
      sanitized.ai = next;
    }

    const review = this.getSectionPatch(patch, 'review');
    if (review) {
      const next: NonNullable<RuntimeConfigPatch['review']> = {};
      if ('enabled' in review) {
        next.enabled = this.assertBoolean(review.enabled, 'review.enabled');
      }
      if ('defaultProvider' in review) {
        next.defaultProvider = this.assertReviewProvider(
          review.defaultProvider,
          'review.defaultProvider'
        );
      }
      if ('minConfidence' in review) {
        next.minConfidence = this.assertMinConfidence(review.minConfidence);
      }
      if ('maxCandidateFindings' in review) {
        next.maxCandidateFindings = this.assertPositiveInteger(
          review.maxCandidateFindings,
          'review.maxCandidateFindings'
        );
      }
      if ('maxFinalFindings' in review) {
        next.maxFinalFindings = this.assertPositiveInteger(
          review.maxFinalFindings,
          'review.maxFinalFindings'
        );
      }
      if ('passConcurrency' in review) {
        next.passConcurrency = this.assertPositiveInteger(
          review.passConcurrency,
          'review.passConcurrency'
        );
      }
      if ('scoringConcurrency' in review) {
        next.scoringConcurrency = this.assertPositiveInteger(
          review.scoringConcurrency,
          'review.scoringConcurrency'
        );
      }
      if ('skipDraft' in review) {
        next.skipDraft = this.assertBoolean(review.skipDraft, 'review.skipDraft');
      }
      if ('skipExistingSha' in review) {
        next.skipExistingSha = this.assertBoolean(
          review.skipExistingSha,
          'review.skipExistingSha'
        );
      }
      if ('allowedCommands' in review) {
        next.allowedCommands = this.assertAllowedCommands(review.allowedCommands);
      }
      sanitized.review = next;
    }

    if ('workDir' in patch) {
      sanitized.workDir = this.assertString(patch.workDir, 'workDir');
    }
    if ('logLevel' in patch) {
      sanitized.logLevel = this.assertLogLevel(patch.logLevel, 'logLevel');
    }

    return sanitized;
  }

  private getSectionPatch(
    patch: RuntimeConfigPatch,
    section: ConfigSectionName
  ): Record<string, unknown> | undefined {
    if (!(section in patch)) {
      return undefined;
    }

    const value = patch[section];
    if (!isPlainObject(value)) {
      throw new Error(`${section} section must be an object`);
    }

    return value;
  }

  private assertString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }

    return value;
  }

  private applyDefaults(config: RuntimeConfig, fallback: RuntimeConfig): RuntimeConfig {
    return {
      ...fallback,
      ...config,
      claude: {
        ...fallback.claude,
        ...(config.claude || {}),
      },
      codex: {
        ...fallback.codex,
        ...(config.codex || {}),
      },
      gitlab: {
        ...fallback.gitlab,
        ...(config.gitlab || {}),
      },
      webhook: {
        ...fallback.webhook,
        ...(config.webhook || {}),
      },
      ai: {
        ...fallback.ai,
        ...(config.ai || {}),
      },
      review: {
        ...fallback.review,
        ...(config.review || {}),
      },
    };
  }

  private assertBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== 'boolean') {
      throw new Error(`${fieldName} must be a boolean`);
    }

    return value;
  }

  private assertPositiveInteger(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${fieldName} must be at least 1`);
    }

    return value;
  }

  private assertPort(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error('webhook.port must be between 1 and 65535');
    }

    return value;
  }

  private assertMinConfidence(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error('review.minConfidence must be between 0 and 100');
    }

    return value;
  }

  private assertAIProvider(value: unknown, fieldName: string): AIProvider {
    if (!VALID_AI_PROVIDERS.includes(value as AIProvider)) {
      throw new Error(`${fieldName} must be one of: claude, codex`);
    }

    return value as AIProvider;
  }

  private assertReviewProvider(
    value: unknown,
    fieldName: string
  ): RuntimeConfig['review']['defaultProvider'] {
    if (!VALID_REVIEW_PROVIDERS.includes(value as RuntimeConfig['review']['defaultProvider'])) {
      throw new Error(
        `${fieldName} must be one of: claude-multipass, codex-multipass`
      );
    }

    return value as RuntimeConfig['review']['defaultProvider'];
  }

  private assertReasoningEffort(value: unknown, fieldName: string): ReasoningEffort {
    if (!VALID_REASONING_EFFORTS.includes(value as ReasoningEffort)) {
      throw new Error(
        `${fieldName} must be one of: minimal, low, medium, high, xhigh`
      );
    }

    return value as ReasoningEffort;
  }

  private assertClaudeReasoningEffort(
    value: unknown,
    fieldName: string
  ): ClaudeReasoningEffort {
    if (!VALID_CLAUDE_REASONING_EFFORTS.includes(value as ClaudeReasoningEffort)) {
      throw new Error(`${fieldName} must be one of: low, medium, high, xhigh, max`);
    }

    return value as ClaudeReasoningEffort;
  }

  private assertAllowedCommands(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(command => typeof command !== 'string')) {
      throw new Error('review.allowedCommands must be an array of strings');
    }

    const normalized = value.map(command => command.trim()).filter(Boolean);
    if (normalized.length !== value.length) {
      throw new Error('review.allowedCommands must be an array of strings');
    }

    return normalized;
  }

  private assertLogLevel(value: unknown, fieldName: string): LogLevel {
    if (!VALID_LOG_LEVELS.includes(value as LogLevel)) {
      throw new Error(`${fieldName} must be one of: debug, info, warn, error`);
    }

    return value as LogLevel;
  }
}

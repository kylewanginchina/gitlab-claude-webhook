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

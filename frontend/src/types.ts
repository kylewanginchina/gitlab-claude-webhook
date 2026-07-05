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

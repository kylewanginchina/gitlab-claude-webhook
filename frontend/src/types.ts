export interface SecretStatus {
  configured: boolean;
  masked: string;
}

export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface PublicRuntimeConfig {
  claude: {
    baseUrl: string;
    authToken: SecretStatus;
    defaultModel: string;
    reasoningEffort: ClaudeReasoningEffort;
    defaultTimeoutMinutes: number;
  };
  codex: {
    baseUrl: string;
    apiKey: SecretStatus;
    defaultModel: string;
    reasoningEffort: CodexReasoningEffort;
    defaultTimeoutMinutes: number;
  };
  gitlab: {
    baseUrl: string;
    token: SecretStatus;
  };
  webhook: {
    secret: SecretStatus;
    port: number;
    taskConcurrency: number;
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
    reasoningEffort: ClaudeReasoningEffort;
    defaultTimeoutMinutes: number;
  }>;
  codex: Partial<{
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    reasoningEffort: CodexReasoningEffort;
    defaultTimeoutMinutes: number;
  }>;
  gitlab: Partial<{
    baseUrl: string;
    token: string;
  }>;
  webhook: Partial<{
    secret: string;
    port: number;
    taskConcurrency: number;
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

export type ReviewPromptProvider = 'claude' | 'codex' | 'coderabbit' | 'any';
export type PromptTemplateProvider = 'claude' | 'codex' | 'review' | 'shared';
export type PromptTemplateScope = 'edit' | 'review' | 'context' | 'fallback' | 'pass' | 'scoring';

export interface PromptTemplateDraft {
  body: string;
}

export interface PromptTemplateVersion extends PromptTemplateDraft {
  version: number;
  createdAt: string;
  createdBy: string;
  changelog: string;
}

export interface PromptTemplate {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  provider: PromptTemplateProvider;
  scope: PromptTemplateScope;
  currentVersion: number;
  draft: PromptTemplateDraft;
  versions: PromptTemplateVersion[];
  defaultBody: string;
  createdAt: string;
  updatedAt: string;
}

export type PromptTemplatePatch = Partial<{
  label: string;
  description: string;
  enabled: boolean;
  provider: PromptTemplateProvider;
  scope: PromptTemplateScope;
  draft: Partial<PromptTemplateDraft>;
}>;

export interface ReviewPromptDraft {
  focus: string[];
  systemInstructions: string;
}

export interface ReviewPromptVersion extends ReviewPromptDraft {
  version: number;
  createdAt: string;
  createdBy: string;
  changelog: string;
}

export interface ReviewPrompt {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  provider: ReviewPromptProvider;
  currentVersion: number;
  draft: ReviewPromptDraft;
  versions: ReviewPromptVersion[];
  createdAt: string;
  updatedAt: string;
}

export type ReviewPromptPatch = Partial<{
  label: string;
  description: string;
  enabled: boolean;
  provider: ReviewPromptProvider;
  draft: Partial<ReviewPromptDraft>;
}>;

export interface ReviewSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  provider: ReviewPromptProvider;
  fileGlobs: string[];
  languageHints: string[];
  promptIds: string[];
  systemInstructions: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export type ReviewSkillInput = Partial<{
  description: string;
  provider: ReviewPromptProvider;
  fileGlobs: string[];
  languageHints: string[];
  promptIds: string[];
  priority: number;
  enabled: boolean;
}> & {
  name: string;
  systemInstructions: string;
};

export interface ReviewFeedback {
  id: string;
  reviewRunId?: string;
  findingKey?: string;
  promptId?: string;
  label: 'useful' | 'false_positive' | 'missed_issue' | 'unclear' | 'accepted' | 'rejected';
  note: string;
  source: 'admin' | 'gitlab-comment' | 'gitlab-resolution';
  createdAt: string;
}

export type ReviewFeedbackInput = Partial<{
  reviewRunId: string;
  findingKey: string;
  promptId: string;
  source: ReviewFeedback['source'];
  note: string;
}> & {
  label: ReviewFeedback['label'];
};

export interface PromptOptimizationProposal {
  id: string;
  promptId: string;
  baseVersion: number;
  title: string;
  rationale: string;
  suggestedDraft: ReviewPromptDraft;
  feedbackIds: string[];
  status: 'open' | 'applied' | 'dismissed';
  createdAt: string;
  appliedAt?: string;
  dismissedAt?: string;
}

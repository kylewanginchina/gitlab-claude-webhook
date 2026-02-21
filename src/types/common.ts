import { GitLabWebhookEvent } from './gitlab';

// AI Provider type
export type AIProvider = 'claude' | 'codex';

export interface AIExecutionContext {
  context: string;
  projectUrl: string;
  branch: string;
  timeoutMs?: number;
  event: GitLabWebhookEvent;
  instruction: string;
  model?: string;
}

export interface StreamingProgressCallback {
  onProgress: (message: string, isComplete?: boolean) => Promise<void>;
  onError: (error: string) => Promise<void>;
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface Config {
  anthropic: {
    baseUrl: string;
    authToken: string;
    defaultModel: string;
  };
  openai: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    reasoningEffort: ReasoningEffort;
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
  workDir: string;
  logLevel: string;
}

export interface ProcessResult {
  success: boolean;
  output?: string;
  error?: string;
  changes?: FileChange[];
}

export interface FileChange {
  path: string;
  type: 'modified' | 'created' | 'deleted';
  diff?: string;
}

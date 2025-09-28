// AI Provider type
export type AIProvider = 'claude' | 'codex';

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
  systemPromptAppend?: string;
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

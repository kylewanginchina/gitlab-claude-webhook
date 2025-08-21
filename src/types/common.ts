export interface Config {
  anthropic: {
    baseUrl: string;
    authToken: string;
  };
  gitlab: {
    baseUrl: string;
    token: string;
  };
  webhook: {
    secret: string;
    port: number;
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

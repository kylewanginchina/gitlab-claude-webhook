import { Config, AIProvider } from '../types/common';

/**
 * Expand environment variables in a string
 * Supports ${VAR} and $VAR syntax
 */
function expandEnvVars(str: string): string {
  if (!str) return str;

  return str.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi, (match, braced, unbraced) => {
    const varName = braced || unbraced;
    return process.env[varName] || match;
  });
}

/**
 * Get environment variable with expansion support
 */
function getEnvVar(key: string, defaultValue: string = ''): string {
  const value = process.env[key] || defaultValue;
  return expandEnvVars(value);
}

/**
 * Get AI provider from environment with validation
 */
function getAIProvider(key: string, defaultValue: AIProvider): AIProvider {
  const value = getEnvVar(key, defaultValue);
  if (value === 'claude' || value === 'codex') {
    return value;
  }
  return defaultValue;
}

export const config: Config = {
  anthropic: {
    baseUrl: getEnvVar('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    authToken: getEnvVar('ANTHROPIC_AUTH_TOKEN'),
    defaultModel: getEnvVar('CLAUDE_DEFAULT_MODEL', 'claude-sonnet-4-20250514'),
  },
  openai: {
    baseUrl: getEnvVar('OPENAI_BASE_URL', 'https://api.openai.com'),
    apiKey: getEnvVar('OPENAI_API_KEY'),
    defaultModel: getEnvVar('CODEX_DEFAULT_MODEL', 'gpt-5.1-codex-max'),
    reasoningEffort: getEnvVar('CODEX_REASONING_EFFORT', 'high'),
  },
  gitlab: {
    baseUrl: getEnvVar('GITLAB_BASE_URL', 'https://gitlab.com'),
    token: getEnvVar('GITLAB_TOKEN'),
  },
  webhook: {
    secret: getEnvVar('WEBHOOK_SECRET'),
    port: parseInt(getEnvVar('PORT', '3000')),
  },
  ai: {
    defaultProvider: getAIProvider('AI_DEFAULT_PROVIDER', 'claude'),
  },
  workDir: getEnvVar('WORK_DIR', '/tmp/gitlab-claude-work'),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
};

import { Config } from '../types/common';

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

export const config: Config = {
  anthropic: {
    baseUrl: getEnvVar('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    authToken: getEnvVar('ANTHROPIC_AUTH_TOKEN'),
  },
  gitlab: {
    baseUrl: getEnvVar('GITLAB_BASE_URL', 'https://gitlab.com'),
    token: getEnvVar('GITLAB_TOKEN'),
  },
  webhook: {
    secret: getEnvVar('WEBHOOK_SECRET'),
    port: parseInt(getEnvVar('PORT', '3000')),
  },
  workDir: getEnvVar('WORK_DIR', '/tmp/gitlab-claude-work'),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  claudeSystemPrompt: getEnvVar('CLAUDE_SYSTEM_PROMPT',''),
};

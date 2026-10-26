const PROVIDER_ENVIRONMENT_KEYS = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
]);

export function sanitizeProviderEnvironment(
  environment: NodeJS.ProcessEnv
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !PROVIDER_ENVIRONMENT_KEYS.has(entry[0])
    )
  );
}

const baseExecutionEnvironment: Readonly<Record<string, string>> = Object.freeze(
  sanitizeProviderEnvironment(process.env)
);

export function createClaudeExecutionEnvironment(
  authToken: string,
  baseUrl: string,
  sessionId: string
): Record<string, string> {
  const customHeaders = (baseExecutionEnvironment.ANTHROPIC_CUSTOM_HEADERS || '')
    .split(/\r?\n/)
    .filter(
      header =>
        header.trim() !== '' && header.split(':', 1)[0].trim().toLowerCase() !== 'session-id'
    );

  return {
    ...baseExecutionEnvironment,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_CUSTOM_HEADERS: [...customHeaders, `Session-Id: ${sessionId}`].join('\n'),
  };
}

export function createCodexExecutionEnvironment(apiKey: string): Record<string, string> {
  return {
    ...baseExecutionEnvironment,
    OPENAI_API_KEY: apiKey,
    CODEX_API_KEY: apiKey,
  };
}

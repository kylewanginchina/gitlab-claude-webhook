import { sanitizeProviderEnvironment } from '../utils/providerEnvironment';

describe('provider execution environment', () => {
  it('removes inherited provider credentials and endpoints from the cached base environment', () => {
    const sanitized = sanitizeProviderEnvironment({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/claude',
      ANTHROPIC_AUTH_TOKEN: 'stale-anthropic-auth-token',
      ANTHROPIC_API_KEY: 'stale-anthropic-api-key',
      ANTHROPIC_BASE_URL: 'https://stale-claude.example',
      CLAUDE_CODE_OAUTH_TOKEN: 'stale-claude-oauth-token',
      OPENAI_API_KEY: 'stale-openai-api-key',
      OPENAI_BASE_URL: 'https://stale-openai.example/v1',
      CODEX_API_KEY: 'stale-codex-api-key',
      CODEX_ACCESS_TOKEN: 'stale-codex-access-token',
    });

    expect(sanitized).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/claude',
    });
  });
});

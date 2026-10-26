import { sanitizeProviderEnvironment } from '../utils/providerEnvironment';

describe('provider execution environment', () => {
  const inheritedCustomHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;

  afterEach(() => {
    if (inheritedCustomHeaders === undefined) {
      delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    } else {
      process.env.ANTHROPIC_CUSTOM_HEADERS = inheritedCustomHeaders;
    }
  });

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

  it.each([
    {
      name: 'no inherited headers',
      customHeaders: undefined,
      preservedHeaders: [],
    },
    {
      name: 'unrelated headers containing colons',
      customHeaders: 'X-Proxy-Route: codex\nX-Trace: scheme:value',
      preservedHeaders: ['X-Proxy-Route: codex', 'X-Trace: scheme:value'],
    },
    {
      name: 'duplicate session headers with mixed case and CRLF',
      customHeaders:
        'X-Proxy-Route: codex\r\nsession-id: stale-one\r\n SESSION-ID : stale-two\r\n\r\nX-Trace: scheme:value',
      preservedHeaders: ['X-Proxy-Route: codex', 'X-Trace: scheme:value'],
    },
  ])(
    'binds each Claude environment to its session with $name',
    ({ customHeaders, preservedHeaders }) => {
      if (customHeaders === undefined) {
        delete process.env.ANTHROPIC_CUSTOM_HEADERS;
      } else {
        process.env.ANTHROPIC_CUSTOM_HEADERS = customHeaders;
      }

      jest.isolateModules(() => {
        const { createClaudeExecutionEnvironment } = jest.requireActual(
          '../utils/providerEnvironment'
        );
        const firstSession = '11111111-1111-4111-8111-111111111111';
        const secondSession = '22222222-2222-4222-8222-222222222222';
        const first = createClaudeExecutionEnvironment(
          'runtime-token',
          'https://claude.example',
          firstSession
        );
        const second = createClaudeExecutionEnvironment(
          'runtime-token',
          'https://claude.example',
          secondSession
        );

        expect(first.ANTHROPIC_CUSTOM_HEADERS).toBe(
          [...preservedHeaders, `Session-Id: ${firstSession}`].join('\n')
        );
        expect(second.ANTHROPIC_CUSTOM_HEADERS).toBe(
          [...preservedHeaders, `Session-Id: ${secondSession}`].join('\n')
        );
        expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(customHeaders);
        expect(first).not.toBe(second);
      });
    }
  );
});

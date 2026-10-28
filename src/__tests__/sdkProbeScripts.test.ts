import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

interface CapturedQuery {
  prompt: string;
  options: {
    sessionId?: string;
    env: Record<string, string>;
    [key: string]: unknown;
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function executeScript(
  filename: string,
  environment: NodeJS.ProcessEnv = {},
  args: string[] = []
): Promise<CapturedQuery[]> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe-contract-'));
  const dummyEnvironment = {
    ANTHROPIC_AUTH_TOKEN: 'dummy-token',
    ANTHROPIC_BASE_URL: 'https://claude.invalid',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Trace: contract-test\nsession-id: inherited-session',
    CLAUDE_DEFAULT_MODEL: 'dummy-model',
    LOG_DIR: temporaryDirectory,
    DATA_DIR: temporaryDirectory,
    REVIEW_SKILLS_DIR: path.join(temporaryDirectory, 'unused-skills'),
    ...environment,
  };
  const originalEnvironment = process.env;
  const queries: CapturedQuery[] = [];
  const scriptConsole = { log: jest.fn(), error: jest.fn() };
  const scriptPath = path.resolve(__dirname, '../../scripts', filename);
  const source = fs.readFileSync(scriptPath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: scriptPath,
  });
  let closeLogger: (() => void) | undefined;

  try {
    process.env = dummyEnvironment;
    let completion: unknown;
    jest.isolateModules(() => {
      const providerEnvironment = jest.requireActual('../utils/providerEnvironment');
      const reviewService = jest.requireActual('../services/gitlabReviewService');
      const logger = jest.requireActual('../utils/logger').default;
      closeLogger = (): void => logger.close();
      const sdk = {
        query(input: CapturedQuery): AsyncIterable<unknown> {
          queries.push(input);
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
              yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0 };
            },
          };
        },
      };
      completion = new vm.Script(compiled.outputText, { filename: scriptPath }).runInNewContext({
        exports: {},
        __dirname: path.dirname(scriptPath),
        console: scriptConsole,
        process: {
          env: dummyEnvironment,
          argv: ['node', scriptPath, ...args],
          cwd: () => path.resolve(__dirname, '../..'),
          stdout: { write: jest.fn() },
          exit(code: number): never {
            throw new Error(`Script exited with ${code}`);
          },
        },
        require(moduleName: string): unknown {
          if (moduleName === 'dotenv/config') return {}; // Never load .env in contract tests.
          if (moduleName === '@anthropic-ai/claude-agent-sdk') return sdk;
          if (moduleName === '../src/utils/providerEnvironment') return providerEnvironment;
          if (moduleName === '../src/services/gitlabReviewService') return reviewService;
          if (['fs', 'path', 'crypto', 'uuid'].includes(moduleName)) {
            return jest.requireActual(moduleName);
          }
          throw new Error(`Unexpected script import: ${moduleName}`);
        },
      });
    });
    await completion;
    expect(scriptConsole.error).not.toHaveBeenCalled();
    return queries;
  } finally {
    process.env = originalEnvironment;
    closeLogger?.();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function expectBoundSession(query: CapturedQuery): void {
  expect(query.options.sessionId).toEqual(expect.stringMatching(UUID_PATTERN));
  expect(query.options.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
    `X-Trace: contract-test\nSession-Id: ${query.options.sessionId}`
  );
  expect(query.options.env.ANTHROPIC_AUTH_TOKEN).toBe('dummy-token');
  expect(query.options.env.ANTHROPIC_BASE_URL).toBe('https://claude.invalid');
  expect(query.options.model).toBe('dummy-model');
}

describe('direct SDK probe script sessions', () => {
  it('binds the Skill-tool probe query to a fresh session', async () => {
    const first = await executeScript('skill-probe.ts');
    const second = await executeScript('skill-probe.ts');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    [...first, ...second].forEach(expectBoundSession);
    expect(first[0].options.sessionId).not.toBe(second[0].options.sessionId);
    expect(first[0].options.tools).toEqual(['Read', 'Skill']);
    expect(first[0].options.maxTurns).toBe(6);
  });

  it.each(['slash', 'agent'])('binds the %s-mode probe query to a fresh session', async mode => {
    const queries = await executeScript('skill-slash-probe.ts', { PROBE_MODE: mode });
    expect(queries).toHaveLength(1);
    expectBoundSession(queries[0]);
    expect(queries[0].options.tools).toEqual(['Read', 'Skill']);
    expect(queries[0].options.maxTurns).toBe(3);
    expect(queries[0].options.agent).toBe(mode === 'agent' ? 'gitlab-reviewer' : undefined);
  });

  it('uses distinct bound sessions for both smoke runs with --max-turns-check', async () => {
    const queries = await executeScript('skill-smoke.ts', {}, ['--max-turns-check']);
    expect(queries).toHaveLength(2);
    queries.forEach(expectBoundSession);
    expect(queries[0].options.sessionId).not.toBe(queries[1].options.sessionId);
    expect(queries.map(query => query.options.maxTurns)).toEqual([30, 2]);
    expect(queries[0].options.tools).toEqual(['Bash', 'Read', 'Glob', 'Grep']);
    expect(queries[0].options.outputFormat).toMatchObject({ type: 'json_schema' });
  });
});

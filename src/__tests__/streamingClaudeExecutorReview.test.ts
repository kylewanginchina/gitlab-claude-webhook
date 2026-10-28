import type { RuntimeConfig } from '../admin/adminTypes';
import type { AIExecutionContext, StreamingProgressCallback } from '../types/common';
import type { GitLabWebhookEvent } from '../types/gitlab';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockQuery = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

jest.mock('../utils/config', () => ({
  expandEnvVars: (value: string) => value,
  config: {
    anthropic: {
      baseUrl: 'https://claude.static.example',
      authToken: 'anthropic-static-token',
      defaultModel: 'claude-static-model',
      reasoningEffort: 'high',
    },
    openai: {
      baseUrl: 'https://codex.static.example/v1',
      apiKey: 'openai-static-key',
      defaultModel: 'codex-static-model',
      reasoningEffort: 'high',
    },
    gitlab: { baseUrl: 'https://gitlab.static.example', token: 'glpat-static-token' },
    webhook: { secret: 'webhook-static-secret', port: 3000, taskConcurrency: 2 },
    ai: { defaultProvider: 'claude' },
    workDir: '/tmp/static-workdir',
    logLevel: 'info',
  },
}));

import { runtimeConfigService } from '../utils/runtimeConfig';
import logger from '../utils/logger';
import { StreamingClaudeExecutor } from '../services/streamingClaudeExecutor';
import { ReviewSkillCatalog } from '../services/reviewSkillCatalog';
import { reviewCustomizationService } from '../utils/reviewCustomization';
import { REVIEW_PASS_OUTPUT_SCHEMA } from '../services/gitlabReviewService';

const REPO_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'review-skills');

function createRuntimeConfig(review: Partial<RuntimeConfig['review']> = {}): RuntimeConfig {
  return {
    claude: {
      baseUrl: 'https://claude.runtime.example',
      authToken: 'anthropic-runtime-token',
      defaultModel: 'claude-runtime-model',
      reasoningEffort: 'high',
      defaultTimeoutMinutes: 30,
    },
    codex: {
      baseUrl: 'https://codex.runtime.example/v1',
      apiKey: 'openai-runtime-key',
      defaultModel: 'codex-runtime-model',
      reasoningEffort: 'high',
      defaultTimeoutMinutes: 30,
    },
    gitlab: { baseUrl: 'https://gitlab.runtime.example', token: 'glpat-runtime-token' },
    webhook: { secret: 'webhook-runtime-secret', port: 3000, taskConcurrency: 2 },
    ai: { defaultProvider: 'claude' },
    review: {
      enabled: true,
      defaultProvider: 'claude-multipass',
      minConfidence: 80,
      maxCandidateFindings: 12,
      maxFinalFindings: 8,
      passConcurrency: 4,
      scoringConcurrency: 4,
      skipDraft: true,
      skipExistingSha: true,
      allowedCommands: ['/code-review'],
      useBuiltinSkills: true,
      structuredOutput: true,
      passMaxTurns: 40,
      scoringMaxTurns: 20,
      ...review,
    },
    workDir: '/tmp/gitlab-claude-work',
    logLevel: 'info',
  };
}

function createCallback(): StreamingProgressCallback {
  return {
    onProgress: jest.fn().mockResolvedValue(undefined),
    onError: jest.fn().mockResolvedValue(undefined),
  };
}

function createAsyncGenerator<T>(items: T[]): AsyncGenerator<T, void, void> {
  return (async function* () {
    for (const item of items) {
      yield item;
    }
  })();
}

function createReviewContext(overrides: Partial<AIExecutionContext> = {}): AIExecutionContext {
  return {
    context: 'MR #7: Review',
    projectUrl: 'https://gitlab.example.com/group/project',
    branch: 'feature/test',
    event: { object_kind: 'note' } as GitLabWebhookEvent,
    instruction: 'Review the merge request',
    mode: 'review',
    ...overrides,
  };
}

function successResult(extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Prose summary that should be ignored when structured output exists',
    total_cost_usd: 0,
    num_turns: 3,
    duration_ms: 10,
    ...extra,
  };
}

describe('StreamingClaudeExecutor review mode SDK options', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    jest.restoreAllMocks();
  });

  it('loads the skill plugin, enables requested skills, and requests structured output', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    const structured = { summary: 'ok', findings: [] };
    mockQuery.mockImplementation(() =>
      createAsyncGenerator([successResult({ structured_output: structured })])
    );

    const executor = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(REPO_SKILLS_DIR)
    );
    const result = await executor.executeWithStreaming(
      'Review pass prompt',
      '/tmp/project',
      createReviewContext({
        skills: ['mr-review-core', 'typescript-review', 'not-a-real-skill'],
        skillCommand: '/gitlab-review:mr-review-core',
        outputSchema: REVIEW_PASS_OUTPUT_SCHEMA,
        maxTurns: 17,
      }),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(JSON.stringify(structured));

    const { prompt, options } = mockQuery.mock.calls[0][0];
    // The slash command must be the very first thing the SDK sees, ahead of the context wrapper.
    expect(prompt.startsWith('/gitlab-review:mr-review-core\n\n')).toBe(true);
    expect(prompt).toContain('Review pass prompt');
    expect(options.settingSources).toEqual(['project']);
    expect(options.plugins).toEqual([{ type: 'local', path: REPO_SKILLS_DIR }]);
    expect(options.skills).toEqual(['mr-review-core', 'typescript-review']);
    expect(options.tools).toEqual(['Bash', 'Read', 'Glob', 'Grep']);
    expect(options.maxTurns).toBe(17);
    expect(options.outputFormat).toEqual({
      type: 'json_schema',
      schema: REVIEW_PASS_OUTPUT_SCHEMA,
    });
  });

  it('keeps structured findings containing validation-like text without another SDK call', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    const structured = {
      summary: 'Parser regression',
      findings: [
        {
          title: 'Dropped input',
          body: 'A valid input failed to parse and is dropped.',
          confidence: 90,
          path: 'src/parser.ts',
          line: 3,
          line_type: 'old',
          category: 'bug',
        },
      ],
    };
    mockQuery.mockImplementation(() =>
      createAsyncGenerator([successResult({ structured_output: structured })])
    );

    const result = await new StreamingClaudeExecutor().executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({ outputSchema: REVIEW_PASS_OUTPUT_SCHEMA }),
      createCallback()
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, output: JSON.stringify(structured) });
  });

  it.each(['structured', 'raw JSON', 'fenced JSON'])(
    'returns authoritative %s after a validation failure',
    async format => {
      jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
      const structured = { summary: 'Static inspection complete', findings: [] };
      const json = JSON.stringify(structured);
      const recovery =
        format === 'structured'
          ? successResult({ structured_output: structured })
          : successResult({
              result: format === 'fenced JSON' ? '```json\n' + json + '\n```' : json,
            });
      mockQuery
        .mockImplementationOnce(() =>
          createAsyncGenerator([successResult({ result: 'npm test failed with exit code 1' })])
        )
        .mockImplementationOnce(() => createAsyncGenerator([recovery]));

      const result = await new StreamingClaudeExecutor().executeWithStreaming(
        'Review',
        '/tmp/project',
        createReviewContext({ outputSchema: REVIEW_PASS_OUTPUT_SCHEMA }),
        createCallback()
      );

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.output).toBe(format === 'fenced JSON' ? '```json\n' + json + '\n```' : json);
    }
  );

  it('rejects an unknown review skill command even when the SDK reports success', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() =>
      createAsyncGenerator([
        successResult({ result: 'Unknown command: gitlab-review:mr-review-core' }),
      ])
    );

    const result = await new StreamingClaudeExecutor().executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({
        skillCommand: '/gitlab-review:mr-review-core',
        outputSchema: REVIEW_PASS_OUTPUT_SCHEMA,
      }),
      createCallback()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown command:');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown review skill command during static recovery', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery
      .mockImplementationOnce(() =>
        createAsyncGenerator([successResult({ result: 'npm test failed with exit code 1' })])
      )
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          successResult({ result: 'Unknown command: gitlab-review:mr-review-core' }),
        ])
      );

    const result = await new StreamingClaudeExecutor().executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({ outputSchema: REVIEW_PASS_OUTPUT_SCHEMA }),
      createCallback()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown command:');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('accepts legacy fenced JSON when structured output was requested', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    const output = '```json\n{"summary":"Legacy result", "findings":[]}\n```';
    mockQuery.mockImplementation(() => createAsyncGenerator([successResult({ result: output })]));

    const result = await new StreamingClaudeExecutor().executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({ outputSchema: REVIEW_PASS_OUTPUT_SCHEMA }),
      createCallback()
    );

    expect(result).toMatchObject({ success: true, output });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('defaults to the always-on skills when the context does not name any', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() => createAsyncGenerator([successResult()]));

    const executor = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(REPO_SKILLS_DIR)
    );
    const result = await executor.executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext(),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Prose summary');
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.skills).toEqual(['mr-review-core']);
    expect(options.outputFormat).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
  });

  it('omits plugins and the skill command when built-in skills are disabled or unavailable', async () => {
    jest
      .spyOn(runtimeConfigService, 'getConfig')
      .mockReturnValue(createRuntimeConfig({ useBuiltinSkills: false, structuredOutput: false }));
    mockQuery.mockImplementation(() => createAsyncGenerator([successResult()]));

    const executor = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(REPO_SKILLS_DIR)
    );
    await executor.executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({
        skills: ['mr-review-core'],
        skillCommand: '/gitlab-review:mr-review-core',
        outputSchema: REVIEW_PASS_OUTPUT_SCHEMA,
      }),
      createCallback()
    );

    let { prompt, options } = mockQuery.mock.calls[0][0];
    // Without the plugin the command would reach the model as literal text, so it is dropped.
    expect(prompt.startsWith('/')).toBe(false);
    expect(options.plugins).toBeUndefined();
    expect(options.skills).toBeUndefined();
    expect(options.tools).toEqual(['Bash', 'Read', 'Glob', 'Grep']);
    expect(options.outputFormat).toBeUndefined();
    expect(options.settingSources).toEqual(['project']);

    mockQuery.mockClear();
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-skills-'));
    const noSkills = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(emptyDir)
    );
    await noSkills.executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({
        skills: ['mr-review-core'],
        skillCommand: '/gitlab-review:mr-review-core',
      }),
      createCallback()
    );
    ({ prompt, options } = mockQuery.mock.calls[0][0]);
    expect(prompt.startsWith('/')).toBe(false);
    expect(options.plugins).toBeUndefined();
    expect(options.tools).toEqual(['Bash', 'Read', 'Glob', 'Grep']);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('warns when structured output was requested but the run returned prose only', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() => createAsyncGenerator([successResult()]));
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    const executor = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(REPO_SKILLS_DIR)
    );
    const result = await executor.executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({ outputSchema: REVIEW_PASS_OUTPUT_SCHEMA }),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Prose summary');
    expect(warnSpy).toHaveBeenCalledWith(
      'Claude SDK run finished without structured output',
      expect.objectContaining({ turns: 3 })
    );
  });

  it('does not apply review-only options in edit mode', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() => createAsyncGenerator([successResult()]));
    jest.spyOn(StreamingClaudeExecutor.prototype as any, 'getFileChanges').mockResolvedValue([]);

    const executor = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(REPO_SKILLS_DIR)
    );
    await executor.executeWithStreaming(
      'Edit',
      '/tmp/project',
      createReviewContext({ mode: 'edit', skills: ['mr-review-core'], maxTurns: 5 }),
      createCallback()
    );

    const options = mockQuery.mock.calls[0][0].options;
    expect(options.plugins).toBeUndefined();
    expect(options.skills).toBeUndefined();
    expect(options.settingSources).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
    expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('reports a readable error when the run hits the max-turn limit', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() =>
      createAsyncGenerator([
        {
          type: 'result',
          subtype: 'error_max_turns',
          errors: [],
          total_cost_usd: 0,
          num_turns: 40,
          duration_ms: 10,
        },
      ])
    );

    const executor = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(REPO_SKILLS_DIR)
    );
    const result = await executor.executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({ maxTurns: 40 }),
      createCallback()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('maximum number of turns');
  });

  it('sends no maxTurns to the SDK when the configured cap is 0', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() => createAsyncGenerator([successResult()]));
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

    const executor = new StreamingClaudeExecutor(
      reviewCustomizationService,
      new ReviewSkillCatalog(REPO_SKILLS_DIR)
    );
    const result = await executor.executeWithStreaming(
      'Review',
      '/tmp/project',
      createReviewContext({ maxTurns: 0 }),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(mockQuery.mock.calls[0][0].options.maxTurns).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      'Executing Claude via Agent SDK',
      expect.objectContaining({ maxTurns: 'unlimited' })
    );
  });
});

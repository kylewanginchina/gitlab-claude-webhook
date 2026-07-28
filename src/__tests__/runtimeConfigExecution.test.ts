import type { RuntimeConfig } from '../admin/adminTypes';
import type { AIExecutionContext, StreamingProgressCallback } from '../types/common';
import type { GitLabWebhookEvent, AIInstruction } from '../types/gitlab';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { simpleGit } from 'simple-git';

const mockQuery = jest.fn();
const mockGitlabConstructor = jest.fn();
const mockCodexConstructor = jest.fn();

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
    gitlab: {
      baseUrl: 'https://gitlab.static.example',
      token: 'glpat-static-token',
    },
    webhook: {
      secret: 'webhook-static-secret',
      port: 3000,
      taskConcurrency: 2,
    },
    ai: {
      defaultProvider: 'claude',
    },
    workDir: '/tmp/static-workdir',
    logLevel: 'info',
  },
}));

jest.mock('@gitbeaker/node', () => ({
  Gitlab: jest.fn().mockImplementation((...args: unknown[]) => mockGitlabConstructor(...args)),
}));

jest.mock(
  '@openai/codex-sdk',
  () => ({
    __esModule: true,
    Codex: jest.fn().mockImplementation((...args: unknown[]) => mockCodexConstructor(...args)),
    default: {
      Codex: jest.fn().mockImplementation((...args: unknown[]) => mockCodexConstructor(...args)),
    },
  }),
  { virtual: true }
);

import { runtimeConfigService } from '../utils/runtimeConfig';
import { StreamingClaudeExecutor } from '../services/streamingClaudeExecutor';
import { CodexExecutor } from '../services/codexExecutor';
import { GitLabService } from '../services/gitlabService';
import { ProjectManager } from '../services/projectManager';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';
import {
  GitLabReviewService,
  PreparedReviewContext,
  ReviewFinding,
  ReviewPassResult,
} from '../services/gitlabReviewService';
import { EventProcessor } from '../services/eventProcessor';

const baseRuntimeConfig: RuntimeConfig = {
  claude: {
    baseUrl: 'https://claude.default.example',
    authToken: 'anthropic-default-token',
    defaultModel: 'claude-default-model',
    reasoningEffort: 'high',
    defaultTimeoutMinutes: 30,
  },
  codex: {
    baseUrl: 'https://codex.default.example/v1',
    apiKey: 'openai-default-key',
    defaultModel: 'codex-default-model',
    reasoningEffort: 'high',
    defaultTimeoutMinutes: 30,
  },
  gitlab: {
    baseUrl: 'https://gitlab.default.example',
    token: 'glpat-default-token',
  },
  webhook: {
    secret: 'webhook-secret',
    port: 3000,
    taskConcurrency: 2,
  },
  ai: {
    defaultProvider: 'claude',
  },
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
  },
  workDir: '/tmp/gitlab-claude-work',
  logLevel: 'info',
};

type RuntimeConfigOverrides = {
  [K in keyof RuntimeConfig]?: RuntimeConfig[K] extends Array<unknown>
    ? RuntimeConfig[K]
    : RuntimeConfig[K] extends object
      ? Partial<RuntimeConfig[K]>
      : RuntimeConfig[K];
};

function createRuntimeConfig(overrides: RuntimeConfigOverrides = {}): RuntimeConfig {
  return {
    ...baseRuntimeConfig,
    ...overrides,
    claude: {
      ...baseRuntimeConfig.claude,
      ...(overrides.claude || {}),
    },
    codex: {
      ...baseRuntimeConfig.codex,
      ...(overrides.codex || {}),
    },
    gitlab: {
      ...baseRuntimeConfig.gitlab,
      ...(overrides.gitlab || {}),
    },
    webhook: {
      ...baseRuntimeConfig.webhook,
      ...(overrides.webhook || {}),
    },
    ai: {
      ...baseRuntimeConfig.ai,
      ...(overrides.ai || {}),
    },
    review: {
      ...baseRuntimeConfig.review,
      ...(overrides.review || {}),
    },
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

function createExecutionContext(overrides: Partial<AIExecutionContext> = {}): AIExecutionContext {
  return {
    context: 'MR #1: test context',
    projectUrl: 'https://gitlab.example.com/group/project',
    branch: 'feature/test',
    event: {} as GitLabWebhookEvent,
    instruction: 'Review the change',
    mode: 'review',
    ...overrides,
  };
}

function createReviewContext(): PreparedReviewContext {
  return {
    projectId: 1,
    mergeRequestIid: 2,
    mergeRequestTitle: 'Runtime config review',
    mergeRequestDescription: 'Description',
    mergeRequestUrl: 'https://gitlab.example.com/group/project/-/merge_requests/2',
    mergeRequestState: 'opened',
    draft: false,
    workInProgress: false,
    sourceBranch: 'feature/runtime-config',
    targetBranch: 'main',
    baseSha: 'base-sha',
    startSha: 'start-sha',
    headSha: 'head-sha',
    diffs: [{ old_path: 'src/a.ts', new_path: 'src/a.ts' }],
    claudeGuidelineFiles: ['CLAUDE.md'],
  };
}

function createMergeRequestEvent(): GitLabWebhookEvent {
  return {
    object_kind: 'merge_request',
    user: { id: 1, name: 'User', username: 'user', email: 'user@example.com' },
    project: {
      id: 1,
      name: 'project',
      web_url: 'https://gitlab.example.com/group/project',
      default_branch: 'main',
    },
    object_attributes: {},
    merge_request: {
      id: 2,
      iid: 2,
      title: 'Test MR',
      description: '',
      state: 'opened',
      web_url: 'https://gitlab.example.com/group/project/-/merge_requests/2',
      source_branch: 'feature/runtime-config',
      target_branch: 'main',
      author: { id: 1, name: 'User', username: 'user', email: 'user@example.com' },
    },
  };
}

function createMergeRequestNoteEvent(): GitLabWebhookEvent {
  const event = createMergeRequestEvent();
  return {
    ...event,
    object_kind: 'note',
    object_attributes: {
      id: 42,
      noteable_type: 'MergeRequest',
      noteable_id: event.merge_request?.id,
    },
  };
}

describe('runtime config execution paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGitlabConstructor.mockImplementation(() => ({
      Users: { current: jest.fn() },
      IssueNotes: { create: jest.fn(), edit: jest.fn() },
      MergeRequestNotes: { create: jest.fn(), edit: jest.fn() },
      MergeRequests: {
        show: jest.fn(),
        versions: jest.fn(),
        version: jest.fn(),
        create: jest.fn(),
        edit: jest.fn(),
      },
      MergeRequestDiscussions: { all: jest.fn(), create: jest.fn() },
      IssueDiscussions: { all: jest.fn() },
      Projects: { show: jest.fn() },
      Branches: { all: jest.fn(), create: jest.fn() },
      Issues: { edit: jest.fn(), show: jest.fn() },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as { fetch?: typeof fetch }).fetch;
  });

  it('uses runtime Claude model, base URL, auth token, reasoning effort, and default timeout for new executions', async () => {
    const previousClaudeEnvironment = {
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-stale-auth-token';
    process.env.ANTHROPIC_API_KEY = 'anthropic-stale-api-key';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-stale-oauth-token';

    const runtimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-runtime-model',
        baseUrl: 'https://claude.runtime.example',
        authToken: 'anthropic-runtime-token',
        reasoningEffort: 'max',
        defaultTimeoutMinutes: 41,
      } as any,
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    mockQuery.mockImplementation(() =>
      createAsyncGenerator([
        {
          type: 'assistant',
          message: {
            content: [{ text: 'Claude output' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'Claude output',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 1,
        },
      ])
    );

    const executor = new StreamingClaudeExecutor();
    const callback = createCallback();

    let result;
    try {
      result = await executor.executeWithStreaming(
        'Summarize the diff',
        '/tmp/project',
        createExecutionContext(),
        callback
      );
    } finally {
      for (const [key, value] of Object.entries(previousClaudeEnvironment)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    expect(result.success).toBe(true);
    const claudeOptions = mockQuery.mock.calls[0][0].options;
    const claudeEnvironment = claudeOptions.env;
    expect(claudeOptions.model).toBe('claude-runtime-model');
    expect(claudeOptions.effort).toBe('max');
    expect(claudeEnvironment.ANTHROPIC_BASE_URL).toBe(
      'https://claude.runtime.example'
    );
    expect(claudeEnvironment.ANTHROPIC_AUTH_TOKEN).toBe(
      'anthropic-runtime-token'
    );
    expect(claudeEnvironment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeEnvironment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2460000);
    const executedSystemPrompt = mockQuery.mock.calls[0]?.[0]?.options?.systemPrompt?.append as string;
    expect(executedSystemPrompt).toContain(
      'Do not run build, compile, test, lint, or format commands unless the user explicitly requests that validation.'
    );
  });

  it('uses published admin Claude edit system prompt templates for ordinary requests', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-prompt-template-'));
    const customization = new ReviewCustomizationService({ dataDir });
    await customization.initialize();
    await customization.updatePromptTemplate('claude.edit.system', {
      draft: {
        body: 'Custom Claude edit behavior from admin.',
      },
    });
    await customization.publishPromptTemplate('claude.edit.system', 'Custom edit behavior');

    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() =>
      createAsyncGenerator([
        {
          type: 'result',
          subtype: 'success',
          result: 'Claude output',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 1,
        },
      ])
    );

    const executor = new StreamingClaudeExecutor(customization);
    const result = await executor.executeWithStreaming(
      'Implement the requested change',
      '/tmp/project',
      createExecutionContext({ mode: undefined, instruction: 'Implement the requested change' }),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          tools: { type: 'preset', preset: 'claude_code' },
          systemPrompt: expect.objectContaining({
            append: 'Custom Claude edit behavior from admin.',
          }),
        }),
      })
    );

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('renders timeout budget variables in Claude prompt templates', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-time-budget-template-'));
    const customization = new ReviewCustomizationService({ dataDir });
    await customization.initialize();
    await customization.updatePromptTemplate('claude.review.system', {
      draft: {
        body:
          'Hard timeout {{timeoutMinutes}}m; finish analysis by {{softDeadlineMinutes}}m; reserve {{wrapUpMinutes}}m.',
      },
    });
    await customization.publishPromptTemplate('claude.review.system', 'Custom time budget');

    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    mockQuery.mockImplementation(() =>
      createAsyncGenerator([
        {
          type: 'result',
          subtype: 'success',
          result: 'Claude output',
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 1,
        },
      ])
    );

    const executor = new StreamingClaudeExecutor(customization);
    const result = await executor.executeWithStreaming(
      'Review the requested change',
      '/tmp/project',
      createExecutionContext({ timeoutMs: 7 * 60 * 1000 }),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          systemPrompt: expect.objectContaining({
            append: 'Hard timeout 7m; finish analysis by 5m; reserve 1m.',
          }),
        }),
      })
    );

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('continues a normal MR review request with read-only fallback when a validation command is missing', async () => {
    const runtimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-runtime-model',
        baseUrl: 'https://claude.runtime.example',
        authToken: 'anthropic-runtime-token',
      },
    });
    const updatedRuntimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-updated-model',
        baseUrl: 'https://claude.updated.example',
        authToken: 'anthropic-updated-token',
      },
    });
    const getConfigSpy = jest
      .spyOn(runtimeConfigService, 'getConfig')
      .mockReturnValueOnce(runtimeConfig)
      .mockReturnValue(updatedRuntimeConfig);
    jest.spyOn(ProjectManager.prototype, 'getChangedFiles').mockResolvedValue([]);

    mockQuery
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result:
              '测试命令失败原因已确认:\n\n```text\n/bin/bash: line 1: cargo: command not found\n```\n\n当前环境缺少 cargo。',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      )
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result: 'Static review continued after the missing cargo validation.',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      );

    const executor = new StreamingClaudeExecutor();
    const callback = createCallback();

    const result = await executor.executeWithStreaming(
      '审阅代码',
      '/tmp/project',
      createExecutionContext({ mode: undefined as never }),
      callback
    );

    expect(result.success).toBe(true);
    expect(getConfigSpy).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0].options.env.ANTHROPIC_AUTH_TOKEN).toBe(
      'anthropic-runtime-token'
    );
    expect(mockQuery.mock.calls[1][0].options.env.ANTHROPIC_AUTH_TOKEN).toBe(
      'anthropic-runtime-token'
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining('Continue the merge request review'),
        options: expect.objectContaining({
          tools: ['Bash', 'Read', 'Glob', 'Grep'],
          disallowedTools: expect.arrayContaining(['Task', 'TodoWrite', 'Edit', 'Write']),
        }),
      })
    );
    expect(result.output).toContain('cargo: command not found');
    expect(result.output).toContain('Static review continued');
    expect(callback.onProgress).toHaveBeenCalledWith(
      expect.stringContaining('continuing with static review'),
      false
    );
  });

  it('continues a normal MR review request when the SDK reports a missing validation command as an error', async () => {
    const runtimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-runtime-model',
        baseUrl: 'https://claude.runtime.example',
        authToken: 'anthropic-runtime-token',
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);
    jest.spyOn(ProjectManager.prototype, 'getChangedFiles').mockResolvedValue([]);

    mockQuery
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'error',
            errors: ['/bin/bash: line 1: cargo: command not found', 'exit code 127'],
          },
        ])
      )
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result: 'Static review completed after SDK error fallback.',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      );

    const executor = new StreamingClaudeExecutor();
    const callback = createCallback();

    const result = await executor.executeWithStreaming(
      '审阅代码',
      '/tmp/project',
      createExecutionContext({ mode: undefined as never }),
      callback
    );

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining('Continue the merge request review'),
        options: expect.objectContaining({
          tools: ['Bash', 'Read', 'Glob', 'Grep'],
          disallowedTools: expect.arrayContaining(['Task', 'TodoWrite', 'Edit', 'Write']),
        }),
      })
    );
    expect(result.output).toContain('cargo: command not found');
    expect(result.output).toContain('Static review completed');
    expect(callback.onError).not.toHaveBeenCalled();
  });

  it('continues a normal MR review request when validation fails before producing review findings', async () => {
    const runtimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-runtime-model',
        baseUrl: 'https://claude.runtime.example',
        authToken: 'anthropic-runtime-token',
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);
    jest.spyOn(ProjectManager.prototype, 'getChangedFiles').mockResolvedValue([]);

    mockQuery
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result:
              '验证命令无法继续:\n\n```text\nerror: failed to parse lock file at: agent/Cargo.lock\n\nCaused by:\n  lock file version `4` was found, but this version of Cargo does not understand this lock file\n```\n\n当前工具链无法执行 cargo check。',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      )
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result: 'Static review completed after validation failure.',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      );

    const executor = new StreamingClaudeExecutor();
    const callback = createCallback();

    const result = await executor.executeWithStreaming(
      '审阅代码',
      '/tmp/project',
      createExecutionContext({ mode: undefined as never }),
      callback
    );

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining('Continue the merge request review'),
        options: expect.objectContaining({
          tools: ['Bash', 'Read', 'Glob', 'Grep'],
          disallowedTools: expect.arrayContaining(['Task', 'TodoWrite', 'Edit', 'Write']),
        }),
      })
    );
    expect(result.output).toContain('lock file version `4`');
    expect(result.output).toContain('Static review completed');
    expect(callback.onProgress).toHaveBeenCalledWith(
      expect.stringContaining('continuing with static review'),
      false
    );
  });

  it('continues a review-mode MR request when a validation command fails without findings', async () => {
    const runtimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-runtime-model',
        baseUrl: 'https://claude.runtime.example',
        authToken: 'anthropic-runtime-token',
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    mockQuery
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result:
              'I tried to run validation first.\n\n```text\nnpm test failed with exit code 1\n```\n\nThe command did not complete.',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      )
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result: 'Static review completed in read-only mode.',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      );

    const executor = new StreamingClaudeExecutor();
    const callback = createCallback();

    const result = await executor.executeWithStreaming(
      '审阅代码',
      '/tmp/project',
      createExecutionContext({ mode: 'review' }),
      callback
    );

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        options: expect.objectContaining({
          tools: ['Bash', 'Read', 'Glob', 'Grep'],
          disallowedTools: expect.arrayContaining(['Task', 'TodoWrite', 'Edit', 'Write']),
        }),
      })
    );
    expect(result.output).toContain('npm test failed with exit code 1');
    expect(result.output).toContain('Static review completed');
  });

  it('continues a normal MR review request when the SDK reports a validation command failure as an error', async () => {
    const runtimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-runtime-model',
        baseUrl: 'https://claude.runtime.example',
        authToken: 'anthropic-runtime-token',
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);
    jest.spyOn(ProjectManager.prototype, 'getChangedFiles').mockResolvedValue([]);

    mockQuery
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'error',
            errors: ['Bash command failed with exit code 2: npm test'],
          },
        ])
      )
      .mockImplementationOnce(() =>
        createAsyncGenerator([
          {
            type: 'result',
            subtype: 'success',
            result: 'Static review completed after generic validation error fallback.',
            total_cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
          },
        ])
      );

    const executor = new StreamingClaudeExecutor();
    const callback = createCallback();

    const result = await executor.executeWithStreaming(
      '审阅代码',
      '/tmp/project',
      createExecutionContext({ mode: undefined as never }),
      callback
    );

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(result.output).toContain('exit code 2');
    expect(result.output).toContain('Static review completed');
    expect(callback.onError).not.toHaveBeenCalled();
  });

  it('formats progress comments as an aligned enterprise review table', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-06T09:20:31.817Z'));

    const processor = new EventProcessor();
    const event = createMergeRequestEvent();
    const context = (processor as any).createRunContext();
    context.currentCommentId = 101;
    (processor as any).updateComment = jest.fn().mockResolvedValue(undefined);

    await (processor as any).updateProgressComment(
      event,
      context,
      '🔎 Grep infer_l7_class_1 in /tmp/gitlab-claude-work/agent/src/ebpf/k...',
      false
    );
    await (processor as any).updateProgressComment(
      event,
      context,
      '✅ Claude execution completed successfully!',
      true
    );

    const body = (processor as any).updateComment.mock.calls.at(-1)?.[2] as string;

    expect(body).toContain('### AI Agent Progress Report');
    expect(body).toContain('| Time (UTC+08) | Status | Activity |');
    expect(body).toContain(
      '| 17:20:31 | Search | Grep `infer_l7_class_1` in `/tmp/gitlab-claude-work/agent/src/ebpf/k...` |'
    );
    expect(body).toContain('| 17:20:31 | Completed | Claude execution completed successfully. |');
    expect(body).toContain('**Status:** Completed successfully');
    expect(body).toContain('Last updated: 2026-07-06 17:20:31 UTC+08:00');
    expect(body).not.toContain('🔎');
    expect(body).not.toContain('✅');
    expect(body).not.toContain('2026-07-06T09:20:31.817Z');

    jest.useRealTimers();
  });

  it('keeps progress comment state isolated per run context', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-06T09:20:31.817Z'));

    const processor = new EventProcessor();
    const eventA = createMergeRequestEvent();
    const eventB = createMergeRequestEvent();
    if (eventB.merge_request) {
      eventB.merge_request.iid = 99;
    }

    const contextA = (processor as any).createRunContext();
    const contextB = (processor as any).createRunContext();
    contextA.currentCommentId = 101;
    contextB.currentCommentId = 202;

    (processor as any).updateComment = jest.fn().mockResolvedValue(undefined);

    await Promise.all([
      (processor as any).updateProgressComment(eventA, contextA, 'Task A progress', false),
      (processor as any).updateProgressComment(eventB, contextB, 'Task B progress', false),
    ]);

    const calls = (processor as any).updateComment.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe(101);
    expect(calls[0][2]).toContain('Task A progress');
    expect(calls[0][2]).not.toContain('Task B progress');
    expect(calls[1][1]).toBe(202);
    expect(calls[1][2]).toContain('Task B progress');
    expect(calls[1][2]).not.toContain('Task A progress');

    jest.useRealTimers();
  });

  it('creates at most one fallback progress comment when updating the original progress comment fails', async () => {
    const processor = new EventProcessor();
    const event = createMergeRequestEvent();
    const context = (processor as any).createRunContext();
    context.currentCommentId = 101;

    const updateMergeRequestComment = jest
      .fn()
      .mockImplementation((_projectId: number, _mrIid: number, noteId: number) => {
        if (noteId === 101) {
          throw new Error('GitLab API returned 404 Not Found');
        }
        return Promise.resolve({ id: noteId });
      });
    const createMergeRequestComment = jest.fn().mockResolvedValue({ id: 202 });
    (processor as any).gitlabService = {
      updateMergeRequestComment,
      createMergeRequestComment,
    };

    await (processor as any).updateProgressComment(event, context, 'First progress update', false);
    await (processor as any).updateProgressComment(event, context, 'Second progress update', false);

    expect(createMergeRequestComment).toHaveBeenCalledTimes(1);
    expect(createMergeRequestComment.mock.calls[0][2]).toContain('Updated Progress');
    expect(context.currentCommentId).toBe(202);
    expect(updateMergeRequestComment).toHaveBeenNthCalledWith(
      2,
      1,
      2,
      202,
      expect.stringContaining('Second progress update')
    );
  });

  it('disables progress updates if fallback progress comment creation also fails', async () => {
    const processor = new EventProcessor();
    const event = createMergeRequestEvent();
    const context = (processor as any).createRunContext();
    context.currentCommentId = 101;

    const updateMergeRequestComment = jest.fn().mockRejectedValue(new Error('edit failed'));
    const createMergeRequestComment = jest.fn().mockRejectedValue(new Error('create failed'));
    (processor as any).gitlabService = {
      updateMergeRequestComment,
      createMergeRequestComment,
    };

    await (processor as any).updateProgressComment(event, context, 'First progress update', false);
    await (processor as any).updateProgressComment(event, context, 'Second progress update', false);

    expect(createMergeRequestComment).toHaveBeenCalledTimes(1);
    expect(updateMergeRequestComment).toHaveBeenCalledTimes(1);
  });

  it('keeps discussion reply routing isolated per run context', async () => {
    const processor = new EventProcessor();
    const eventA = createMergeRequestEvent();
    const eventB = createMergeRequestEvent();
    if (eventB.merge_request) {
      eventB.merge_request.iid = 99;
    }

    const contextA = (processor as any).createRunContext();
    const contextB = (processor as any).createRunContext();
    contextA.currentDiscussionId = 'discussion-a';
    contextB.currentDiscussionId = 'discussion-b';

    const addMergeRequestDiscussionReply = jest.fn().mockResolvedValue(undefined);
    const addMergeRequestComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).gitlabService = {
      addMergeRequestDiscussionReply,
      addMergeRequestComment,
    };

    await Promise.all([
      (processor as any).postComment(eventA, 'Reply for discussion A', contextA),
      (processor as any).postComment(eventB, 'Reply for discussion B', contextB),
    ]);

    expect(addMergeRequestDiscussionReply).toHaveBeenCalledTimes(2);
    expect(addMergeRequestDiscussionReply).toHaveBeenNthCalledWith(
      1,
      1,
      2,
      'discussion-a',
      'Reply for discussion A'
    );
    expect(addMergeRequestDiscussionReply).toHaveBeenNthCalledWith(
      2,
      1,
      99,
      'discussion-b',
      'Reply for discussion B'
    );
    expect(addMergeRequestComment).not.toHaveBeenCalled();
  });

  it('uses the GitLab discussion note body when a merge request note webhook has no note text', async () => {
    const processor = new EventProcessor();
    const event = createMergeRequestNoteEvent();
    const executeInstruction = jest
      .spyOn(processor as any, 'executeInstruction')
      .mockResolvedValue(undefined);

    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        changes_count: '1',
        additions: 1,
        deletions: 0,
      }),
      getMergeRequestDiscussions: jest.fn().mockResolvedValue([
        {
          id: 'discussion-42',
          notes: [
            {
              id: 42,
              body: '@codex /code-review',
              created_at: '2026-07-08T04:27:05.000Z',
              author: { id: 1, name: 'User', username: 'user' },
            },
          ],
        },
      ]),
      findNoteInDiscussions: jest.fn().mockResolvedValue({
        discussion: { id: 'discussion-42' },
        discussionId: 'discussion-42',
        threadContext: '',
        note: {
          id: 42,
          body: '@codex /code-review',
        },
      }),
    };

    await processor.processEvent(event);

    expect(executeInstruction).toHaveBeenCalledTimes(1);
    expect(executeInstruction.mock.calls[0][1]).toMatchObject({
      provider: 'codex',
      command: '/code-review',
      branch: 'feature/runtime-config',
    });
  });

  it('routes merge request note discussion replies back to the original discussion', async () => {
    const processor = new EventProcessor();
    const event = createMergeRequestNoteEvent();
    const context = (processor as any).createRunContext();
    context.currentDiscussionId = 'discussion-note';

    const addMergeRequestDiscussionReply = jest.fn().mockResolvedValue({ id: 303 });
    const createMergeRequestComment = jest.fn().mockResolvedValue({ id: 404 });
    (processor as any).gitlabService = {
      addMergeRequestDiscussionReply,
      createMergeRequestComment,
    };

    const commentId = await (processor as any).createProgressComment(
      event,
      'Progress in MR note discussion',
      context
    );

    expect(commentId).toBe(303);
    expect(addMergeRequestDiscussionReply).toHaveBeenCalledWith(
      1,
      2,
      'discussion-note',
      'Progress in MR note discussion'
    );
    expect(createMergeRequestComment).not.toHaveBeenCalled();
  });

  it('posts queue status back to the merge request note discussion', async () => {
    const processor = new EventProcessor();
    const event = createMergeRequestNoteEvent();

    const getMergeRequestDiscussions = jest.fn().mockResolvedValue([
      {
        id: 'discussion-note',
        notes: [
          {
            id: 42,
            body: '@claude review',
            created_at: '2026-07-08T04:27:05.000Z',
            author: { id: 1, name: 'User', username: 'user' },
          },
        ],
      },
    ]);
    const findNoteInDiscussions = jest.fn().mockResolvedValue({
      discussion: { id: 'discussion-note' },
      discussionId: 'discussion-note',
      threadContext: '',
      note: {
        id: 42,
        body: '@claude review',
      },
    });
    const addMergeRequestDiscussionReply = jest.fn().mockResolvedValue({ id: 505 });
    const addMergeRequestComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).gitlabService = {
      getMergeRequestDiscussions,
      findNoteInDiscussions,
      addMergeRequestDiscussionReply,
      addMergeRequestComment,
    };

    await processor.postQueueStatus(event, {
      runId: 'run-123',
      resourceKey: 'project:1:merge_request:2',
      queuePosition: 1,
      resourceQueuePosition: 1,
      queuedAhead: 0,
      queued: 1,
      running: 1,
      globalConcurrency: 2,
    });

    expect(getMergeRequestDiscussions).toHaveBeenCalledWith(1, 2);
    expect(addMergeRequestDiscussionReply).toHaveBeenCalledWith(
      1,
      2,
      'discussion-note',
      expect.stringContaining('### AI Agent Queue Status')
    );
    expect(addMergeRequestDiscussionReply.mock.calls[0][3]).toContain('Run ID: `run-123`');
    expect(addMergeRequestDiscussionReply.mock.calls[0][3]).toContain('同资源等待位置：#1');
    expect(addMergeRequestComment).not.toHaveBeenCalled();
  });

  it('ignores AI progress note webhooks without fetching discussion context', async () => {
    const processor = new EventProcessor();
    const event = createMergeRequestNoteEvent();
    event.object_attributes.note = [
      '### AI Agent Progress Report',
      '',
      '| Time (UTC+08) | Status | Activity |',
      '| --- | --- | --- |',
      '| 11:15:41 | Command | Bash `git diff --stat main...HEAD` |',
    ].join('\n');

    const getMergeRequest = jest.fn().mockResolvedValue({});
    const getMergeRequestDiscussions = jest.fn().mockResolvedValue([]);
    (processor as any).gitlabService = {
      getMergeRequest,
      getMergeRequestDiscussions,
    };

    await processor.processEvent(event);

    expect(getMergeRequest).not.toHaveBeenCalled();
    expect(getMergeRequestDiscussions).not.toHaveBeenCalled();
  });

  it('links ordinary review output references before posting the success comment', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'event-review-links-'));
    await fs.mkdir(path.join(projectPath, 'agent/src/ebpf/user'), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'agent/src/ebpf/user/socket_trace.bpf.c'),
      [
        '#include "socket_trace.bpf.h"',
        '',
        'int process_data_common(void *ctx) {',
        '  return 0;',
        '}',
        '',
      ].join('\n')
    );

    const processor = new EventProcessor();
    const event = createMergeRequestEvent();
    if (event.merge_request) {
      event.merge_request.source_branch = 'feature/review-links';
    }
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);

    const runContext = (processor as any).createRunContext();

    await (processor as any).handleSuccess(
      event,
      {
        command: '审阅代码',
        context: 'MR #2',
        branch: 'feature/review-links',
        provider: 'claude',
      },
      {
        success: true,
        output: [
          'Review 结论',
          '',
          '- `socket_trace.bpf.c`',
          '  - `process_data_common()` 路径保持一致。',
        ].join('\n'),
        changes: [],
      },
      'feature/review-links',
      projectPath,
      runContext
    );

    const body = (processor as any).postComment.mock.calls[0]?.[1] as string;

    expect(body).toContain('**Claude processed your request successfully.**');
    expect(body).toContain(
      '[`socket_trace.bpf.c`](https://gitlab.example.com/group/project/-/blob/feature%2Freview-links/agent/src/ebpf/user/socket_trace.bpf.c)'
    );
    expect(body).toContain(
      '[`process_data_common()`](https://gitlab.example.com/group/project/-/blob/feature%2Freview-links/agent/src/ebpf/user/socket_trace.bpf.c#L3)'
    );
  });

  it('does not create a branch or merge request for read-only review results even if changes are reported', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'event-review-readonly-'));
    const processor = new EventProcessor();
    const event = createMergeRequestEvent();
    const createBranch = jest.fn();
    const createMergeRequest = jest.fn();
    (processor as any).gitlabService = {
      createBranch,
      createMergeRequest,
    };
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).commitAndPushToNewBranch = jest.fn().mockResolvedValue(undefined);

    const runContext = (processor as any).createRunContext();

    await (processor as any).handleSuccess(
      event,
      {
        command: 'review一下当前MR中的代码修改',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      {
        success: true,
        output: 'Review result',
        changes: [
          { path: 'src/app.ts', type: 'modified' },
          { path: '.claude/worktrees/agent-1/src/internal.rs', type: 'created' },
        ],
      },
      'feature/runtime-config',
      projectPath,
      runContext,
      'review'
    );

    const body = (processor as any).postComment.mock.calls[0]?.[1] as string;

    expect(createBranch).not.toHaveBeenCalled();
    expect(createMergeRequest).not.toHaveBeenCalled();
    expect((processor as any).commitAndPushToNewBranch).not.toHaveBeenCalled();
    expect(body).toContain('Review result');
    expect(body).toContain('No file changes were made.');
    expect(body).not.toContain('Changes made');
    expect(body).not.toContain('Merge request created');

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('uses runtime Codex model, base URL, API key, reasoning effort, and default timeout for new executions', async () => {
    const previousCodexEnvironment = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN,
    };
    process.env.OPENAI_API_KEY = 'openai-stale-api-key';
    process.env.CODEX_API_KEY = 'codex-stale-api-key';
    process.env.CODEX_ACCESS_TOKEN = 'codex-stale-access-token';

    const runtimeConfig = createRuntimeConfig({
      codex: {
        defaultModel: 'codex-runtime-model',
        baseUrl: 'https://codex.runtime.example/v1',
        apiKey: 'openai-runtime-key',
        reasoningEffort: 'medium',
        defaultTimeoutMinutes: 17,
      },
    });
    const updatedRuntimeConfig = createRuntimeConfig({
      codex: {
        defaultModel: 'codex-updated-model',
        baseUrl: 'https://codex.updated.example/v1',
        apiKey: 'openai-updated-key',
        reasoningEffort: 'high',
        defaultTimeoutMinutes: 23,
      },
    });
    let activeRuntimeConfig = runtimeConfig;
    const getConfigSpy = jest
      .spyOn(runtimeConfigService, 'getConfig')
      .mockImplementation(() => activeRuntimeConfig);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const mockRunStreamed = jest.fn().mockImplementation(async () => ({
      events: createAsyncGenerator([
        { type: 'thread.started' },
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Codex output',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            output_tokens: 2,
          },
        },
      ]),
    }));
    const mockStartThread = jest.fn().mockReturnValue({
      runStreamed: mockRunStreamed,
    });
    mockCodexConstructor.mockImplementation(() => ({
      startThread: mockStartThread,
    }));

    const executor = new CodexExecutor();
    const callback = createCallback();
    (callback.onProgress as jest.Mock).mockImplementation(async () => {
      activeRuntimeConfig = updatedRuntimeConfig;
    });

    let result;
    let updatedResult;
    try {
      result = await executor.executeWithStreaming(
        'Implement the change',
        '/tmp/project',
        createExecutionContext(),
        callback
      );
      updatedResult = await executor.executeWithStreaming(
        'Implement the next change',
        '/tmp/project',
        createExecutionContext(),
        callback
      );
    } finally {
      for (const [key, value] of Object.entries(previousCodexEnvironment)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    expect(result.success).toBe(true);
    expect(updatedResult.success).toBe(true);
    expect(getConfigSpy).toHaveBeenCalledTimes(2);
    const codexOptions = mockCodexConstructor.mock.calls[0][0];
    expect(codexOptions.apiKey).toBe('openai-runtime-key');
    expect(codexOptions.baseUrl).toBe('https://codex.runtime.example/v1');
    expect(codexOptions.config).toEqual({
      model_provider: 'gitlab_webhook_runtime',
      model_providers: {
        gitlab_webhook_runtime: {
          name: 'gitlab_webhook_runtime',
          base_url: 'https://codex.runtime.example/v1',
          wire_api: 'responses',
          env_key: 'OPENAI_API_KEY',
        },
      },
    });
    const codexEnvironment = codexOptions.env;
    expect(codexEnvironment.OPENAI_API_KEY).toBe('openai-runtime-key');
    expect(codexEnvironment.CODEX_API_KEY).toBe('openai-runtime-key');
    expect(codexEnvironment.CODEX_ACCESS_TOKEN).toBeUndefined();
    const updatedCodexOptions = mockCodexConstructor.mock.calls[1][0];
    expect(updatedCodexOptions.apiKey).toBe('openai-updated-key');
    expect(updatedCodexOptions.baseUrl).toBe('https://codex.updated.example/v1');
    expect(updatedCodexOptions.env.OPENAI_API_KEY).toBe('openai-updated-key');
    expect(updatedCodexOptions.env.CODEX_API_KEY).toBe('openai-updated-key');
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'codex-runtime-model',
        modelReasoningEffort: 'medium',
      })
    );
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'codex-updated-model',
        modelReasoningEffort: 'high',
      })
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1020000);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1380000);
    const executedPrompt = mockRunStreamed.mock.calls[0]?.[0] as string;
    expect(executedPrompt).toContain(
      'Do not run build, compile, test, lint, or format commands unless the user explicitly requests that validation.'
    );
  });

  it('uses published admin Codex edit instruction templates for ordinary requests', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-prompt-template-'));
    const customization = new ReviewCustomizationService({ dataDir });
    await customization.initialize();
    await customization.updatePromptTemplate('codex.edit.instructions', {
      draft: {
        body: 'Custom Codex edit behavior from admin.',
      },
    });
    await customization.publishPromptTemplate('codex.edit.instructions', 'Custom edit behavior');

    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    const mockRunStreamed = jest.fn().mockResolvedValue({
      events: createAsyncGenerator([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Codex output',
          },
        },
      ]),
    });
    mockCodexConstructor.mockImplementation(() => ({
      startThread: jest.fn().mockReturnValue({
        runStreamed: mockRunStreamed,
      }),
    }));

    const executor = new CodexExecutor(customization);
    const result = await executor.executeWithStreaming(
      'Implement the requested change',
      '/tmp/project',
      createExecutionContext({ mode: undefined, instruction: 'Implement the requested change' }),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(mockRunStreamed.mock.calls[0]?.[0]).toContain('Custom Codex edit behavior from admin.');

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('renders timeout budget variables in Codex prompt templates', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-time-budget-template-'));
    const customization = new ReviewCustomizationService({ dataDir });
    await customization.initialize();
    await customization.updatePromptTemplate('codex.context.wrapper', {
      draft: {
        body:
          'Budget {{timeoutMinutes}}/{{softDeadlineMinutes}}/{{wrapUpMinutes}}\n{{instructionsBlock}}\n**Request:** {{command}}',
      },
    });
    await customization.publishPromptTemplate('codex.context.wrapper', 'Custom time budget');

    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());
    const mockRunStreamed = jest.fn().mockResolvedValue({
      events: createAsyncGenerator([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Codex output',
          },
        },
      ]),
    });
    mockCodexConstructor.mockImplementation(() => ({
      startThread: jest.fn().mockReturnValue({
        runStreamed: mockRunStreamed,
      }),
    }));

    const executor = new CodexExecutor(customization);
    const result = await executor.executeWithStreaming(
      'Review the requested change',
      '/tmp/project',
      createExecutionContext({ timeoutMs: 17 * 60 * 1000 }),
      createCallback()
    );

    expect(result.success).toBe(true);
    expect(mockRunStreamed.mock.calls[0]?.[0]).toContain('Budget 17/13/3');

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('uses runtime GitLab base URL and token in the service constructor and direct fetch helper', async () => {
    const runtimeConfig = createRuntimeConfig({
      gitlab: {
        baseUrl: 'https://gitlab.runtime.example',
        token: 'glpat-runtime-token',
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 99 }),
    });
    global.fetch = fetchMock as typeof fetch;

    const service = new GitLabService();
    await service.addIssueDiscussionReply(123, 456, 'discussion-789', 'Runtime-config reply');

    expect(mockGitlabConstructor).toHaveBeenCalledWith({
      host: 'https://gitlab.runtime.example',
      token: 'glpat-runtime-token',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.runtime.example/api/v4/projects/123/issues/456/discussions/discussion-789/notes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'glpat-runtime-token',
        }),
      })
    );
  });

  it('rebuilds a long-lived GitLab client when runtime GitLab config changes before a later API call', async () => {
    let runtimeConfig = createRuntimeConfig({
      gitlab: {
        baseUrl: 'https://gitlab.initial.example',
        token: 'glpat-initial-token',
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockImplementation(() => runtimeConfig);

    const firstClient = {
      Users: { current: jest.fn() },
      IssueNotes: { create: jest.fn(), edit: jest.fn() },
      MergeRequestNotes: { create: jest.fn(), edit: jest.fn() },
      MergeRequests: {
        show: jest.fn(),
        versions: jest.fn(),
        version: jest.fn(),
        create: jest.fn(),
        edit: jest.fn(),
      },
      MergeRequestDiscussions: { all: jest.fn(), create: jest.fn() },
      IssueDiscussions: { all: jest.fn() },
      Projects: { show: jest.fn().mockResolvedValue({ id: 101, client: 'initial' }) },
      Branches: { all: jest.fn(), create: jest.fn() },
      Issues: { edit: jest.fn(), show: jest.fn() },
    };
    const secondClient = {
      Users: { current: jest.fn() },
      IssueNotes: { create: jest.fn(), edit: jest.fn() },
      MergeRequestNotes: { create: jest.fn(), edit: jest.fn() },
      MergeRequests: {
        show: jest.fn(),
        versions: jest.fn(),
        version: jest.fn(),
        create: jest.fn(),
        edit: jest.fn(),
      },
      MergeRequestDiscussions: { all: jest.fn(), create: jest.fn() },
      IssueDiscussions: { all: jest.fn() },
      Projects: { show: jest.fn().mockResolvedValue({ id: 202, client: 'updated' }) },
      Branches: { all: jest.fn(), create: jest.fn() },
      Issues: { edit: jest.fn(), show: jest.fn() },
    };
    mockGitlabConstructor
      .mockImplementationOnce(() => firstClient)
      .mockImplementationOnce(() => secondClient);

    const service = new GitLabService();

    await expect(service.getProject(101)).resolves.toEqual({ id: 101, client: 'initial' });

    runtimeConfig = createRuntimeConfig({
      gitlab: {
        baseUrl: 'https://gitlab.updated.example',
        token: 'glpat-updated-token',
      },
    });

    await expect(service.getProject(202)).resolves.toEqual({ id: 202, client: 'updated' });
    expect(mockGitlabConstructor).toHaveBeenNthCalledWith(1, {
      host: 'https://gitlab.initial.example',
      token: 'glpat-initial-token',
    });
    expect(mockGitlabConstructor).toHaveBeenNthCalledWith(2, {
      host: 'https://gitlab.updated.example',
      token: 'glpat-updated-token',
    });
  });

  it('uses the updated runtime GitLab token for a new clone auth URL', () => {
    let runtimeConfig = createRuntimeConfig({
      gitlab: {
        token: 'glpat-initial-token',
      },
    });
    jest.spyOn(runtimeConfigService, 'isLoaded').mockReturnValue(true);
    jest.spyOn(runtimeConfigService, 'getConfig').mockImplementation(() => runtimeConfig);

    const manager = new ProjectManager();
    const repoUrl = 'https://gitlab.example.com/group/project.git';

    expect(new URL((manager as any).getAuthenticatedUrl(repoUrl)).password).toBe(
      'glpat-initial-token'
    );

    runtimeConfig = createRuntimeConfig({
      gitlab: {
        token: 'glpat-updated-token',
      },
    });

    expect(new URL((manager as any).getAuthenticatedUrl(repoUrl)).password).toBe(
      'glpat-updated-token'
    );
  });

  it('does not report Claude internal worktree files as project changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-changes-'));
    await simpleGit(dir).init();
    await fs.mkdir(path.join(dir, '.claude/worktrees/agent-1/src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude/worktrees/agent-1/src/internal.rs'), 'internal');
    await fs.writeFile(path.join(dir, 'src/app.ts'), 'export const app = true;');

    const manager = new ProjectManager();
    const changes = await manager.getChangedFiles(dir);

    expect(changes).toEqual([{ path: 'src/app.ts', type: 'created' }]);
  });

  it('uses runtime review caps for candidate and final findings', () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        maxCandidateFindings: 2,
        maxFinalFindings: 1,
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const service = new GitLabReviewService({} as GitLabService);
    const findings: ReviewFinding[] = [
      {
        title: 'First issue',
        body: 'First body',
        confidence: 70,
        path: 'src/a.ts',
        line: 1,
        lineType: 'new',
      },
      {
        title: 'Second issue',
        body: 'Second body',
        confidence: 60,
        path: 'src/b.ts',
        line: 2,
        lineType: 'new',
      },
      {
        title: 'Third issue',
        body: 'Third body',
        confidence: 50,
        path: 'src/c.ts',
        line: 3,
        lineType: 'new',
      },
    ];
    const passResults: ReviewPassResult[] = [
      {
        passId: 'pass-1',
        label: 'Pass 1',
        summary: 'Summary',
        findings: [],
      },
    ];

    const merged = service.mergeCandidateFindings(findings);
    const finalReview = service.buildFinalReview(passResults, findings, findings.length);

    expect(merged).toHaveLength(2);
    expect(finalReview.findings).toHaveLength(1);
    expect(finalReview.findings[0]?.title).toBe('First issue');
  });

  it('uses runtime review minConfidence when deciding which scored findings remain', async () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        minConfidence: 90,
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const reviewContext = createReviewContext();
    const candidateFinding: ReviewFinding = {
      title: 'Possible bug',
      body: 'Needs validation',
      confidence: 40,
      path: 'src/a.ts',
      line: 10,
      lineType: 'new',
      sources: ['Pass 1'],
    };
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([candidateFinding]),
      buildNoIssuesMessage: jest.fn().mockReturnValue('NO_ISSUES'),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn(),
      postReview: jest.fn(),
    };

    const processor = new EventProcessor();
    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'head-sha',
      }),
    };
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeReviewPass = jest.fn().mockResolvedValue({
      passId: 'pass-1',
      label: 'Pass 1',
      summary: 'Found one candidate',
      findings: [candidateFinding],
    });
    (processor as any).executeReviewScore = jest.fn().mockResolvedValue({
      ...candidateFinding,
      confidence: 85,
    });

    const event = createMergeRequestEvent();
    const instruction: AIInstruction = {
      command: '/code-review',
      context: 'MR #2',
      branch: 'feature/runtime-config',
      provider: 'claude',
    };

    await (processor as any).executeCodeReview(
      event,
      instruction,
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect(mockReviewService.buildNoIssuesMessage).toHaveBeenCalled();
    expect((processor as any).postComment).toHaveBeenCalledWith(
      event,
      'NO_ISSUES',
      expect.any(Object)
    );
    expect(mockReviewService.postReview).not.toHaveBeenCalled();
  });

  it('does not publish a no-candidate review after the MR head changes', async () => {
    const processor = new EventProcessor();
    const reviewContext = createReviewContext();
    const postComment = jest.fn().mockResolvedValue(undefined);
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([]),
      buildNoIssuesMessage: jest.fn().mockReturnValue('NO_ISSUES'),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn(),
      postReview: jest.fn(),
    };

    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'new-head-sha',
      }),
    };
    (processor as any).postComment = postComment;
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeReviewPass = jest.fn().mockResolvedValue({
      passId: 'pass-1',
      label: 'Pass 1',
      summary: 'No issues',
      findings: [],
    });

    await (processor as any).executeCodeReview(
      createMergeRequestEvent(),
      {
        command: '/code-review',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect(mockReviewService.buildNoIssuesMessage).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledWith(
      expect.any(Object),
      'Skipped posting code review: merge request head changed while review was running.',
      expect.any(Object)
    );
  });

  it('does not publish a below-threshold review after the MR head changes', async () => {
    const processor = new EventProcessor();
    const reviewContext = createReviewContext();
    const finding: ReviewFinding = {
      title: 'Candidate',
      body: 'Candidate body',
      confidence: 40,
      path: 'src/a.ts',
      line: 10,
      lineType: 'new',
    };
    const postComment = jest.fn().mockResolvedValue(undefined);
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([finding]),
      buildNoIssuesMessage: jest.fn().mockReturnValue('NO_ISSUES'),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn(),
      postReview: jest.fn(),
    };

    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'new-head-sha',
      }),
    };
    (processor as any).postComment = postComment;
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeReviewPass = jest.fn().mockResolvedValue({
      passId: 'pass-1',
      label: 'Pass 1',
      summary: 'Candidate',
      findings: [finding],
    });
    (processor as any).executeReviewScore = jest.fn().mockResolvedValue({
      ...finding,
      confidence: 10,
    });

    await (processor as any).executeCodeReview(
      createMergeRequestEvent(),
      {
        command: '/code-review',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect(mockReviewService.buildNoIssuesMessage).not.toHaveBeenCalled();
    expect(mockReviewService.postReview).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledWith(
      expect.any(Object),
      'Skipped posting code review: merge request head changed while review was running.',
      expect.any(Object)
    );
  });

  it.each([
    [
      { state: 'closed', draft: false, work_in_progress: false, sha: 'head-sha' },
      'Skipped posting code review: merge request is no longer eligible.',
    ],
    [
      { state: 'opened', draft: true, work_in_progress: false, sha: 'head-sha' },
      'Skipped posting code review: merge request is no longer eligible.',
    ],
  ])('blocks terminal review publication for an ineligible MR', async (latest, expected) => {
    const processor = new EventProcessor();
    const postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue(latest),
    };
    (processor as any).gitlabReviewService = {
      hasExistingReview: jest.fn().mockResolvedValue(false),
    };
    (processor as any).postComment = postComment;
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);

    await expect(
      (processor as any).ensureReviewCanPublish(
        createMergeRequestEvent(),
        createReviewContext(),
        createRuntimeConfig().review,
        (processor as any).createRunContext()
      )
    ).resolves.toBe(false);
    expect(postComment).toHaveBeenCalledWith(expect.any(Object), expected, expect.any(Object));
  });

  it('blocks publication when another review records the same SHA during execution', async () => {
    const processor = new EventProcessor();
    const postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'head-sha',
      }),
    };
    (processor as any).gitlabReviewService = {
      hasExistingReview: jest.fn().mockResolvedValue(true),
    };
    (processor as any).postComment = postComment;
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);

    await expect(
      (processor as any).ensureReviewCanPublish(
        createMergeRequestEvent(),
        createReviewContext(),
        createRuntimeConfig().review,
        (processor as any).createRunContext()
      )
    ).resolves.toBe(false);
    expect(postComment).toHaveBeenCalledWith(
      expect.any(Object),
      'Skipped posting code review: another review was already posted.',
      expect.any(Object)
    );
  });

  it('passes timeout budget variables into code review prompt builders', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());

    const reviewContext = createReviewContext();
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([]),
      buildNoIssuesMessage: jest.fn().mockReturnValue('NO_ISSUES'),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn(),
      postReview: jest.fn(),
    };

    const processor = new EventProcessor();
    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'head-sha',
      }),
    };
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeReviewPass = jest.fn().mockResolvedValue({
      passId: 'pass-1',
      label: 'Pass 1',
      summary: 'No issues',
      findings: [],
    });

    const event = createMergeRequestEvent();
    const instruction: AIInstruction = {
      command: '/code-review',
      context: 'MR #2',
      branch: 'feature/runtime-config',
      provider: 'claude',
      timeoutMs: 11 * 60 * 1000,
    };

    await (processor as any).executeCodeReview(
      event,
      instruction,
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect(mockReviewService.buildReviewPasses).toHaveBeenCalledWith(
      reviewContext,
      undefined,
      expect.objectContaining({
        timeoutMinutes: 11,
        softDeadlineMinutes: 8,
        wrapUpMinutes: 2,
      }),
      'claude'
    );
  });

  it('skips review commands when runtime review is disabled', async () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        enabled: false,
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const processor = new EventProcessor();
    (processor as any).createProgressComment = jest.fn().mockResolvedValue(101);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeCodeReview = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeWithProvider = jest.fn();
    (processor as any).projectManager = {
      prepareProject: jest.fn(),
      cleanup: jest.fn(),
    };

    const event = createMergeRequestEvent();
    const instruction: AIInstruction = {
      command: '/code-review',
      context: 'MR #2',
      branch: 'feature/runtime-config',
      provider: 'claude',
    };

    await (processor as any).executeInstruction(
      event,
      instruction,
      (processor as any).createRunContext()
    );

    expect((processor as any).projectManager.prepareProject).not.toHaveBeenCalled();
    expect((processor as any).executeCodeReview).not.toHaveBeenCalled();
    expect((processor as any).executeWithProvider).not.toHaveBeenCalled();
    expect((processor as any).postComment).toHaveBeenCalledWith(
      event,
      'Skipped code review: review commands are currently disabled in runtime settings.',
      expect.any(Object)
    );
    expect((processor as any).updateProgressComment).toHaveBeenCalledWith(
      event,
      expect.any(Object),
      'Skipped code review: review commands are currently disabled in runtime settings.',
      true
    );
  });

  it('uses configured review commands and extracts focus from the matched command', async () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        allowedCommands: ['/review-me'],
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const reviewContext = createReviewContext();
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([]),
      buildNoIssuesMessage: jest.fn().mockReturnValue('NO_ISSUES'),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn(),
      postReview: jest.fn(),
    };

    const processor = new EventProcessor();
    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'head-sha',
      }),
    };
    (processor as any).createProgressComment = jest.fn().mockResolvedValue(101);
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);
    (processor as any).projectManager = {
      prepareProject: jest.fn().mockResolvedValue('/tmp/project'),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };
    (processor as any).executeReviewPass = jest.fn().mockResolvedValue({
      passId: 'pass-1',
      label: 'Pass 1',
      summary: 'Summary',
      findings: [],
    });

    await (processor as any).executeInstruction(
      createMergeRequestEvent(),
      {
        command: '/review-me auth edge cases',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      (processor as any).createRunContext()
    );

    expect(mockReviewService.buildReviewPasses).toHaveBeenCalledWith(
      reviewContext,
      'auth edge cases',
      expect.objectContaining({
        timeoutMinutes: 30,
        softDeadlineMinutes: 24,
        wrapUpMinutes: 3,
      }),
      'claude'
    );
  });

  it('runs natural language merge request review requests in read-only review mode', async () => {
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(createRuntimeConfig());

    const processor = new EventProcessor();
    const executeWithProvider = jest
      .spyOn(processor as any, 'executeWithProvider')
      .mockResolvedValue({ success: true, output: 'Review result', changes: [] });
    const executeCodeReview = jest
      .spyOn(processor as any, 'executeCodeReview')
      .mockResolvedValue(undefined);
    (processor as any).createProgressComment = jest.fn().mockResolvedValue(101);
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleSuccess = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);
    (processor as any).projectManager = {
      prepareProject: jest.fn().mockResolvedValue('/tmp/project'),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };

    await (processor as any).executeInstruction(
      createMergeRequestEvent(),
      {
        command: 'review一下当前MR中的代码修改',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      (processor as any).createRunContext()
    );

    expect(executeCodeReview).not.toHaveBeenCalled();
    expect(executeWithProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
      'review一下当前MR中的代码修改',
      '/tmp/project',
      expect.objectContaining({ mode: 'review' }),
      expect.any(Object)
    );
  });

  it('allows draft merge requests when review.skipDraft is false', async () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        skipDraft: false,
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const reviewContext = {
      ...createReviewContext(),
      draft: true,
      workInProgress: true,
    };
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([]),
      buildNoIssuesMessage: jest.fn().mockReturnValue('NO_ISSUES'),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn(),
      postReview: jest.fn(),
    };

    const processor = new EventProcessor();
    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: true,
        work_in_progress: true,
        sha: 'head-sha',
      }),
    };
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeReviewPass = jest.fn().mockResolvedValue({
      passId: 'pass-1',
      label: 'Pass 1',
      summary: 'Summary',
      findings: [],
    });

    await (processor as any).executeCodeReview(
      createMergeRequestEvent(),
      {
        command: '/code-review',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect(mockReviewService.buildReviewPasses).toHaveBeenCalled();
    expect((processor as any).postComment).toHaveBeenCalledWith(
      createMergeRequestEvent(),
      'NO_ISSUES',
      expect.any(Object)
    );
  });

  it('allows duplicate review SHAs when review.skipExistingSha is false', async () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        skipExistingSha: false,
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const reviewContext = createReviewContext();
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(true),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([]),
      buildNoIssuesMessage: jest.fn().mockReturnValue('NO_ISSUES'),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn(),
      postReview: jest.fn(),
    };

    const processor = new EventProcessor();
    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'head-sha',
      }),
    };
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeReviewPass = jest.fn().mockResolvedValue({
      passId: 'pass-1',
      label: 'Pass 1',
      summary: 'Summary',
      findings: [],
    });

    await (processor as any).executeCodeReview(
      createMergeRequestEvent(),
      {
        command: '/code-review',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect(mockReviewService.hasExistingReview).toHaveBeenCalled();
    expect(mockReviewService.buildReviewPasses).toHaveBeenCalled();
  });

  it('uses the configured review provider for review passes and scoring', async () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        defaultProvider: 'codex-multipass',
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const reviewContext = createReviewContext();
    const candidateFinding: ReviewFinding = {
      title: 'Possible bug',
      body: 'Needs validation',
      confidence: 40,
      path: 'src/a.ts',
      line: 10,
      lineType: 'new',
      sources: ['Pass 1'],
    };
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest
        .fn()
        .mockReturnValue([{ id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' }]),
      mergeCandidateFindings: jest.fn().mockReturnValue([candidateFinding]),
      buildNoIssuesMessage: jest.fn(),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn().mockReturnValue({
        summary: 'Summary',
        findings: [candidateFinding],
      }),
      postReview: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new EventProcessor();
    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'head-sha',
      }),
    };
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);

    const executeReviewPassSpy = jest
      .spyOn(processor as any, 'executeReviewPass')
      .mockResolvedValue({
        passId: 'pass-1',
        label: 'Pass 1',
        summary: 'Summary',
        findings: [candidateFinding],
      });
    const executeReviewScoreSpy = jest
      .spyOn(processor as any, 'executeReviewScore')
      .mockResolvedValue({
        ...candidateFinding,
        confidence: 95,
      });

    await (processor as any).executeCodeReview(
      createMergeRequestEvent(),
      {
        command: '/code-review',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect((executeReviewPassSpy.mock.calls[0]?.[0] as AIInstruction).provider).toBe('codex');
    expect((executeReviewScoreSpy.mock.calls[0]?.[0] as AIInstruction).provider).toBe('codex');
    expect(mockReviewService.buildReviewPasses).toHaveBeenCalledWith(
      reviewContext,
      undefined,
      expect.any(Object),
      'codex'
    );
  });

  it('limits review pass and scoring concurrency from runtime settings', async () => {
    const runtimeConfig = createRuntimeConfig({
      review: {
        passConcurrency: 2,
        scoringConcurrency: 1,
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);

    const reviewContext = createReviewContext();
    const candidateFindings: ReviewFinding[] = [1, 2, 3].map(index => ({
      title: `Issue ${index}`,
      body: `Needs validation ${index}`,
      confidence: 50,
      path: `src/${index}.ts`,
      line: index,
      lineType: 'new',
      sources: [`Pass ${index}`],
    }));
    const mockReviewService = {
      prepareReviewContext: jest.fn().mockResolvedValue(reviewContext),
      hasExistingReview: jest.fn().mockResolvedValue(false),
      buildReviewPasses: jest.fn().mockReturnValue([
        { id: 'pass-1', label: 'Pass 1', prompt: 'Prompt 1' },
        { id: 'pass-2', label: 'Pass 2', prompt: 'Prompt 2' },
        { id: 'pass-3', label: 'Pass 3', prompt: 'Prompt 3' },
      ]),
      mergeCandidateFindings: jest.fn().mockReturnValue(candidateFindings),
      buildNoIssuesMessage: jest.fn(),
      buildIncompleteReviewMessage: jest.fn(),
      buildFinalReview: jest.fn().mockImplementation((_passes, findings) => ({
        summary: 'Summary',
        findings,
      })),
      postReview: jest.fn().mockResolvedValue(undefined),
    };

    let activePasses = 0;
    let maxActivePasses = 0;
    let activeScores = 0;
    let maxActiveScores = 0;

    const processor = new EventProcessor();
    (processor as any).gitlabReviewService = mockReviewService;
    (processor as any).gitlabService = {
      getMergeRequest: jest.fn().mockResolvedValue({
        state: 'opened',
        draft: false,
        work_in_progress: false,
        sha: 'head-sha',
      }),
    };
    (processor as any).updateProgressComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).postComment = jest.fn().mockResolvedValue(undefined);
    (processor as any).handleFailure = jest.fn().mockResolvedValue(undefined);
    (processor as any).executeReviewPass = jest
      .fn()
      .mockImplementation(async (_instruction, passId, label) => {
        activePasses += 1;
        maxActivePasses = Math.max(maxActivePasses, activePasses);
        await new Promise(resolve => setTimeout(resolve, 10));
        activePasses -= 1;
        return {
          passId,
          label,
          summary: 'Summary',
          findings: [],
        };
      });
    (processor as any).executeReviewScore = jest
      .fn()
      .mockImplementation(async (_instruction, finding) => {
        activeScores += 1;
        maxActiveScores = Math.max(maxActiveScores, activeScores);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeScores -= 1;
        return {
          ...finding,
          confidence: 95,
        };
      });

    await (processor as any).executeCodeReview(
      createMergeRequestEvent(),
      {
        command: '/code-review',
        context: 'MR #2',
        branch: 'feature/runtime-config',
        provider: 'claude',
      },
      'main',
      '/tmp/project',
      createCallback(),
      (processor as any).createRunContext()
    );

    expect(maxActivePasses).toBeLessThanOrEqual(2);
    expect(maxActiveScores).toBeLessThanOrEqual(1);
  });
});

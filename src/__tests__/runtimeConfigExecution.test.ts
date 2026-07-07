import type { RuntimeConfig } from '../admin/adminTypes';
import type { AIExecutionContext, StreamingProgressCallback } from '../types/common';
import type { GitLabWebhookEvent, AIInstruction } from '../types/gitlab';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

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

  it('uses runtime Claude model, base URL, auth token, and default timeout for new executions', async () => {
    const runtimeConfig = createRuntimeConfig({
      claude: {
        defaultModel: 'claude-runtime-model',
        baseUrl: 'https://claude.runtime.example',
        authToken: 'anthropic-runtime-token',
        defaultTimeoutMinutes: 41,
      },
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

    const result = await executor.executeWithStreaming(
      'Summarize the diff',
      '/tmp/project',
      createExecutionContext(),
      callback
    );

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'claude-runtime-model',
          env: expect.objectContaining({
            ANTHROPIC_BASE_URL: 'https://claude.runtime.example',
            ANTHROPIC_API_KEY: 'anthropic-runtime-token',
          }),
        }),
      })
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2460000);
  });

  it('continues a normal MR review request with read-only fallback when a validation command is missing', async () => {
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
      projectPath
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

  it('uses runtime Codex model, base URL, API key, reasoning effort, and default timeout for new executions', async () => {
    const runtimeConfig = createRuntimeConfig({
      codex: {
        defaultModel: 'codex-runtime-model',
        baseUrl: 'https://codex.runtime.example/v1',
        apiKey: 'openai-runtime-key',
        reasoningEffort: 'medium',
        defaultTimeoutMinutes: 17,
      },
    });
    jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue(runtimeConfig);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const mockRunStreamed = jest.fn().mockResolvedValue({
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
    });
    const mockStartThread = jest.fn().mockReturnValue({
      runStreamed: mockRunStreamed,
    });
    mockCodexConstructor.mockImplementation(() => ({
      startThread: mockStartThread,
    }));

    const executor = new CodexExecutor();
    const callback = createCallback();

    const result = await executor.executeWithStreaming(
      'Implement the change',
      '/tmp/project',
      createExecutionContext(),
      callback
    );

    expect(result.success).toBe(true);
    expect(mockCodexConstructor).toHaveBeenCalledWith({
      apiKey: 'openai-runtime-key',
      baseUrl: 'https://codex.runtime.example/v1',
    });
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'codex-runtime-model',
        modelReasoningEffort: 'medium',
      })
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1020000);
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
      'auth edge cases'
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

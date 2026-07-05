import type { RuntimeConfig } from '../admin/adminTypes';
import type { AIExecutionContext, StreamingProgressCallback } from '../types/common';
import type { GitLabWebhookEvent, AIInstruction } from '../types/gitlab';

const mockQuery = jest.fn();
const mockGitlabConstructor = jest.fn();
const mockCodexConstructor = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

jest.mock('@gitbeaker/node', () => ({
  Gitlab: jest.fn().mockImplementation((...args: unknown[]) => mockGitlabConstructor(...args)),
}));

jest.mock('@openai/codex-sdk', () => ({
  __esModule: true,
  Codex: jest.fn().mockImplementation((...args: unknown[]) => mockCodexConstructor(...args)),
  default: {
    Codex: jest.fn().mockImplementation((...args: unknown[]) => mockCodexConstructor(...args)),
  },
}), { virtual: true });

import { runtimeConfigService } from '../utils/runtimeConfig';
import { StreamingClaudeExecutor } from '../services/streamingClaudeExecutor';
import { CodexExecutor } from '../services/codexExecutor';
import { GitLabService } from '../services/gitlabService';
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
      buildReviewPasses: jest.fn().mockReturnValue([
        { id: 'pass-1', label: 'Pass 1', prompt: 'Prompt' },
      ]),
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

    const event: GitLabWebhookEvent = {
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
      createCallback()
    );

    expect(mockReviewService.buildNoIssuesMessage).toHaveBeenCalled();
    expect((processor as any).postComment).toHaveBeenCalledWith(event, 'NO_ISSUES');
    expect(mockReviewService.postReview).not.toHaveBeenCalled();
  });
});

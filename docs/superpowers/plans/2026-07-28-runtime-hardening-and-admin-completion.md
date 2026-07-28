# Runtime Hardening and Admin Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Review 发布、运行时日志、Prompt/Skill/Proposal、完整构建和 Docker 部署中的已确认缺口，同时保持当前 Claude/Codex 权限模式不变。

**Architecture:** 保留现有 EventProcessor、RuntimeConfigService 和 ReviewCustomizationService 边界，分别增加统一 Review 发布守卫、配置订阅、语言识别和 Proposal 状态操作。部署侧使用统一 root 入口修正 bind mount ownership，随后降权运行 Node；基础 Compose 显式传递所有运行时配置。

**Tech Stack:** Node.js 20、TypeScript、Jest、Express、React 19、Vite、Winston、Docker Compose、Alpine `su-exec`、Debian `gosu`

## Global Constraints

- 不修改 Claude `permissionMode: 'bypassPermissions'`、Claude SDK sandbox 或工具权限模型。
- 不修改 Codex `sandboxMode: 'danger-full-access'`。
- 普通 Review 默认不运行 build、compile、test、lint 或 format；用户明确要求时才运行。
- Review workflow 仍不收集、提交或发布文件变化，但不宣称 OS 级强制只读。
- 保留 `./data:/app/data` 和 `./logs:/app/logs`，不得迁移或清空现有数据。
- Docker 最终 Node PID 1 必须以 UID/GID `1001:1001` 运行。
- `languageHints` 是大小写无关的硬过滤条件；空数组表示不限语言。
- Dismissed Proposal 不可 Apply 或重新打开。
- 所有生产代码行为变更必须先有会因缺失行为而失败的测试。

---

## File Structure

- `src/services/eventProcessor.ts`：普通 Review 分流、多轮 Review 发布守卫和实际 provider 传递。
- `src/services/streamingClaudeExecutor.ts`：Claude 普通 Review 内置静态检查 Prompt。
- `src/services/codexExecutor.ts`：Codex 普通 Review 内置静态检查 Prompt。
- `src/services/gitlabReviewService.ts`：多轮 Review Prompt 构建和 Skill provider 传递。
- `src/admin/reviewCustomizationService.ts`：内置 Prompt Template、发布版本读取、Skill 匹配和 Proposal 状态。
- `src/admin/reviewLanguages.ts`：changed files 到规范化语言的独立映射。
- `src/admin/runtimeConfigService.ts`：配置成功切换后的订阅通知。
- `src/utils/logger.ts`：日志目录和运行时级别调整。
- `src/utils/runtimeConfig.ts`：单例 runtime config 与 logger 订阅连接。
- `src/admin/adminRoutes.ts`：Proposal Dismiss 管理 API。
- `frontend/src/api.ts`、`frontend/src/types.ts`、`frontend/src/pages/ReviewTuning.tsx`：Dismiss 前端合同和操作。
- `docker-entrypoint.sh`：目录权限修复和非 root 降权。
- `Dockerfile`、`Dockerfile.deepflow`：入口依赖、完整构建和启动配置。
- `docker-compose.yml`：完整环境变量注入和日志目录。
- `scripts/verify-runtime-image-files.sh`：基础镜像/入口静态验证。
- `scripts/verify-deepflow-image-files.sh`：DeepFlow 入口和降权依赖验证。

---

### Task 1: Make Review Prompts Static-First

**Files:**

- Modify: `src/services/streamingClaudeExecutor.ts`
- Modify: `src/services/codexExecutor.ts`
- Modify: `src/admin/reviewCustomizationService.ts`
- Test: `src/__tests__/reviewCustomizationService.test.ts`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**

- Consumes: existing prompt template IDs `claude.review.system`, `codex.review.instructions`, and `review.pass.template`.
- Produces: published built-in Review prompts that prohibit unsolicited validation commands.

- [ ] **Step 1: Add failing tests for static-first default prompts**

Add to `src/__tests__/reviewCustomizationService.test.ts`:

```ts
it('keeps built-in review templates static-first unless validation is explicitly requested', async () => {
  const { service } = await buildService();

  for (const id of ['claude.review.system', 'codex.review.instructions', 'review.pass.template']) {
    const body = service.getPromptTemplate(id).versions[0]?.body || '';
    expect(body).toContain(
      'Do not run build, compile, test, lint, or format commands unless the user explicitly requests that validation.'
    );
  }
});
```

Extend the existing Claude/Codex executor option tests in
`src/__tests__/runtimeConfigExecution.test.ts`:

```ts
const executedPrompt = mockQuery.mock.calls[0]?.[0]?.prompt as string;
expect(executedPrompt).toContain(
  'Do not run build, compile, test, lint, or format commands unless the user explicitly requests that validation.'
);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/runtimeConfigExecution.test.ts
```

Expected: FAIL because the current built-in Review prompts only describe how to continue after validation failure and do not prohibit unsolicited validation.

- [ ] **Step 3: Update every built-in Review prompt**

In `src/services/streamingClaudeExecutor.ts`, append this exact policy to
`CLAUDE_REVIEW_SYSTEM_PROMPT`:

```ts
'Do not run build, compile, test, lint, or format commands unless the user explicitly requests that validation. If explicitly requested validation fails, record the result and continue with static inspection.';
```

Apply the same policy to `CODEX_REVIEW_INSTRUCTIONS` in
`src/services/codexExecutor.ts`.

In `DEFAULT_PROMPT_TEMPLATES` within
`src/admin/reviewCustomizationService.ts`, add the same sentence to:

```ts
claude.review.system;
codex.review.instructions;
review.pass.template;
review.scoring.template;
```

Keep the existing migration rule in `ensureDefaultPromptTemplates()`: only a
system version 1 whose draft and version still match the previous default may
be refreshed. Do not overwrite administrator-published templates.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/runtimeConfigExecution.test.ts
```

Expected: both suites PASS; existing assertions still confirm
`permissionMode: 'bypassPermissions'` and `sandboxMode: 'danger-full-access'`.

- [ ] **Step 5: Commit the static-first Review policy**

```bash
git add src/services/streamingClaudeExecutor.ts src/services/codexExecutor.ts src/admin/reviewCustomizationService.ts src/__tests__/reviewCustomizationService.test.ts src/__tests__/runtimeConfigExecution.test.ts
git commit -m "fix: keep default reviews static-first"
```

---

### Task 2: Guard Every Review Publication Path

**Files:**

- Modify: `src/services/eventProcessor.ts`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**

- Consumes: `PreparedReviewContext`, `RuntimeConfig['review']`,
  `GitLabService.getMergeRequest()`, and
  `GitLabReviewService.hasExistingReview()`.
- Produces:
  `ensureReviewCanPublish(event, reviewContext, reviewSettings, runContext): Promise<boolean>`.

- [ ] **Step 1: Add a failing stale-SHA test for the no-candidate path**

Add:

```ts
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
```

- [ ] **Step 2: Add a failing stale-SHA test for the below-threshold path**

Add:

```ts
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
```

- [ ] **Step 3: Run both new tests and verify RED**

Run:

```bash
npm test -- --runInBand src/__tests__/runtimeConfigExecution.test.ts -t "does not publish"
```

Expected: FAIL because both early result paths publish before the current
late-stage SHA guard.

- [ ] **Step 4: Extract a single publication guard**

Add to `EventProcessor`:

```ts
private async ensureReviewCanPublish(
  event: GitLabWebhookEvent,
  reviewContext: PreparedReviewContext,
  reviewSettings: RuntimeConfig['review'],
  runContext: EventRunContext
): Promise<boolean> {
  const latest = await this.gitlabService.getMergeRequest(
    reviewContext.projectId,
    reviewContext.mergeRequestIid
  );

  let message = '';
  if (
    latest.state !== 'opened' ||
    (reviewSettings.skipDraft && (latest.draft || latest.work_in_progress))
  ) {
    message = 'Skipped posting code review: merge request is no longer eligible.';
  } else if (latest.sha && latest.sha !== reviewContext.headSha) {
    message = 'Skipped posting code review: merge request head changed while review was running.';
  } else if (
    reviewSettings.skipExistingSha &&
    (await this.gitlabReviewService.hasExistingReview(
      reviewContext.projectId,
      reviewContext.mergeRequestIid,
      reviewContext.headSha
    ))
  ) {
    message = 'Skipped posting code review: another review was already posted.';
  }

  if (!message) {
    return true;
  }

  await this.postComment(event, message, runContext);
  await this.updateProgressComment(event, runContext, message, true);
  return false;
}
```

Call it immediately before:

```ts
buildIncompleteReviewMessage(); // no candidates
buildNoIssuesMessage(); // no candidates
buildIncompleteReviewMessage(); // no high-confidence findings
buildNoIssuesMessage(); // no high-confidence findings
buildFinalReview() / postReview();
```

Delete the duplicated late-stage MR/SHA/marker block after the scoring branch.

- [ ] **Step 5: Add eligibility and duplicate-marker guard coverage**

Add parameterized tests:

```ts
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
```

For existing tests that reach a terminal Review publication, inject an opened
latest MR with `sha: 'head-sha'` and make the first and publication-time marker
checks return `false`.

- [ ] **Step 6: Run the Review orchestration suite**

Run:

```bash
npm test -- --runInBand src/__tests__/runtimeConfigExecution.test.ts
```

Expected: PASS. Update existing `buildReviewPasses` call assertions only when
Task 5 adds the provider argument.

- [ ] **Step 7: Commit the publication guard**

```bash
git add src/services/eventProcessor.ts src/__tests__/runtimeConfigExecution.test.ts
git commit -m "fix: guard every review result publication"
```

---

### Task 3: Hot-Apply Log Level and Write Logs Under `/app/logs`

**Files:**

- Modify: `src/admin/runtimeConfigService.ts`
- Modify: `src/utils/logger.ts`
- Modify: `src/utils/runtimeConfig.ts`
- Create: `src/__tests__/logger.test.ts`
- Test: `src/__tests__/runtimeConfigService.test.ts`

**Interfaces:**

- Produces:
  `RuntimeConfigService.subscribe(listener: (config: RuntimeConfig) => void): () => void`.
- Produces: `setLogLevel(level: string): void`.
- Uses: `LOG_DIR`, defaulting to `path.resolve(process.cwd(), 'logs')`.

- [ ] **Step 1: Add failing RuntimeConfigService subscription tests**

Add:

```ts
async function buildRuntimeConfigService() {
  const dir = await tempDir();
  const service = new RuntimeConfigService({
    dataDir: dir,
    env: {
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    } as NodeJS.ProcessEnv,
  });
  await service.initialize();
  return service;
}

it('notifies subscribers only after a runtime config update is persisted', async () => {
  const service = await buildRuntimeConfigService();
  const observed: string[] = [];
  const unsubscribe = service.subscribe(config => observed.push(config.logLevel));

  await service.updateConfig({ logLevel: 'debug' }, 'admin');

  expect(observed.at(-1)).toBe('debug');
  unsubscribe();
});

it('does not notify subscribers when persistence fails', async () => {
  const service = await buildRuntimeConfigService();
  const observed: string[] = [];
  service.subscribe(config => observed.push(config.logLevel));
  jest.spyOn((service as any).store, 'write').mockRejectedValueOnce(new Error('disk full'));

  await expect(service.updateConfig({ logLevel: 'debug' }, 'admin')).rejects.toThrow('disk full');
  expect(observed).toEqual([]);
});
```

- [ ] **Step 2: Add failing logger tests**

Create `src/__tests__/logger.test.ts`:

```ts
import logger, { setLogLevel } from '../utils/logger';

describe('logger runtime configuration', () => {
  it('updates the active Winston level', () => {
    const original = logger.level;
    setLogLevel('debug');
    expect(logger.level).toBe('debug');
    setLogLevel(original);
  });

  it('writes file transports below the configured logs directory', () => {
    const filenames = logger.transports
      .map(transport => (transport as { filename?: string }).filename)
      .filter((value): value is string => Boolean(value));

    expect(filenames).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/logs\/error\.log$/),
        expect.stringMatching(/logs\/combined\.log$/),
      ])
    );
  });
});
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- --runInBand src/__tests__/runtimeConfigService.test.ts src/__tests__/logger.test.ts
```

Expected: FAIL because `subscribe` and `setLogLevel` do not exist and file
transports currently use relative root filenames.

- [ ] **Step 4: Implement post-persistence config notifications**

Add to `RuntimeConfigService`:

```ts
private readonly listeners = new Set<(config: RuntimeConfig) => void>();

public subscribe(listener: (config: RuntimeConfig) => void): () => void {
  this.listeners.add(listener);
  return () => this.listeners.delete(listener);
}

private notifyConfigChanged(): void {
  const snapshot = this.getConfig();
  for (const listener of this.listeners) {
    listener(snapshot);
  }
}
```

Call `notifyConfigChanged()` after `this.config` is assigned in `initialize()`,
`updateConfig()`, and `reload()`. Never call it before validation and store
write complete.

- [ ] **Step 5: Implement logger directory and runtime level**

Change `src/utils/logger.ts` to:

```ts
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { config } from './config';

const logDir = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'gitlab-claude-webhook' },
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});

export function setLogLevel(level: string): void {
  logger.level = level;
}

export default logger;
```

Register the singleton listener in `src/utils/runtimeConfig.ts`:

```ts
import { RuntimeConfigService } from '../admin/runtimeConfigService';
import { setLogLevel } from './logger';

export const runtimeConfigService = new RuntimeConfigService();
runtimeConfigService.subscribe(config => setLogLevel(config.logLevel));
```

- [ ] **Step 6: Run focused and integration tests**

```bash
npm test -- --runInBand src/__tests__/runtimeConfigService.test.ts src/__tests__/logger.test.ts src/__tests__/adminRoutes.test.ts
```

Expected: PASS; an admin config update returns no `logLevel` restart field and
the singleton logger changes immediately.

- [ ] **Step 7: Commit logger runtime behavior**

```bash
git add src/admin/runtimeConfigService.ts src/utils/logger.ts src/utils/runtimeConfig.ts src/__tests__/logger.test.ts src/__tests__/runtimeConfigService.test.ts
git commit -m "fix: hot-apply runtime log level"
```

---

### Task 4: Enforce Published Review Prompt Values

**Files:**

- Modify: `src/admin/reviewCustomizationService.ts`
- Test: `src/__tests__/reviewCustomizationService.test.ts`

**Interfaces:**

- Consumes: `ReviewPrompt.currentVersion` and `ReviewPrompt.versions`.
- Produces: `getPublishedReviewPasses()` that treats published empty strings as valid.

- [ ] **Step 1: Add a failing empty-published-value test**

```ts
it('does not fall back to draft instructions when the published value is empty', async () => {
  const { service } = await buildService();

  await service.updatePrompt('bug-scan', {
    draft: { focus: ['Published focus'], systemInstructions: '' },
  });
  await service.publishPrompt('bug-scan', 'Publish empty instructions');
  await service.updatePrompt('bug-scan', {
    draft: { focus: ['Draft focus'], systemInstructions: 'UNPUBLISHED_DRAFT' },
  });

  const pass = service.getPublishedReviewPasses().find(item => item.id === 'bug-scan');
  expect(pass).toMatchObject({
    focus: ['Published focus'],
    systemInstructions: '',
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts -t "does not fall back"
```

Expected: FAIL because `version?.systemInstructions || prompt.draft.systemInstructions`
returns `UNPUBLISHED_DRAFT`.

- [ ] **Step 3: Replace truthy fallback with version-presence logic**

Use:

```ts
const version =
  prompt.versions.find(item => item.version === prompt.currentVersion) ||
  prompt.versions[prompt.versions.length - 1];

return {
  id: prompt.id,
  label: prompt.label,
  version: version?.version || prompt.currentVersion,
  focus: [...(version ? version.focus : prompt.draft.focus)],
  systemInstructions: version ? version.systemInstructions : prompt.draft.systemInstructions,
};
```

- [ ] **Step 4: Run the complete customization suite**

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/gitlabReviewService.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the published-value fix**

```bash
git add src/admin/reviewCustomizationService.ts src/__tests__/reviewCustomizationService.test.ts
git commit -m "fix: honor published review prompt values"
```

---

### Task 5: Match Skills by Language and Actual Provider

**Files:**

- Create: `src/admin/reviewLanguages.ts`
- Modify: `src/admin/reviewCustomizationService.ts`
- Modify: `src/services/gitlabReviewService.ts`
- Modify: `src/services/eventProcessor.ts`
- Create: `src/__tests__/reviewLanguages.test.ts`
- Test: `src/__tests__/reviewCustomizationService.test.ts`
- Test: `src/__tests__/gitlabReviewService.test.ts`
- Test: `src/__tests__/runtimeConfigExecution.test.ts`

**Interfaces:**

- Produces:
  `detectReviewLanguages(paths: string[]): Set<string>`.
- Produces:
  `normalizeReviewLanguageHint(value: string): string | null`.
- Changes:
  `GitLabReviewService.buildReviewPasses(context, userFocus, timeBudget, provider)`.

- [ ] **Step 1: Add failing language normalization tests**

Create `src/__tests__/reviewLanguages.test.ts`:

```ts
import { detectReviewLanguages, normalizeReviewLanguageHint } from '../admin/reviewLanguages';

describe('review language detection', () => {
  it('detects canonical languages from paths and Dockerfile names', () => {
    expect(
      [
        ...detectReviewLanguages([
          'src/app.tsx',
          'agent/src/main.rs',
          'proto/service.proto',
          'Dockerfile.deepflow',
        ]),
      ].sort()
    ).toEqual(['dockerfile', 'protobuf', 'rust', 'typescript']);
  });

  it.each([
    ['TS', 'typescript'],
    ['javascript', 'javascript'],
    ['Py', 'python'],
    ['c++', 'cpp'],
    ['proto', 'protobuf'],
    ['unknown-language', null],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeReviewLanguageHint(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Add failing Skill hard-filter tests**

Extend `src/__tests__/reviewCustomizationService.test.ts`:

```ts
it('matches skills by provider, prompt, file glob, and language together', async () => {
  const { service } = await buildService();
  const skill = await service.createSkill({
    name: 'TypeScript Codex review',
    description: '',
    provider: 'codex',
    fileGlobs: ['src/**'],
    languageHints: ['TS'],
    promptIds: ['bug-scan'],
    systemInstructions: 'Inspect TypeScript state transitions.',
    priority: 10,
  });

  expect(
    service
      .getMatchingSkills({ diffs: [{ new_path: 'src/app.ts' }] }, 'bug-scan', 'codex')
      .map(item => item.id)
  ).toContain(skill.id);
  expect(
    service.getMatchingSkills({ diffs: [{ new_path: 'src/app.rs' }] }, 'bug-scan', 'codex')
  ).toEqual([]);
  expect(
    service.getMatchingSkills({ diffs: [{ new_path: 'src/app.ts' }] }, 'bug-scan', 'claude')
  ).toEqual([]);
});
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- --runInBand src/__tests__/reviewLanguages.test.ts src/__tests__/reviewCustomizationService.test.ts
```

Expected: FAIL because the language helper does not exist and
`languageHints` is not part of matching.

- [ ] **Step 4: Implement canonical language detection**

Create `src/admin/reviewLanguages.ts` with:

```ts
import path from 'path';

const EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.rs': 'rust',
  '.go': 'go',
  '.py': 'python',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.proto': 'protobuf',
  '.tf': 'terraform',
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  'c++': 'cpp',
  cpp: 'cpp',
  proto: 'protobuf',
  protobuf: 'protobuf',
};

for (const language of new Set(Object.values(EXTENSIONS))) {
  ALIASES[language] = language;
}
ALIASES.docker = 'dockerfile';
ALIASES.dockerfile = 'dockerfile';

export function normalizeReviewLanguageHint(value: string): string | null {
  return ALIASES[value.trim().toLowerCase()] || null;
}

export function detectReviewLanguages(paths: string[]): Set<string> {
  const languages = new Set<string>();
  for (const filePath of paths) {
    const base = path.posix.basename(filePath).toLowerCase();
    if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
      languages.add('dockerfile');
      continue;
    }
    const language = EXTENSIONS[path.posix.extname(base)];
    if (language) {
      languages.add(language);
    }
  }
  return languages;
}
```

Use the helper in `getMatchingSkills()`:

```ts
const languages = detectReviewLanguages(changedFiles);

.filter(skill => {
  if (skill.languageHints.length === 0) return true;
  return skill.languageHints
    .map(normalizeReviewLanguageHint)
    .filter((language): language is string => Boolean(language))
    .some(language => languages.has(language));
})
```

- [ ] **Step 5: Pass the actual multi-pass provider into Skill matching**

Change `GitLabReviewService.buildReviewPasses()`:

```ts
public buildReviewPasses(
  context: PreparedReviewContext,
  userFocus?: string,
  timeBudget: TimeBudget = this.getDefaultReviewTimeBudget(),
  provider: 'claude' | 'codex' = 'claude'
): ReviewPassDefinition[] {
  return this.getReviewPassTemplates().map(template => ({
    id: template.id,
    label: template.label,
    prompt: this.buildReviewPassPrompt(
      context,
      template,
      userFocus,
      this.getMatchingSkills(context, template.id, provider),
      timeBudget
    ),
  }));
}
```

Change the EventProcessor call to:

```ts
const reviewPasses = this.gitlabReviewService.buildReviewPasses(
  reviewContext,
  userFocus,
  reviewTimeBudget,
  reviewInstruction.provider
);
```

Update existing mock assertions to expect the fourth argument:

```ts
expect(mockReviewService.buildReviewPasses).toHaveBeenCalledWith(
  reviewContext,
  expectedFocus,
  expect.objectContaining({ timeoutMinutes: expectedMinutes }),
  expectedProvider
);
```

- [ ] **Step 6: Add provider propagation coverage**

In the existing `uses the configured review provider` test, add:

```ts
expect(mockReviewService.buildReviewPasses).toHaveBeenCalledWith(
  reviewContext,
  undefined,
  expect.any(Object),
  'codex'
);
```

In `src/__tests__/gitlabReviewService.test.ts`, add:

```ts
it('uses the actual review provider when matching skills', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-provider-skills-'));
  const customization = new ReviewCustomizationService({ dataDir });
  await customization.initialize();
  await customization.createSkill({
    name: 'Codex TypeScript review',
    description: '',
    provider: 'codex',
    fileGlobs: ['src/**'],
    languageHints: ['typescript'],
    promptIds: ['bug-scan'],
    systemInstructions: 'Inspect TypeScript state transitions.',
    priority: 20,
  });
  const customService = new GitLabReviewService({} as any, customization);

  const codexPasses = customService.buildReviewPasses(context, undefined, undefined, 'codex');
  const claudePasses = customService.buildReviewPasses(context, undefined, undefined, 'claude');

  expect(codexPasses.find(pass => pass.id === 'bug-scan')?.prompt).toContain(
    'Inspect TypeScript state transitions.'
  );
  expect(claudePasses.find(pass => pass.id === 'bug-scan')?.prompt).not.toContain(
    'Inspect TypeScript state transitions.'
  );
});
```

- [ ] **Step 7: Run all Skill and Review tests**

```bash
npm test -- --runInBand src/__tests__/reviewLanguages.test.ts src/__tests__/reviewCustomizationService.test.ts src/__tests__/gitlabReviewService.test.ts src/__tests__/runtimeConfigExecution.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Skill matching**

```bash
git add src/admin/reviewLanguages.ts src/admin/reviewCustomizationService.ts src/services/gitlabReviewService.ts src/services/eventProcessor.ts src/__tests__/reviewLanguages.test.ts src/__tests__/reviewCustomizationService.test.ts src/__tests__/gitlabReviewService.test.ts src/__tests__/runtimeConfigExecution.test.ts
git commit -m "feat: match review skills by language and provider"
```

---

### Task 6: Add Proposal Dismiss End to End

**Files:**

- Modify: `src/admin/reviewCustomizationTypes.ts`
- Modify: `src/admin/reviewCustomizationService.ts`
- Modify: `src/admin/adminRoutes.ts`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/pages/ReviewTuning.tsx`
- Test: `src/__tests__/reviewCustomizationService.test.ts`
- Test: `src/__tests__/adminRoutes.test.ts`

**Interfaces:**

- Produces:
  `ReviewCustomizationService.dismissProposal(id: string): Promise<PromptOptimizationProposal>`.
- Produces:
  `POST /api/admin/prompt-optimizer/proposals/:id/dismiss`.
- Adds: `PromptOptimizationProposal.dismissedAt?: string`.

- [ ] **Step 1: Add failing service tests**

After creating a Proposal from feedback:

```ts
const dismissed = await service.dismissProposal(proposal.id);
expect(dismissed).toMatchObject({ status: 'dismissed' });
expect(dismissed.dismissedAt).toEqual(expect.any(String));
await expect(service.applyProposal(proposal.id)).rejects.toThrow('proposal is not open');
await expect(service.dismissProposal(proposal.id)).rejects.toThrow('proposal is not open');
expect(service.getPrompt('bug-scan').draft).not.toEqual(proposal.suggestedDraft);
```

- [ ] **Step 2: Add a failing admin route test**

```ts
const dismissed = await request(app)
  .post(`/api/admin/prompt-optimizer/proposals/${proposalId}/dismiss`)
  .set('X-Admin-Key', 'admin-secret')
  .expect(200);

expect(dismissed.body.proposal.status).toBe('dismissed');
expect(dismissed.body.proposal.dismissedAt).toEqual(expect.any(String));

await request(app)
  .post(`/api/admin/prompt-optimizer/proposals/${proposalId}/apply`)
  .set('X-Admin-Key', 'admin-secret')
  .expect(400, { error: 'proposal is not open' });
```

- [ ] **Step 3: Run focused backend tests and verify RED**

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/adminRoutes.test.ts
```

Expected: FAIL because `dismissProposal` and the route do not exist.

- [ ] **Step 4: Implement service and route**

Add `dismissedAt?: string` to backend/frontend Proposal types.

Implement:

```ts
public async dismissProposal(id: string): Promise<PromptOptimizationProposal> {
  const proposal = this.findProposal(id);
  if (proposal.status !== 'open') {
    throw new Error('proposal is not open');
  }
  proposal.status = 'dismissed';
  proposal.dismissedAt = now();
  await this.proposalStore.write(this.proposals);
  return clone(proposal);
}
```

Register:

```ts
router.post('/prompt-optimizer/proposals/:id/dismiss', async (req, res, next) => {
  try {
    res.json({ proposal: await reviewCustomizationService.dismissProposal(req.params.id) });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 5: Add frontend API and Dismiss action**

In `frontend/src/api.ts`:

```ts
dismissProposal: (id: string) =>
  request<{ proposal: PromptOptimizationProposal }>(
    `/prompt-optimizer/proposals/${id}/dismiss`,
    { method: 'POST' }
  ),
```

In `ReviewTuning.tsx`, import `XCircle`, add:

```ts
async function dismissProposal(proposal: PromptOptimizationProposal) {
  setBusy(`dismiss-proposal-${proposal.id}`);
  try {
    const result = await api.dismissProposal(proposal.id);
    setProposals(current => replaceById(current, result.proposal));
    setNotice('Proposal dismissed.');
  } catch (err) {
    setFailure(err);
  } finally {
    setBusy('');
  }
}
```

Render Apply and Dismiss as sibling actions:

```tsx
<div className="row-actions">
  <button
    className="button subtle"
    type="button"
    onClick={() => applyProposal(proposal)}
    disabled={Boolean(busy) || proposal.status !== 'open'}
  >
    <Sparkles size={16} />
    Apply
  </button>
  <button
    className="icon-button"
    type="button"
    title="Dismiss proposal"
    aria-label="Dismiss proposal"
    onClick={() => dismissProposal(proposal)}
    disabled={Boolean(busy) || proposal.status !== 'open'}
  >
    <XCircle size={16} />
  </button>
</div>
```

Use existing button dimensions and add only the minimal `.row-actions`
alignment rules:

```css
.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.icon-button {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-secondary);
  cursor: pointer;
}
```

- [ ] **Step 6: Run backend tests and frontend checks**

```bash
npm test -- --runInBand src/__tests__/reviewCustomizationService.test.ts src/__tests__/adminRoutes.test.ts
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Expected: PASS.

- [ ] **Step 7: Verify the Dismiss UI visually**

Start the local app with a temporary data directory and non-conflicting port:

```bash
GITLAB_TOKEN=test \
WEBHOOK_SECRET=test \
ANTHROPIC_AUTH_TOKEN=test \
ADMIN_TOKEN=test \
PORT=3101 \
DATA_DIR=/tmp/gitlab-claude-webhook-plan-admin \
npm run dev

curl --fail -X POST http://127.0.0.1:3101/api/admin/feedback \
  -H 'X-Admin-Key: test' \
  -H 'Content-Type: application/json' \
  -d '{"promptId":"bug-scan","label":"missed_issue","note":"Dismiss UI smoke proposal","source":"admin"}'
curl --fail -X POST http://127.0.0.1:3101/api/admin/prompt-optimizer/analyze \
  -H 'X-Admin-Key: test'
```

Using Playwright, set local storage key `gitlab_claude_admin_key` to `test`,
open `http://127.0.0.1:3101/admin`, click the `Review Tuning` navigation item,
and capture desktop `1440x900` and mobile `390x844` screenshots. Verify:

- Apply and Dismiss do not overlap.
- Both controls remain within the Proposal row.
- Dismiss changes the status to `dismissed`.
- Both actions become disabled after Dismiss.

- [ ] **Step 8: Commit Proposal Dismiss**

```bash
git add src/admin/reviewCustomizationTypes.ts src/admin/reviewCustomizationService.ts src/admin/adminRoutes.ts frontend/src/types.ts frontend/src/api.ts frontend/src/pages/ReviewTuning.tsx frontend/src/index.css src/__tests__/reviewCustomizationService.test.ts src/__tests__/adminRoutes.test.ts
git commit -m "feat: dismiss prompt optimization proposals"
```

---

### Task 7: Make `npm run build` Produce the Complete App

**Files:**

- Modify: `package.json`
- Modify: `Dockerfile`
- Modify: `Dockerfile.deepflow`

**Interfaces:**

- Produces: `build:server`, complete `build`, and compatible `build:all`.

- [ ] **Step 1: Prove the current build contract is incomplete**

Run from a clean `dist`:

```bash
rm -rf dist
npm run build
test -f dist/index.js
test -f dist/public/admin/index.html
```

Expected: the final `test` exits non-zero because current `build` runs only
`tsc`.

- [ ] **Step 2: Update package scripts**

Set:

```json
{
  "build:server": "tsc",
  "build:admin": "npm --prefix frontend install && npm --prefix frontend run build",
  "build": "npm run build:server && npm run build:admin",
  "build:all": "npm run build"
}
```

Keep all unrelated scripts unchanged.

- [ ] **Step 3: Avoid duplicate frontend installation in Docker builds**

In both Dockerfiles replace:

```dockerfile
RUN npm run build
RUN npm --prefix frontend run build
```

with:

```dockerfile
RUN npm run build:server
RUN npm --prefix frontend run build
```

The Dockerfiles already run `npm --prefix frontend ci`, so they must not invoke
the local convenience script that runs `npm install`.

- [ ] **Step 4: Verify complete and server-only build contracts**

```bash
rm -rf dist
npm run build
test -f dist/index.js
test -f dist/public/admin/index.html
rm -rf dist
npm run build:server
test -f dist/index.js
test ! -e dist/public/admin/index.html
npm run build:all
test -f dist/public/admin/index.html
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit build scripts**

```bash
git add package.json Dockerfile Dockerfile.deepflow
git commit -m "build: make default build include admin"
```

---

### Task 8: Fix Docker Bind Permissions, Logs, and Compose Injection

**Files:**

- Create: `docker-entrypoint.sh`
- Create: `scripts/verify-runtime-image-files.sh`
- Modify: `scripts/verify-deepflow-image-files.sh`
- Modify: `Dockerfile`
- Modify: `Dockerfile.deepflow`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

**Interfaces:**

- Produces: entrypoint that fixes ownership then executes as UID/GID 1001.
- Produces: `LOG_DIR=/app/logs`.
- Consumes: all runtime config environment variables from `.env`.

- [ ] **Step 1: Add failing static deployment verification**

Create `scripts/verify-runtime-image-files.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_text() {
  local file="$1"
  local text="$2"
  grep -Fq "$text" "$file" || {
    echo "Missing '$text' in ${file#$ROOT_DIR/}" >&2
    exit 1
  }
}

require_text "$ROOT_DIR/Dockerfile" "su-exec"
require_text "$ROOT_DIR/Dockerfile" "ENTRYPOINT [\"/usr/local/bin/docker-entrypoint.sh\"]"
require_text "$ROOT_DIR/Dockerfile.deepflow" "gosu"
require_text "$ROOT_DIR/Dockerfile.deepflow" "ENTRYPOINT [\"/usr/local/bin/docker-entrypoint.sh\"]"
require_text "$ROOT_DIR/docker-compose.yml" "LOG_DIR=/app/logs"

for key in \
  CLAUDE_DEFAULT_TIMEOUT_MINUTES \
  CODEX_DEFAULT_TIMEOUT_MINUTES \
  REVIEW_ENABLED \
  REVIEW_DEFAULT_PROVIDER \
  REVIEW_MIN_CONFIDENCE \
  REVIEW_MAX_CANDIDATE_FINDINGS \
  REVIEW_MAX_FINAL_FINDINGS \
  REVIEW_PASS_CONCURRENCY \
  REVIEW_SCORING_CONCURRENCY \
  REVIEW_SKIP_DRAFT \
  REVIEW_SKIP_EXISTING_SHA \
  REVIEW_ALLOWED_COMMANDS; do
  require_text "$ROOT_DIR/docker-compose.yml" "$key"
done

echo "Runtime image files look structurally valid."
```

Extend `scripts/verify-deepflow-image-files.sh`:

```bash
require_text "$DOCKERFILE" "gosu"
require_text "$DOCKERFILE" "docker-entrypoint.sh"
```

- [ ] **Step 2: Run static verification and verify RED**

```bash
bash scripts/verify-runtime-image-files.sh
```

Expected: FAIL at the first missing `su-exec`/entrypoint/config value.

- [ ] **Step 3: Add the ownership-and-drop entrypoint**

Create executable `docker-entrypoint.sh`:

```sh
#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
LOG_DIR="${LOG_DIR:-/app/logs}"
WORK_DIR="${WORK_DIR:-/tmp/gitlab-claude-work}"

for dir in "$DATA_DIR" "$LOG_DIR" "$WORK_DIR"; do
  case "$dir" in
    /app/?*|/tmp/?*) ;;
    *)
      echo "Refusing to change ownership of unsafe runtime path: $dir" >&2
      exit 1
      ;;
  esac
  mkdir -p "$dir"
  chown -R 1001:1001 "$dir"
done

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec 1001:1001 "$@"
fi

if command -v gosu >/dev/null 2>&1; then
  exec gosu 1001:1001 "$@"
fi

echo "Neither su-exec nor gosu is available" >&2
exit 1
```

Run:

```bash
chmod +x docker-entrypoint.sh scripts/verify-runtime-image-files.sh
sh -n docker-entrypoint.sh
```

- [ ] **Step 4: Wire both Dockerfiles**

Alpine:

```dockerfile
RUN apk add --no-cache bash git curl ripgrep su-exec
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
ENV LOG_DIR=/app/logs
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
```

DeepFlow Debian:

```dockerfile
      golang-go \
      gosu \
      jq \
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
ENV LOG_DIR=/app/logs
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
```

Remove the final `USER claude` from both Dockerfiles. The image starts the
entrypoint as root, but the entrypoint must `exec` Node as 1001.

- [ ] **Step 5: Complete Compose environment injection**

Add to `docker-compose.yml`:

```yaml
- CLAUDE_DEFAULT_TIMEOUT_MINUTES=${CLAUDE_DEFAULT_TIMEOUT_MINUTES:-30}
- CODEX_DEFAULT_TIMEOUT_MINUTES=${CODEX_DEFAULT_TIMEOUT_MINUTES:-30}
- REVIEW_ENABLED=${REVIEW_ENABLED:-true}
- REVIEW_DEFAULT_PROVIDER=${REVIEW_DEFAULT_PROVIDER:-claude-multipass}
- REVIEW_MIN_CONFIDENCE=${REVIEW_MIN_CONFIDENCE:-80}
- REVIEW_MAX_CANDIDATE_FINDINGS=${REVIEW_MAX_CANDIDATE_FINDINGS:-12}
- REVIEW_MAX_FINAL_FINDINGS=${REVIEW_MAX_FINAL_FINDINGS:-8}
- REVIEW_PASS_CONCURRENCY=${REVIEW_PASS_CONCURRENCY:-4}
- REVIEW_SCORING_CONCURRENCY=${REVIEW_SCORING_CONCURRENCY:-4}
- REVIEW_SKIP_DRAFT=${REVIEW_SKIP_DRAFT:-true}
- REVIEW_SKIP_EXISTING_SHA=${REVIEW_SKIP_EXISTING_SHA:-true}
- REVIEW_ALLOWED_COMMANDS=${REVIEW_ALLOWED_COMMANDS:-/code-review}
- LOG_DIR=/app/logs
```

Add `LOG_DIR=/app/logs` and remove the obsolete manual `chown` requirement
comment from `.env.example`.

- [ ] **Step 6: Run static and Compose verification**

```bash
bash scripts/verify-runtime-image-files.sh
bash scripts/verify-deepflow-image-files.sh
GITLAB_TOKEN=test WEBHOOK_SECRET=test ANTHROPIC_AUTH_TOKEN=test ADMIN_TOKEN=test \
  docker compose config >/tmp/gitlab-claude-webhook-compose.yml
GITLAB_TOKEN=test WEBHOOK_SECRET=test ANTHROPIC_AUTH_TOKEN=test ADMIN_TOKEN=test \
  docker compose -f docker-compose.yml -f docker-compose.deepflow.yml config \
  >/tmp/gitlab-claude-webhook-deepflow-compose.yml
```

Expected: all exit zero.

- [ ] **Step 7: Build and smoke-test the base image**

```bash
docker build -t gitlab-claude-webhook:runtime-hardening .
rm -rf /tmp/gitlab-webhook-data /tmp/gitlab-webhook-logs
mkdir -p /tmp/gitlab-webhook-data /tmp/gitlab-webhook-logs
docker run --rm \
  -v /tmp/gitlab-webhook-data:/app/data \
  -v /tmp/gitlab-webhook-logs:/app/logs \
  gitlab-claude-webhook:runtime-hardening \
  sh -c 'id -u; touch /app/data/write-test; touch /app/logs/write-test'
test "$(stat -c %u /tmp/gitlab-webhook-data/write-test)" = "1001"
test "$(stat -c %u /tmp/gitlab-webhook-logs/write-test)" = "1001"
```

Expected: container prints `1001`; both files are owned by UID 1001.

- [ ] **Step 8: Start the service image and verify file logs**

Use a non-conflicting port:

```bash
docker run -d --name gitlab-webhook-runtime-smoke \
  -p 3102:3102 \
  -e PORT=3102 \
  -e GITLAB_TOKEN=test \
  -e WEBHOOK_SECRET=test \
  -e ANTHROPIC_AUTH_TOKEN=test \
  -e ADMIN_TOKEN=test \
  -v /tmp/gitlab-webhook-data:/app/data \
  -v /tmp/gitlab-webhook-logs:/app/logs \
  gitlab-claude-webhook:runtime-hardening
curl --fail http://127.0.0.1:3102/health
docker exec gitlab-webhook-runtime-smoke sh -c \
  'test "$(awk "/^Uid:/{print \\$2}" /proc/1/status)" = "1001"'
test -s /tmp/gitlab-webhook-logs/combined.log
docker rm -f gitlab-webhook-runtime-smoke
```

Expected: health returns 200, PID 1 UID is 1001, and `combined.log` is non-empty.

- [ ] **Step 9: Build and verify the DeepFlow image**

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml \
  build gitlab-claude-webhook
docker run --rm --entrypoint /usr/local/bin/docker-entrypoint.sh \
  gitlab-claude-webhook-deepflow:latest \
  sh -c 'id -u; cargo --version; rustc --version; go version; protoc --version'
```

Expected: UID is 1001 and all tool commands succeed.

- [ ] **Step 10: Commit Docker and Compose fixes**

```bash
git add docker-entrypoint.sh scripts/verify-runtime-image-files.sh scripts/verify-deepflow-image-files.sh Dockerfile Dockerfile.deepflow docker-compose.yml .env.example
git commit -m "fix: initialize writable container mounts"
```

---

### Task 9: Update Documentation and Run Full Verification

**Files:**

- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/CONFIG.md`
- Modify: `docs/admin-console.md`
- Modify: `docs/gitlab-setup.md`
- Modify: `docs/admin-console-design.md`
- Modify: `docs/superpowers/specs/2026-07-27-branch-capability-documentation-design.md`

**Interfaces:**

- Consumes: completed Tasks 1-8.
- Produces: documentation that describes the resulting implementation without retaining fixed limitations.

- [ ] **Step 1: Update capability and deployment documentation**

Document:

```text
npm run build builds the complete backend and /admin frontend.
npm run build:server is the backend-only build.
build:all remains a compatibility alias.
The container entrypoint repairs ./data and ./logs ownership automatically.
The Node process still runs as UID/GID 1001.
Winston file logs are written to ./logs/error.log and ./logs/combined.log.
Base Compose injects timeout and REVIEW_* settings.
```

Remove instructions requiring operators to run:

```bash
sudo chown -R 1001:1001 data logs
```

- [ ] **Step 2: Update Review and admin documentation**

Document:

```text
Ordinary Review defaults to static diff/source/history inspection and does not
run validation unless the user explicitly requests it.
This is prompt/workflow behavior, not an OS-level read-only sandbox guarantee.
All terminal Review summaries revalidate MR state and head SHA.
LOG_LEVEL applies immediately after a successful admin save.
Published empty systemInstructions remain empty and never fall back to draft.
languageHints and the actual Review provider participate in Skill matching.
Open Proposals support Apply or Dismiss; Dismiss cannot be reopened.
```

Delete the now-obsolete limitations that claim the opposite.

- [ ] **Step 3: Run documentation checks**

```bash
npx prettier --check \
  README.md \
  docs/CONFIG.md \
  docs/admin-console.md \
  docs/gitlab-setup.md \
  docs/admin-console-design.md \
  docs/superpowers/specs/2026-07-27-branch-capability-documentation-design.md
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Run the complete project verification**

```bash
npm run type-check
npm test -- --runInBand
npm run build
bash scripts/verify-runtime-image-files.sh
bash scripts/verify-deepflow-image-files.sh
GITLAB_TOKEN=test WEBHOOK_SECRET=test ANTHROPIC_AUTH_TOKEN=test ADMIN_TOKEN=test \
  docker compose config >/tmp/gitlab-claude-webhook-compose.yml
GITLAB_TOKEN=test WEBHOOK_SECRET=test ANTHROPIC_AUTH_TOKEN=test ADMIN_TOKEN=test \
  docker compose -f docker-compose.yml -f docker-compose.deepflow.yml config \
  >/tmp/gitlab-claude-webhook-deepflow-compose.yml
```

Expected:

```text
TypeScript exits 0.
All Jest suites and tests pass.
dist/index.js and dist/public/admin/index.html exist.
Both image verification scripts pass.
Both Compose configurations parse successfully.
```

- [ ] **Step 5: Assert the excluded SDK permission changes did not occur**

```bash
rg -n "permissionMode: 'bypassPermissions'" src/services/streamingClaudeExecutor.ts
rg -n "sandboxMode: 'danger-full-access'" src/services/codexExecutor.ts
! rg -n "sandboxMode: 'read-only'|sandbox:\\s*\\{" \
  src/services/codexExecutor.ts src/services/streamingClaudeExecutor.ts
```

Expected: the existing Claude/Codex permission settings remain unchanged.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md .env.example docs/CONFIG.md docs/admin-console.md docs/gitlab-setup.md docs/admin-console-design.md docs/superpowers/specs/2026-07-27-branch-capability-documentation-design.md
git commit -m "docs: describe runtime hardening behavior"
```

- [ ] **Step 7: Request final code review**

Generate a review package from the implementation base:

```bash
/root/.codex/skills/subagent-driven-development/scripts/review-package 8bf55a2 HEAD
```

Request a reviewer to inspect correctness, regressions, deployment safety,
tests, and conformance with the explicit no-sandbox-change constraint. Fix all
Critical and Important findings with focused tests and separate commits.

- [ ] **Step 8: Deploy the verified image**

Inspect the currently running Compose configuration:

```bash
docker compose ps
docker inspect gitlab-claude-webhook --format '{{.Config.Image}}'
```

Build the same base/DeepFlow variant currently in use, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml \
  up -d --build gitlab-claude-webhook
```

If the running service uses the base image, use:

```bash
docker compose up -d --build gitlab-claude-webhook
```

Do not run both variants. Preserve the existing `./data` and `./logs`.

- [ ] **Step 9: Verify the deployed service**

```bash
docker compose ps
docker compose logs --tail=100 gitlab-claude-webhook
curl --fail http://127.0.0.1:3000/health
docker exec gitlab-claude-webhook sh -c \
  'test "$(awk "/^Uid:/{print \\$2}" /proc/1/status)" = "1001"'
test -s logs/combined.log
git status --short
```

Use the configured host port instead of `3000` if Compose resolves a different
port. Expected: service is healthy, PID 1 is UID 1001, file logging works, and
the Git worktree is clean.

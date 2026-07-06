# GitLab Claude Webhook 管理后台设计方案

## 目标

为 `gitlab-claude-webhook` 增加一个服务管理页面，风格和交互参考 `/home/server/codex2api` 的管理台，用于运行时配置、review prompt/skill 管理、review 效果评估，以及 CodeRabbit review provider 接入。

本方案优先保持当前 webhook 服务的优势：常驻服务直接处理 GitLab 事件、专用多阶段 review、inline discussion、低冷启动成本。新增管理能力不改变现有 GitLab webhook 使用方式。

## 范围

第一阶段必须交付：

- `/admin` 管理页面
- `/api/admin/*` 管理 API
- 管理鉴权
- 运行时配置读取/保存/热生效
- 基础运行状态、配置脱敏展示、连接测试

第二阶段必须交付：

- review prompt 模板管理
- review skill pack 管理
- prompt 版本发布、回滚
- review 结果记录与人工反馈
- 自动生成 prompt 优化建议，但不自动上线

第三阶段必须交付：

- CodeRabbit CLI provider
- CodeRabbit 配置与连接测试
- CodeRabbit review 结果解析
- 与现有 Claude/Codex 多阶段 review 的 provider 编排

明确不在第一阶段做：

- 多租户 RBAC
- OAuth 登录
- 分布式配置一致性
- 自动修改并上线 prompt
- 替代 CodeRabbit 官方 GitLab App

## 当前系统约束

当前配置在 `src/utils/config.ts` 中启动时读取环境变量并导出单例 `config`。大量服务通过 import 直接读取该对象，因此如果只修改 `.env`，运行中的服务不会自动生效。

当前 review prompt 固定在 `src/services/gitlabReviewService.ts`：

- `CLAUDE.md compliance`
- `Shallow bug scan`
- `History and blame context`
- `Comments and local contracts`
- scoring prompt

当前 review 逻辑有比较强的质量控制：

- 只支持 MR 或 MR comment 的 `/code-review`
- review mode 禁止写文件、提交、改 git state
- 获取 GitLab diff version 的 `baseSha/startSha/headSha`
- 同一 head SHA 使用 marker 防重复 review
- 多 pass 并发产生 candidate findings
- 合并重复 findings
- 对 candidate findings 二次打分
- 只保留 `confidence >= 80` 的结果
- summary comment + inline GitLab discussion

这些能力应该保留，并抽象出可配置层。

## 参考 codex2api 管理台

采用与 `/home/server/codex2api/frontend` 类似的前端形态：

- React + Vite
- React Router
- 左侧导航 + 顶部状态栏
- `/api/admin` 作为管理 API 前缀
- 请求头使用 `X-Admin-Key`
- 本地存储 admin key
- 页面包含 dashboard、settings、runtime、prompt 管理、日志/反馈等模块

本项目不需要完整复制 codex2api 的复杂账户/计费功能，只参考布局、鉴权和设置页交互。

## 总体架构

```text
GitLab Webhook
  -> WebhookServer
  -> EventProcessor
  -> ReviewProviderOrchestrator
       -> ClaudeMultipassProvider
       -> CodexMultipassProvider
       -> CodeRabbitCliProvider
  -> GitLabService

Admin UI
  -> /admin static assets
  -> /api/admin/*
       -> AdminAuthMiddleware
       -> RuntimeConfigService
       -> PromptRegistry
       -> SkillRegistry
       -> ReviewRunStore
       -> ProviderHealthService
```

## 第一阶段：管理后台与运行时配置

### 后端模块

新增目录：

```text
src/admin/
  adminAuth.ts
  adminRoutes.ts
  adminTypes.ts
  runtimeConfigService.ts
  configSchema.ts
  secretMask.ts
  healthService.ts
src/storage/
  jsonStore.ts
  fileLock.ts
```

新增数据目录：

```text
data/
  runtime-config.json
  prompts/
  skills/
  review-runs/
```

Docker 需要挂载：

```yaml
volumes:
  - ./data:/app/data
```

### 配置加载策略

配置来源优先级：

1. 管理后台 runtime config
2. 环境变量
3. 代码默认值

环境变量仍然用于初始启动和兜底。第一次启动时，如果 `data/runtime-config.json` 不存在，使用当前环境变量生成初始配置。

### 热生效配置

以下配置保存后立即用于新任务：

- `ai.defaultProvider`
- `claude.baseUrl`
- `claude.defaultModel`
- `claude.defaultTimeoutMinutes`
- `codex.baseUrl`
- `codex.defaultModel`
- `codex.reasoningEffort`
- `codex.defaultTimeoutMinutes`
- `review.enabled`
- `review.defaultProvider`
- `review.minConfidence`
- `review.maxCandidateFindings`
- `review.maxFinalFindings`
- `review.passConcurrency`
- `review.scoringConcurrency`
- `review.skipDraft`
- `review.skipExistingSha`
- `review.allowedCommands`
- `gitlab.baseUrl`
- `log.level`

以下配置保存后需要重启：

- `webhook.port`
- `workDir`
- Docker volume/network 相关配置

以下配置可以保存但只影响之后创建的新 executor/client：

- `claude.authToken`
- `codex.apiKey`
- `gitlab.token`
- `coderabbit.apiKey`

### RuntimeConfigService

核心接口：

```ts
interface RuntimeConfigService {
  getConfig(): RuntimeConfig;
  getPublicConfig(): PublicRuntimeConfig;
  updateConfig(patch: RuntimeConfigPatch, actor: string): Promise<ConfigUpdateResult>;
  reload(): Promise<void>;
  validateConfig(config: RuntimeConfig): ValidationResult;
  testProvider(provider: 'claude' | 'codex' | 'gitlab' | 'coderabbit'): Promise<TestResult>;
}
```

现有代码改造方向：

- 保留 `src/utils/config.ts` 作为兼容层
- 新增 `getRuntimeConfig()` 和 `runtimeConfigService`
- `EventProcessor`、`StreamingClaudeExecutor`、`CodexExecutor`、`GitLabService` 从 runtime service 读取最新配置
- 不再在模块加载时永久冻结所有配置

### 管理 API

```text
GET    /api/admin/status
GET    /api/admin/config
PUT    /api/admin/config
POST   /api/admin/config/reload
POST   /api/admin/test/gitlab
POST   /api/admin/test/claude
POST   /api/admin/test/codex
GET    /api/admin/runtime
GET    /api/admin/audit-log
```

鉴权：

- 默认用 `ADMIN_TOKEN`
- 请求头 `X-Admin-Key`
- 未配置 `ADMIN_TOKEN` 时管理 API fail-closed
- 所有 secret 字段返回时脱敏

审计：

```json
{
  "id": "uuid",
  "at": "2026-07-05T00:00:00.000Z",
  "actor": "admin",
  "action": "config.update",
  "target": "review.minConfidence",
  "before": 80,
  "after": 85
}
```

### 前端页面

```text
/admin
  Dashboard
  Runtime
  Settings
  Review
  Prompts
  Skills
  Providers
  Feedback
  Logs
```

第一阶段页面：

- Dashboard：服务状态、版本、uptime、内存、最近 webhook、最近 review
- Settings：GitLab、Claude、Codex、webhook、review 基础配置
- Runtime：当前有效配置来源、热生效状态、需要重启项
- Providers：连接测试、模型配置、token 是否已配置
- Logs：最近审计记录和错误摘要

UI 约束：

- 参考 codex2api 的 dense admin layout
- 用 tabs/segmented controls 切换配置组
- secret 字段显示 configured/missing，不直接显示明文
- 保存按钮只在 dirty 状态可用
- 对需要重启的字段显示明确标记
- 连接测试按钮带状态和错误详情

## 第二阶段：Prompt 与 Skill 管理

### Prompt 模型

```ts
interface PromptTemplate {
  id: string;
  name: string;
  kind: 'review-pass' | 'scoring' | 'system' | 'response';
  provider: 'claude' | 'codex' | 'coderabbit' | 'any';
  version: number;
  status: 'draft' | 'published' | 'archived';
  template: string;
  variables: PromptVariable[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}
```

内置 prompt 从当前代码迁移为 seed templates：

- `review-pass.claude-guidelines`
- `review-pass.bug-scan`
- `review-pass.history-context`
- `review-pass.comments-and-contracts`
- `review.scoring`
- `review.no-issues-message`
- `review.incomplete-message`

模板变量：

```text
{{mergeRequest.title}}
{{mergeRequest.url}}
{{sourceBranch}}
{{targetBranch}}
{{changedFiles}}
{{claudeGuidelineFiles}}
{{userFocus}}
{{candidateFinding.title}}
{{candidateFinding.body}}
```

### Skill Pack 模型

```ts
interface ReviewSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  provider: 'claude' | 'codex' | 'coderabbit' | 'any';
  fileGlobs: string[];
  languageHints: string[];
  passTemplateIds: string[];
  systemInstructions: string;
  priority: number;
}
```

示例 skill：

- Security review
- API compatibility review
- Frontend accessibility review
- Database migration review
- Test quality review
- CLAUDE.md compliance

### Prompt/Skill API

```text
GET    /api/admin/prompts
POST   /api/admin/prompts
GET    /api/admin/prompts/:id
PUT    /api/admin/prompts/:id
POST   /api/admin/prompts/:id/publish
POST   /api/admin/prompts/:id/rollback
POST   /api/admin/prompts/render

GET    /api/admin/skills
POST   /api/admin/skills
PUT    /api/admin/skills/:id
POST   /api/admin/skills/:id/enable
POST   /api/admin/skills/:id/disable
```

### Review 结果记录

新增 review run 记录：

```ts
interface ReviewRun {
  id: string;
  projectId: number;
  mergeRequestIid: number;
  headSha: string;
  provider: string;
  status: 'running' | 'completed' | 'partial' | 'failed';
  startedAt: string;
  finishedAt?: string;
  promptVersions: Record<string, number>;
  passResults: ReviewPassResultSummary[];
  findings: StoredReviewFinding[];
  tokenUsage?: TokenUsage;
  errors: string[];
}
```

反馈记录：

```ts
interface ReviewFeedback {
  id: string;
  reviewRunId: string;
  findingKey?: string;
  label: 'useful' | 'false_positive' | 'missed_issue' | 'unclear' | 'accepted' | 'rejected';
  note?: string;
  source: 'admin' | 'gitlab-comment' | 'gitlab-resolution';
  createdAt: string;
}
```

### 自动评估反馈优化

建议做成半自动：

1. 收集 feedback 和 GitLab discussion 状态
2. 定期或手动生成 prompt improvement proposal
3. 管理员查看 diff
4. 管理员发布新版 prompt

不直接自动上线，原因：

- review prompt 会影响所有项目
- 用户评论不一定代表 finding 真伪
- 自动优化可能把临时偏好固化为全局规则

优化建议 API：

```text
POST /api/admin/prompt-optimizer/analyze
GET  /api/admin/prompt-optimizer/proposals
POST /api/admin/prompt-optimizer/proposals/:id/apply
```

## 第三阶段：CodeRabbit 支持

### 官方能力边界

CodeRabbit 有两条路线：

1. GitLab App/Webhook 集成：由 CodeRabbit 自己接收 GitLab 事件并发 review
2. CLI 集成：在本服务 clone 后运行 `cr review`

本项目优先实现 CLI Adapter，因为它可以纳入现有 review orchestrator，并统一输出到 GitLab comment/discussion。

参考：

- CodeRabbit CLI reference: https://docs.coderabbit.ai/cli/reference
- CodeRabbit CLI: https://docs.coderabbit.ai/cli/index
- GitLab.com integration: https://docs.coderabbit.ai/platforms/gitlab-com
- Self-hosted GitLab integration: https://docs.coderabbit.ai/platforms/self-hosted-gitlab

### Provider 抽象

```ts
interface ReviewProvider {
  id: string;
  label: string;
  prepare?(context: PreparedReviewContext, projectPath: string): Promise<void>;
  review(context: PreparedReviewContext, projectPath: string, options: ReviewProviderOptions): Promise<ProviderReviewResult>;
  healthCheck(): Promise<TestResult>;
}
```

内置 provider：

```text
claude-multipass
codex-multipass
coderabbit-cli
hybrid-coderabbit-claude-score
```

### CodeRabbit 配置

```ts
interface CodeRabbitConfig {
  enabled: boolean;
  cliPath: string;
  apiKey: string;
  baseBranchMode: 'targetBranch' | 'mergeBase';
  timeoutMinutes: number;
  extraArgs: string[];
  outputMode: 'agent-json' | 'markdown';
  minSeverity: 'low' | 'medium' | 'high';
}
```

默认命令形态：

```bash
cr review --agent --base origin/<targetBranch>
```

具体参数以安装版本的 `cr review --help` 为准，后台连接测试需要展示 CLI version 和 help 摘要。

### CodeRabbit 输出映射

CodeRabbit findings 需要转换成内部结构：

```ts
interface NormalizedFinding {
  provider: 'coderabbit';
  title: string;
  body: string;
  path: string;
  line?: number;
  lineType: 'new' | 'old';
  severity?: 'low' | 'medium' | 'high';
  confidence?: number;
  category?: string;
}
```

如果 CLI 输出无法稳定定位行号，则只发 summary comment，不发 inline discussion。

### Hybrid 模式

推荐的高级模式：

```text
CodeRabbit CLI 产生候选问题
  -> Claude/Codex scorer 复核
  -> confidence >= threshold
  -> GitLab inline discussion
```

这样可以利用 CodeRabbit 的专业审查能力，同时保留现有二次打分和误报过滤机制。

## 数据存储选择

第一阶段使用 JSON 文件即可：

```text
data/runtime-config.json
data/audit-log.jsonl
data/prompts/*.json
data/skills/*.json
data/review-runs/*.json
```

原因：

- 当前项目没有数据库
- 配置量小
- 便于 Docker volume 备份
- 实现成本低

当 review run 数量增长后，再迁移 SQLite：

```text
data/gitlab-claude-webhook.sqlite
```

迁移触发条件：

- review runs 超过 10k
- 需要复杂查询
- 需要多管理员并发编辑

## 安全设计

- 管理 API 默认 fail-closed
- 所有 secret 字段脱敏返回
- secret 更新支持“留空表示保持原值”
- 配置文件权限建议 `0600`
- audit log 不记录明文 token
- 管理页面不提供 GitLab token 明文导出
- prompt 发布需要二次确认
- CodeRabbit CLI extraArgs 做 allowlist 或严格校验，避免命令注入
- admin static assets 可以公开访问，但 API 必须鉴权

## 兼容性设计

现有 `.env` 继续可用。

启动时如果没有 runtime config：

1. 从 `.env` 读取
2. 生成默认 runtime config
3. 服务按旧行为运行

如果管理配置损坏：

1. 记录错误
2. 回退到 `.env`
3. 管理 API 显示 config degraded

## 实施计划

### Milestone 1：后台骨架与配置热生效

- 新增 admin auth middleware
- 新增 runtime config service
- 新增 JSON store
- 新增 `/api/admin/status`
- 新增 `/api/admin/config`
- 新增 `/api/admin/test/*`
- 前端 Vite app
- Docker build 集成前端静态资源
- 将 executor/GitLabService 改为运行时读取配置

验收：

- 修改默认 Claude/Codex 模型后，新触发任务立即使用新模型
- 修改默认 timeout 后，新任务立即使用新 timeout
- token 字段脱敏显示
- `/health` 不受 admin 影响

### Milestone 2：Prompt/Skill 管理

- seed 当前 review prompt
- prompt CRUD
- prompt render preview
- skill CRUD
- review run 记录
- feedback 标注
- prompt optimizer proposal

验收：

- 修改 bug-scan prompt 并发布后，新 `/code-review` 使用新版 prompt
- 可以回滚 prompt
- review run 页面能看到每个 pass 的 summary、finding、错误

### Milestone 3：CodeRabbit Provider

- CLI 安装检测
- CodeRabbit config
- provider health check
- `coderabbit-cli` review provider
- JSON/markdown 输出解析
- GitLab summary/inline 输出
- hybrid scorer 模式

验收：

- 后台能测试 CodeRabbit CLI 和认证
- `/code-review` 可选择 CodeRabbit provider
- CodeRabbit 结果能进入统一 review run 记录
- hybrid 模式能二次打分并过滤 findings

## 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 当前代码大量 import 静态 config | 热生效不完整 | 先做兼容层，再逐步替换读取点 |
| Prompt 过度自由导致输出不可解析 | review 中断 | 模板校验、render preview、JSON schema parser 容错 |
| CodeRabbit CLI 输出格式变化 | provider 失效 | health check 记录版本，parser 分版本处理 |
| 自动优化 prompt 污染全局行为 | review 质量下降 | 只生成 proposal，人工发布 |
| 管理后台暴露 secret | 安全事故 | 脱敏、留空保持、audit 不记录明文 |
| JSON store 并发写冲突 | 配置损坏 | 文件锁、原子写、备份上一版本 |

## 推荐默认配置

```json
{
  "review": {
    "enabled": true,
    "defaultProvider": "claude-multipass",
    "minConfidence": 80,
    "maxCandidateFindings": 12,
    "maxFinalFindings": 8,
    "passConcurrency": 4,
    "scoringConcurrency": 4,
    "skipDraft": true,
    "skipExistingSha": true
  },
  "coderabbit": {
    "enabled": false,
    "cliPath": "cr",
    "timeoutMinutes": 20,
    "outputMode": "agent-json",
    "minSeverity": "medium"
  }
}
```

## 最终形态

管理后台完成后，本服务会从“写死配置的 GitLab AI webhook”升级为“可运营的 GitLab AI review 服务”：

- 实现类任务继续使用 Claude/Codex
- review 类任务使用 provider orchestrator
- review prompt/skill 可以在线调整
- review 质量可被反馈和迭代
- CodeRabbit 可以作为独立 provider 或候选发现器
- 管理员可以在页面上完成配置、测试、回滚和审计

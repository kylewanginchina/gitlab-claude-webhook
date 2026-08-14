# Runtime Hardening and Admin Completion Design

## 背景

当前分支已经具备 Claude/Codex 通用执行、MR 多轮 Review、运行时配置、
Prompt/Skill/Feedback/Proposal 管理、任务队列和 DeepFlow 构建镜像等能力。
本轮修复代码审查发布、配置热更新、Prompt 版本边界、Skill 匹配、Proposal
管理、构建入口和 Docker 部署中的已知缺口。

## 目标

- 普通 Review 默认只做静态检查，不主动执行编译、构建、测试或 lint。
- 所有 Review 结果发布路径都在发布前验证最新 MR 状态、head SHA 和重复标记。
- `/admin` 保存 `LOG_LEVEL` 后立即影响当前 Winston logger。
- Review Prompt 严格使用已发布版本，包括已发布的空 `systemInstructions`。
- Skill 按实际 provider、文件 glob、prompt ID 和语言共同匹配。
- Proposal 支持 Dismiss，且 dismissed Proposal 不可再 Apply。
- `npm run build` 生成后端和 `/admin` 的完整生产产物。
- Docker bind mount 首次启动不再要求人工修正 UID 1001 权限。
- Winston 文件日志实际写入 `/app/logs`。
- 基础 Compose 完整注入 timeout 和 `REVIEW_*` 环境变量。

## 非目标

- 不修改 Claude 的 `permissionMode`、工具权限模型或 SDK sandbox 配置。
- 不修改 Codex 的 `sandboxMode`。
- 不把 Review 调度拆分为独立容器或独立服务。
- 不在本轮引入日志轮转、集中日志或新的数据库。
- 不升级 Claude Agent SDK 或 Codex SDK，除非实施验证证明现有版本无法支持既有接口。

因此，本轮会降低普通 Review 主动执行构建的概率，但不会把“只读”升级为 OS
级强制保证。Review workflow 仍然不会收集、提交或发布执行器产生的文件变更。

## 方案选择

采用针对性治理方案：保留现有服务边界，分别增加统一 Review 发布守卫、运行时
配置变更通知、语言识别辅助函数、Proposal 状态操作和 Docker 入口脚本。避免把
条件继续散落在现有分支中，也不进行与本轮目标无关的执行框架重构。

## Review 行为

### 默认静态检查

内置 Claude/Codex Review Prompt 和多轮 Review Prompt 明确要求：

- 从 MR diff 开始检查。
- 仅在验证具体 finding 时读取相关源码、history、blame 和局部契约。
- 普通 Review 不执行 build、compile、test、lint 或 format。
- 只有用户在 Review 指令中明确要求运行某项验证时才执行该命令。
- 用户明确要求的验证失败时，将失败作为证据记录，并继续静态检查和输出结论。

管理员发布的自定义 Prompt 仍可覆盖内置策略，这是管理功能的既有设计。
初始化时只刷新仍保持 system version 1、且 draft/version 都未偏离旧默认值的内置
Prompt Template；已经由管理员修改或发布的模板不自动覆盖。

### 统一发布守卫

`EventProcessor` 增加单一 Review 发布守卫，并在每个终态评论发布前调用。守卫：

1. 重新读取 MR。
2. 确认 MR 仍为 opened。
3. 在 `skipDraft` 开启时确认 MR 不是 Draft/WIP。
4. 确认最新 head SHA 与 Review 开始时的 `reviewContext.headSha` 相同。
5. 在 `skipExistingSha` 开启时重新检查相同 SHA 的 Review marker。

守卫覆盖：

- 无候选 finding 的完整或 partial coverage 汇总。
- 评分后无高置信 finding 的完整或 partial coverage 汇总。
- 有 finding 的最终汇总和行内 discussion 发布。

守卫失败时只发布明确的 skipped 状态，不发布旧 Review 结论。GitLab API 不提供
“检查 SHA 并原子发布评论”的事务，因此守卫与评论 API 调用之间仍存在极短的外部
更新窗口；当前设计把检查放在发布前最后一步以尽量缩小该窗口。

## 运行时日志

`src/utils/logger.ts` 暴露受校验的运行时级别更新函数。`RuntimeConfigService` 提供
配置变更订阅机制，并只在配置成功写入 `runtime-config.json`、内存配置切换完成后
通知订阅者。

单例 runtime config service 注册 logger 订阅者：

- 初始化和 reload 后将 logger 同步到当前配置。
- 管理 API 保存成功后立即更新 logger level。
- 配置校验或持久化失败时不更新 logger。
- `webhook.port` 和 `workDir` 仍由 `requiresRestart` 报告；`logLevel` 不再需要重启。

文件 transport 使用 `<LOG_DIR>/error.log` 和 `<LOG_DIR>/combined.log`。`LOG_DIR`
未设置时默认为 `<process.cwd()>/logs`，Docker 中即 `/app/logs`。logger 初始化前
创建目录。

## Prompt 发布边界

`getPublishedReviewPasses()` 需要区分“没有发布版本”和“发布值为空”：

- 找到发布版本时，严格返回该版本的 `focus` 和 `systemInstructions`。
- `systemInstructions: ''` 是有效的已发布值，不回退到 draft。
- 只有损坏或旧数据确实不存在任何发布版本时，才回退到 draft 以保持可恢复性。

保存草稿、发布和回滚的其他行为不变。

## Skill 匹配

### Provider

`GitLabReviewService.buildReviewPasses()` 接收当前多轮 Review 实际使用的
`claude` 或 `codex` provider，并把它传给 `getMatchingSkills()`。不再使用默认
`claude` 代替 Codex Review。

### Language hints

从 MR changed files 的文件名和扩展名识别规范化语言。首批支持：

- TypeScript/JavaScript：`.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs`
- Rust、Go、Python、Java、Kotlin、C、C++、C#
- Ruby、PHP、Shell、SQL
- JSON、YAML、Markdown、Protocol Buffers、Terraform
- 文件名形式的 `Dockerfile`

`languageHints` 大小写无关，并接受常见别名，例如 `ts`/`typescript`、
`js`/`javascript`、`py`/`python`、`cpp`/`c++`、`proto`/`protobuf`。

匹配规则：

- 空 `languageHints` 不限制 Skill。
- 非空 `languageHints` 至少需要与 changed files 检出的一个语言相交。
- 只有未知 hint 或 MR 中没有可识别语言时，不匹配该 Skill。
- provider、promptIds、fileGlobs 和 languageHints 必须同时满足。
- priority 只决定已匹配 Skill 的顺序。

## Proposal Dismiss

现有 `PromptOptimizationProposal.status` 已包含 `dismissed`。补齐以下行为：

- Service：`dismissProposal(id)` 只接受 open Proposal，设置 `status` 为
  `dismissed`、记录 `dismissedAt` 并持久化。
- API：`POST /api/admin/prompt-optimizer/proposals/:id/dismiss`。
- 前端 API 和 Review Tuning 页面增加 Dismiss 操作。
- 只有 open Proposal 显示可用的 Apply/Dismiss。
- applied 或 dismissed Proposal 再次操作返回 400。
- 本轮不增加 reopen；需要重新建议时重新 Analyze feedback。

Dismiss 不修改 Prompt 草稿或版本。

## 构建入口

根 `package.json` 调整为：

- `build:server`：只运行 TypeScript 后端构建。
- `build:admin`：安装管理前端依赖并运行 Vite build。
- `build`：依次运行 `build:server` 和 `build:admin`。
- `build:all`：兼容别名，转调 `build`。

Dockerfile 已提前安装前后端依赖，因此镜像构建直接调用 `build:server` 和前端
build，避免在镜像构建阶段重复安装。`npm run build` 则继续支持干净 clone 的完整
本地构建。

## Docker 启动与日志目录

新增统一入口脚本：

1. 以 root 启动入口。
2. 创建 `DATA_DIR`、`LOG_DIR` 和 `WORK_DIR`。
3. 对现有 bind mount 内容递归修正为 UID/GID `1001:1001`。
4. 使用 Alpine 的 `su-exec` 或 Debian 的 `gosu` 降权。
5. `exec` Node 进程，使最终 PID 1 为非 root 的服务进程。

基础镜像安装 `su-exec`，DeepFlow Debian 镜像安装 `gosu`。两个 Dockerfile 使用
相同入口脚本。保留现有 `./data:/app/data`、`./logs:/app/logs`，不迁移或替换用户
已有数据。

入口脚本只接受镜像中固定的运行目录环境变量；路径为空时启动失败，避免误执行
递归 ownership 修改。

## Compose 配置

基础 `docker-compose.yml` 补充：

- `CLAUDE_DEFAULT_TIMEOUT_MINUTES`
- `CODEX_DEFAULT_TIMEOUT_MINUTES`
- `REVIEW_ENABLED`
- `REVIEW_DEFAULT_PROVIDER`
- `REVIEW_MIN_CONFIDENCE`
- `REVIEW_MAX_CANDIDATE_FINDINGS`
- `REVIEW_MAX_FINAL_FINDINGS`
- `REVIEW_PASS_CONCURRENCY`
- `REVIEW_SCORING_CONCURRENCY`
- `REVIEW_SKIP_DRAFT`
- `REVIEW_SKIP_EXISTING_SHA`
- `REVIEW_ALLOWED_COMMANDS`
- `LOG_DIR=/app/logs`

DeepFlow override 继承基础环境变量，不重复定义。Compose 验证必须覆盖基础文件和
DeepFlow 叠加文件。

## 错误处理

- Review 发布守卫读取 GitLab 失败时不发布 Review 结论，按任务失败路径报告。
- Logger 订阅只接收已经通过 `RuntimeConfigService` 校验的级别。
- Proposal 非 open 状态操作返回现有 validation error 形式的 400。
- 入口脚本无法创建目录、修正权限或降权时立即退出，不以 root 启动 Node。
- 未识别的 language hint 不抛错，以“不匹配”处理，避免旧数据阻止服务启动。

## 测试

所有行为变更使用 TDD：

- Review：分别覆盖“无候选 finding”和“评分后无高置信 finding”时 head SHA
  改变、MR 关闭、Draft 状态和重复 marker。
- Prompt：发布空 `systemInstructions` 后修改草稿，执行仍使用发布空值。
- Logger：运行时保存成功立即改变 logger level；保存失败不改变。
- Skill：覆盖 provider、扩展名、别名、未知语言、多语言 MR 和空 hints。
- Proposal：覆盖 dismiss 成功、重复 dismiss、dismiss 后 apply 以及管理 API。
- Frontend：由管理 API 集成测试覆盖 Dismiss 合同，由 Playwright 在桌面/移动
  视口验证按钮状态和布局，不为这一项单独引入前端单元测试框架。
- Build：`npm run build` 同时生成 `dist/index.js` 和 `dist/public/admin/index.html`。
- Docker：验证入口脚本语法、镜像内降权、bind mount 写入、`/app/logs` 文件输出。
- Compose：验证基础和 DeepFlow 叠加配置。
- 回归：TypeScript type-check、Jest 全量测试、前端构建、Prettier 和
  `git diff --check`。

## 文档更新

实现完成后同步 README、`.env.example`、`docs/CONFIG.md`、
`docs/admin-console.md` 和 `docs/gitlab-setup.md`：

- 删除 `LOG_LEVEL` 需要重启、发布空 Prompt 回退草稿、旧 SHA 提前汇总、
  `languageHints` 仅为元数据、Proposal 无 Dismiss 和人工 chown 等已修复限制。
- 明确普通 Review 默认不运行构建，但不宣称 SDK 已提供强制只读沙箱。
- 将本地构建入口统一为 `npm run build`，保留 `build:all` 兼容说明。

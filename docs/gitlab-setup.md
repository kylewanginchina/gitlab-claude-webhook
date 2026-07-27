# GitLab 接入与 Review 指南

本文说明当前 GitLab Webhook 服务实际支持的配置、触发方式和结果行为。

## 前置条件

- 服务可由 GitLab 项目访问，Webhook URL 为 `https://<服务地址>/webhook`。
- GitLab 访问令牌具备 `api` scope，并且其所属用户或项目访问令牌有读取仓库、在目标项目创建评论、创建分支、推送分支和创建 Merge Request 的权限。
- 如果目标分支或允许推送的分支受保护，需要在 GitLab 的分支保护规则中允许该令牌对应的身份创建服务使用的分支并推送。

服务从环境变量读取初始配置。以下是一个最小示例；使用哪个 AI 提供方，就配置对应的认证信息：

```bash
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=<GitLab API token>
WEBHOOK_SECRET=<与 GitLab Webhook Secret Token 相同的值>
PORT=3000
WEBHOOK_TASK_CONCURRENCY=2

ANTHROPIC_AUTH_TOKEN=<Claude token>
OPENAI_API_KEY=<Codex token>
```

常用可选项包括 `AI_DEFAULT_PROVIDER`（`claude` 或 `codex`）、`CLAUDE_DEFAULT_MODEL`、`CODEX_DEFAULT_MODEL`、两个提供方的 `*_BASE_URL`、`WORK_DIR` 和 `LOG_LEVEL`。`WEBHOOK_TASK_CONCURRENCY` 必须配置为正整数；未设置时默认值为 `2`。

服务启动后会加载持久化 runtime config。该配置中的同名运行时设置会覆盖 `.env` 或进程环境变量中的初始值，包括 Webhook 密钥、端口、并发度、AI 提供方和 Review 设置。

## 配置 GitLab Webhook

在项目的 **Settings > Webhooks** 中新建 Webhook：

1. 将 URL 设置为 `https://<服务地址>/webhook`。
2. 将 **Secret Token** 设置为与 `WEBHOOK_SECRET` 相同的值。
3. 只启用以下事件：
   - **Issues events**
   - **Merge request events**
   - **Comments / Note events**
4. 生产环境使用 HTTPS，并启用 GitLab 的 SSL 验证。

`/webhook` 会验证 `X-Gitlab-Token`。它接受与密钥直接相等的值，也接受以 `sha256=` 开头的 HMAC-SHA256 签名。验证失败返回 `401`；无法解析请求或处理入队失败时返回 `500`。

服务只从 Issue 描述、MR 描述和 Note 正文中提取指令。Issue 或 MR 的无关字段、其他事件类型和不包含有效提及的内容不会启动 AI 任务。

## 发起 AI 请求

使用明确的提供方提及，后跟空格和请求内容：

```text
@claude 解释这个 Issue
@codex 修复这个问题并补充测试
@claude review this merge request
@claude /code-review
@codex[timeout=20] /code-review 重点检查资源泄漏
```

可在提及后添加可选参数：

```text
@claude[model=claude-sonnet-4-20250514] 解释这段实现
@codex[model=gpt-5.1-codex-max,timeout=20] 修复失败的测试
```

- `model` 将模型名传给执行器。
- `timeout` 以分钟为单位；例如 `timeout=20` 表示 20 分钟。
- 指令必须有正文。服务只识别第一个有效的 `@claude` 或 `@codex` 提及。

### 普通编辑任务

Issue、MR 或其评论中的普通指令会在相应基线分支上执行。Issue 使用项目默认分支，MR 使用其源分支。

只有执行结果包含有效的可发布文件变更时，服务才会固定创建时间戳分支（格式为 `claude-<时间戳>-<随机后缀>`）、提交并推送变更，然后创建一个指向原基线分支的 Merge Request。没有有效文件变更时，只会发布文本结果，不会创建分支或 MR。创建分支、推送或创建 MR 失败时，结果评论会保留失败原因。

### 自然语言只读 Review

在 **MR 描述或 MR 评论** 中，包含 `review`、`code review`，或“代码审查”“代码审阅”“代码评审”“审阅”“审查”“评审”等意图的自然语言请求，会以只读 Review 模式运行。例如：

```text
@claude review this merge request
@codex 请审查当前 MR 的代码修改
```

该模式不收集或发布文件变更，也不会创建 commit、branch 或 MR。提示词要求执行器只读，但当前 Claude/Codex 执行器不是强制只读沙箱，不能将其视为 OS 级写保护保证。其文本输出中的反引号文件或行引用，例如 `` `src/server/webhookServer.ts:120` ``，会在文件存在时转换为当前 MR 源分支上对应 blob 与行号的 GitLab 源码链接。

自然语言 Review 只在 MR 上识别。以 `/` 开头、但不属于 runtime config 中 `REVIEW_ALLOWED_COMMANDS` 的请求，不会被当作自然语言 Review 识别。

### `/code-review` 多轮 Review

`/code-review` 是由 `REVIEW_ALLOWED_COMMANDS` 控制的专用命令，默认允许该命令。命令可追加关注点：

```text
@claude /code-review
@codex[timeout=20] /code-review 重点检查资源泄漏
```

它只能在 MR 或 MR 评论上执行。服务会先读取当前 MR diff 和版本信息，再执行多个 Review pass，合并候选问题，使用独立评分阶段复核候选问题，并按配置的置信度阈值过滤结果。最终执行提供方由 runtime config 的 Review 默认提供方决定；提及中的 `model` 和 `timeout` 参数仍会随该请求传递。

与自然语言只读 Review 不同，`/code-review` 会生成结构化汇总，并为可定位到 MR 改动行的高置信度 finding 尝试创建 GitLab 行内 discussion。Review workflow 不收集或发布文件变更，也不会创建 commit、branch 或 MR；单个行内 discussion 创建失败不会阻止汇总评论发布。

## Webhook 队列与状态评论

`POST /webhook` 在任务入队后立即返回 `200`，不会等待 AI 执行完成。响应包含 `runId`、`resourceKey`、`startedImmediately`、`queuePosition`、`resourceQueuePosition`、`queuedAhead`、`running` 和 `globalConcurrency` 等队列信息。

队列按资源键调度：同一项目中的同一 Issue 或同一 MR 串行执行；不同资源可以并行，但全局最多同时运行 `WEBHOOK_TASK_CONCURRENCY` 个任务。若带有效 AI 指令的任务需要等待，服务会在对应 Issue/MR 或原讨论中发布 **AI Agent Queue Status** 评论，其中包含 Run ID、全局及同资源排队位置和当前队列统计。

开始处理后，服务会创建并更新 **AI Agent Progress Report** 评论。服务自身创建的 Queue Status 和 Progress Report 评论带有可识别的状态标题；由这些评论触发的 Note Webhook 会在入队前忽略，避免状态更新再次触发 AI 任务。

## `/code-review` 结果与跳过条件

`/code-review` 汇总带有隐藏的 head SHA 标记。开启 `REVIEW_SKIP_EXISTING_SHA` 时，服务会检查该标记并跳过已经对同一 MR head SHA 记录过的 Review，避免重复发布。

含结构化 finding 的发布前，服务会读取最新 MR 并检查其状态与 head SHA；可定位的 finding 会链接到该 head SHA 对应的 GitLab blob 和具体代码行，并尝试作为 GitLab 行内 discussion 发布。若 Review pass 或评分阶段部分超时或失败，汇总会明确标注 **partial coverage**、已完成阶段和受影响阶段，不能把这种结果视为完整的无问题 Review。

目前“无候选 finding”或“评分后无高置信 finding”的提前汇总发生在这项 head SHA 守卫之前；若 MR 在 Review 开始后更新，这两类汇总仍可能带着开始时的旧 SHA 发布。

Review 还可能因以下当前条件被跳过：Review 在 runtime config 中被禁用、命令不在 MR 上、MR 未打开、Draft/WIP 被 `REVIEW_SKIP_DRAFT` 排除、MR 没有 diff 内容、执行期间 MR head SHA 改变，或同一 head SHA 已有记录的 Review。

## 验证接入

1. 在 GitLab Webhook 页面使用测试投递，确认服务返回 `200`。
2. 创建 Issue、MR 或评论并添加显式提及，例如 `@claude 解释这个 Issue`。
3. 查看响应中的 `runId` 和队列字段；若任务在等待，查看对应资源中的 Queue Status 评论。
4. 查看 Progress Report 与最终结果评论。普通编辑任务仅在有有效文件变更时才会出现新分支和 MR；自然语言 Review 不应创建它们。
5. 在 MR 上运行 `/code-review`，确认汇总包含 head SHA 标记；若存在高置信度且可定位的 finding，检查其源码链接和行内 discussion。测试 MR 在 Review 期间更新 head SHA 时，结构化 finding 应跳过发布；无候选 finding 或评分后无高置信 finding 的提前汇总当前不具备这项保证。

## 故障排查

### Webhook 返回 401

- 确认 GitLab Webhook 的 Secret Token 与当前生效的 `WEBHOOK_SECRET` 一致。
- 若已通过管理端修改过 Webhook 密钥，优先核对 runtime config；它会覆盖 `.env` 中的值。
- 检查请求是否携带 `X-Gitlab-Token`，以及签名格式是否为直接密钥或 `sha256=<HMAC>`。

### 请求一直排队或没有立即执行

- 查看 `POST /webhook` 响应中的 `resourceKey`、`queuePosition`、`resourceQueuePosition` 和 `globalConcurrency`。
- 同一项目的同一 Issue/MR 必须等待前一个任务完成；不同资源也会受全局 `WEBHOOK_TASK_CONCURRENCY` 限制。
- 检查对应资源是否已有 **AI Agent Queue Status** 或 **AI Agent Progress Report** 评论，以及服务日志中该 `runId` 的错误信息。

### Review 被跳过

- 确认请求位于 MR 或 MR 评论中，MR 仍为 opened，并且具有可审查的 diff。
- 检查 runtime config 的 Review 是否启用、`REVIEW_ALLOWED_COMMANDS` 是否包含所用命令，以及 `REVIEW_SKIP_DRAFT` 是否排除了 Draft/WIP MR。
- 自然语言 Review 不识别以 `/` 开头的未知命令；使用已允许的 `/code-review`，或改为不以 `/` 开头的审查请求。
- 对含结构化 finding 的发布，若执行过程后 MR head SHA 已变化，服务会跳过发布以避免把旧 diff 的结论写到新版本。无候选 finding 或评分后无高置信 finding 的提前汇总发生在该检查之前，可能仍按开始时的旧 SHA 发布。

### 提示同一 SHA 已 Review

- 这是 `REVIEW_SKIP_EXISTING_SHA` 生效时的正常去重行为。服务会在 MR discussion 中查找相同 head SHA 的隐藏标记。
- 推送新的提交后，head SHA 改变，可以再次运行 Review；也可在 runtime config 中调整该开关的行为。

### 管理端返回 401 或 503

- 管理 API 使用 `ADMIN_TOKEN`。请求需携带 `X-Admin-Key: <ADMIN_TOKEN>`。
- 未配置 `ADMIN_TOKEN` 时，管理 API 被禁用并返回 `503`；密钥不匹配时返回 `401`。

### Queue 或 Progress 评论更新失败

- 查看服务日志中的 Queue Status 或 progress comment 失败记录。队列状态评论发布失败不会阻止已入队任务继续执行。
- 运行中的进度评论更新失败时，服务会尝试创建一个备用进度评论；备用评论也无法创建时，会停止后续进度更新，但任务仍会继续尝试完成并发布最终结果。
- 检查 GitLab 令牌的 `api` scope、项目评论权限，以及目标 Issue/MR 是否仍可访问。

### 无响应、无法推送或无法创建 MR

- 确认提及格式正确，且所选提供方的认证信息和模型配置有效。
- 检查服务日志中的执行、GitLab API 或 git push 错误。
- 确认令牌可克隆仓库、在服务创建的分支上推送，并创建 Merge Request；同时检查分支保护规则。

更多运行与部署信息见 [README](../README.md)。

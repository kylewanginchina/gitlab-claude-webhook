# 管理控制台操作手册

管理控制台用于查看服务状态、调整运行时配置，以及维护 Review 的提示词、Skill 和反馈优化记录。本文只说明当前已经实现的行为。

## 访问与认证

- 管理页面地址：`http(s)://<host>:<port>/admin`。
- `/admin` 是可加载的静态 SPA；静态页面本身不受管理密钥保护。访问页面后，前端会用管理 API 验证密钥并在未通过时显示登录表单。
- 管理 API 前缀：`/api/admin`，其所有接口均受认证保护。
- 在页面中输入 `ADMIN_TOKEN` 的值。浏览器把该值保存在 `localStorage`，并在每个管理 API 请求中发送 `X-Admin-Key` 请求头。
- 未设置 `ADMIN_TOKEN` 时，管理 API 返回 HTTP `503`；设置错误、缺失或不匹配的 `X-Admin-Key` 时返回 HTTP `401`。

不要把管理页面公开到不可信网络，也不要在共享浏览器配置管理密钥。

## 持久化数据

Docker Compose 将宿主机 `./data` 挂载到容器内 `/app/data`，并设置 `DATA_DIR=/app/data`。管理数据保存在该目录中：

- `runtime-config.json`：运行时配置。
- `prompt-templates.json`：内置执行提示词模板及版本。
- `review-prompts.json`：Review Prompt 及版本。
- `review-skills.json`：Review Skill。
- `review-feedback.json`：Review 反馈记录。
- `prompt-proposals.json`：反馈分析生成的优化提案。

首次启动时，缺失的配置文件会以当前环境变量和内置默认值初始化；之后持久化配置会在后续启动中使用。

## 页面说明

### Dashboard

Dashboard 展示当前服务和公开运行时配置：

- 服务状态、配置是否已加载、版本、启动时长和时间戳。
- 默认 AI provider、Review provider、Review 是否启用及最低置信度。
- Claude 与 Codex 的模型、Base URL、超时和 reasoning effort。
- Review 候选和最终发现数量上限、pass 与评分并发数。
- GitLab、Claude、Codex 和 Webhook 密钥的已配置状态及脱敏值；不会显示密钥原文。
- 工作目录、日志级别、端口、任务并发、草稿 MR/已处理 SHA 跳过选项和允许命令。

### Runtime Settings

Runtime Settings 保存新任务使用的运行时配置，包含：

- AI 默认 provider；Claude 与 Codex 的 Base URL、模型、reasoning effort、超时，以及替换凭据输入框。
- GitLab Base URL 和替换 token。
- Review provider、启用状态、最低置信度、候选/最终发现上限、pass/评分并发、跳过 Draft MR、跳过已处理 SHA 和允许命令。
- 工作目录、日志级别、Webhook 端口、Webhook 任务并发和替换 Webhook 密钥。

保存时，前端只会提交非空的替换凭据；已有密钥保持不变。大多数保存后的配置对新任务立即生效。`webhook.port` 和 `workDir` 变更会在响应的 `requiresRestart` 中标记，需重启服务后才使用新值。`LOG_LEVEL` 虽不会列入该返回字段，但 Winston 实例仅在进程启动时读取它；保存会持久化，仍需重启服务才影响当前 logger。页面的 Reset draft 只恢复本页尚未保存的编辑。

页面中的 GitLab、Claude、Codex Test 按钮分别调用对应的 `/test/*` 接口。这三个接口只检查相应 Base URL 与凭据是否配置，**不会**向 GitLab、Claude 或 Codex 发起远程请求，也不验证凭据可用性。

### Review Tuning

Review Tuning 包含 Prompt Template、Review Prompt、Skill、Feedback 和 Proposal 五部分。所有保存动作通过管理 API 持久化；在下文分别说明哪些内容需要 Publish 才会被 Review 使用。

## Prompt Template

当前内置以下九个 Prompt Template ID：

```text
claude.edit.system
claude.review.system
claude.context.wrapper
claude.review.fallback
codex.edit.instructions
codex.review.instructions
codex.context.wrapper
review.pass.template
review.scoring.template
```

每个模板都可维护标签、描述、enabled、provider、scope 和草稿正文。模板正文可以使用双花括号变量，例如 `{{command}}`；运行时会用当前执行上下文提供的变量替换这些占位符。

保存正文草稿只会更新草稿正文，**不会生效**。Publish 会把当前草稿复制为新的不可变版本，并将其设为当前发布版本；新执行使用该发布版本。Rollback 会先把指定历史版本复制回草稿，再创建一个新的发布版本，因此历史版本本身不会被修改。发布说明会保存到版本记录中。标签、描述、provider、scope 和 enabled 属于模板元数据，保存时直接写入记录；其中 enabled 会立即决定渲染时使用发布正文还是内置回退正文。

禁用模板时，运行时会回退到代码内置的对应模板，而不是使用该模板的已发布正文。页面的 Built-in default 仅显示内置默认正文，不能直接修改。

## Review Prompt

系统首次初始化时提供四个默认 Review pass：

1. `claude-guidelines`：CLAUDE.md compliance。
2. `bug-scan`：Shallow bug scan。
3. `history-context`：History and blame context。
4. `comments-and-contracts`：Comments and local contracts。

每个 Review Prompt 有标签、enabled 状态、provider 字段、focus 行和 systemInstructions 草稿。focus 的 Save draft 仅保存草稿，必须 Publish 才会进入当前发布版本；systemInstructions 也应 Publish 后再依赖其版本生效。Rollback 会从选中的历史版本复制内容并发布为一个新版本。标签、enabled 和 provider 是直接保存的元数据；enabled 会立即影响该 Prompt 是否包含在后续多轮 Review 中。

当前实现有一个例外：若已发布版本的 `systemInstructions` 为空，会回退使用 draft `systemInstructions`。因此该字段的草稿可能在未 Publish 时影响后续 Review；不能笼统认为所有草稿绝不生效。

当前多轮 Review 会使用**所有 enabled Review Prompt** 的已发布 `focus`，并通常使用已发布的 `systemInstructions`；上文所述空 `systemInstructions` 回退是例外。Review Prompt 的 `provider` 字段当前只作为保存的元数据，不会据此筛选多轮 Review 的 Prompt。

## Skill

Skill 包含名称、描述、enabled 状态、provider、fileGlobs、promptIds、languageHints、systemInstructions 和 priority。创建后可编辑，也可以单独 Enable 或 Disable。

当前多轮 Review 的 Skill 匹配实际 provider 固定为 `claude`。因此只有 provider 为 `any` 或 `claude` 的 enabled Skill 可能命中；`codex` 与 `coderabbit` Skill 不会用于当前这条多轮 Review 执行链。之后按以下顺序筛选和排序：

1. `promptIds` 为空时匹配所有 Review Prompt；非空时必须包含当前 Review Prompt ID。
2. `fileGlobs` 为空时匹配所有改动；非空时必须匹配 MR 改动中的新路径或旧路径。
3. 按 `priority` 降序排序；同一 priority 再按 Skill 名称排序。

`languageHints` 当前只作为可配置元数据保存，不参与上述匹配和执行行为。命中的 Skill 的 `systemInstructions` 会加入对应 Review pass。

## Feedback 与 Proposal

Feedback 可以关联一个 Review Prompt，并记录标签、备注和来源。可用标签为：`useful`、`false_positive`、`missed_issue`、`unclear`、`accepted`、`rejected`；可用来源为：`admin`、`gitlab-comment`、`gitlab-resolution`。管理页面新建反馈时来源固定为 `admin`。

Analyze feedback 只会使用同时满足下列条件的记录：

- 有 `promptId`。
- 有非空 `note`。
- 标签为 `false_positive`、`missed_issue`、`unclear`、`accepted` 或 `rejected`。

分析会按 Prompt 分组创建 Proposal，Proposal 记录基准版本、建议草稿、所用反馈和状态。Proposal 只支持 Analyze 和 Apply：Apply proposal 只能应用 open 状态的提案，且**只更新目标 Review Prompt 的草稿**；不会创建版本，也不会自动发布。应用后仍须检查草稿并点击 Publish，新的 Review 才会使用修改。当前没有 reject/dismiss 操作。

## 管理 API

以下所有接口均以 `/api/admin` 为前缀，并要求 `X-Admin-Key`。路径参数 `:id` 是对应模板、Prompt、Skill 或 Proposal 的 ID。

### 服务与运行时配置

- `GET /api/admin/status`：读取服务状态、uptime、版本、配置加载状态和时间戳。
- `GET /api/admin/config`：读取公开运行时配置；密钥仅返回配置状态和脱敏值。
- `PUT /api/admin/config`：更新运行时配置，返回公开配置和 `requiresRestart`。
- `POST /api/admin/config/reload`：从持久化配置文件重新加载运行时配置。
- `POST /api/admin/test/gitlab`：仅检查 GitLab Base URL 和 token 是否已配置。
- `POST /api/admin/test/claude`：仅检查 Claude Base URL 和 token 是否已配置。
- `POST /api/admin/test/codex`：仅检查 Codex Base URL 和 API key 是否已配置。

三个 `/test/*` 接口不发送远程请求。

### Prompt Template

- `GET /api/admin/prompt-templates`：列出 Prompt Template。
- `GET /api/admin/prompt-templates/:id`：读取单个 Prompt Template。
- `PUT /api/admin/prompt-templates/:id`：更新 Prompt Template 元数据和草稿。
- `POST /api/admin/prompt-templates/:id/publish`：发布草稿为新版本。
- `POST /api/admin/prompt-templates/:id/rollback`：从指定版本回滚并创建新发布版本。

### Review Prompt

- `GET /api/admin/prompts`：列出 Review Prompt。
- `POST /api/admin/prompts`：创建 Review Prompt；初始草稿同时成为版本 1。
- `POST /api/admin/prompts/render`：基于指定 Prompt 返回当前草稿的预览文本。
- `GET /api/admin/prompts/:id`：读取单个 Review Prompt。
- `PUT /api/admin/prompts/:id`：更新 Review Prompt 元数据和草稿。
- `POST /api/admin/prompts/:id/publish`：发布草稿为新版本。
- `POST /api/admin/prompts/:id/rollback`：从指定版本回滚并创建新发布版本。

### Skill

- `GET /api/admin/skills`：列出 Skill。
- `POST /api/admin/skills`：创建 Skill。
- `PUT /api/admin/skills/:id`：更新 Skill。
- `POST /api/admin/skills/:id/enable`：启用 Skill。
- `POST /api/admin/skills/:id/disable`：禁用 Skill。

### Feedback 与优化提案

- `GET /api/admin/feedback`：列出反馈记录。
- `POST /api/admin/feedback`：创建反馈记录。
- `GET /api/admin/prompt-optimizer/proposals`：列出优化提案。
- `POST /api/admin/prompt-optimizer/analyze`：根据符合条件的反馈创建提案。
- `POST /api/admin/prompt-optimizer/proposals/:id/apply`：将 open 提案的建议写入目标 Prompt 草稿。

## 建议操作顺序

1. 打开 `/admin`，输入 `ADMIN_TOKEN` 的值，确认 Dashboard 显示配置已加载且密钥仅以脱敏形式出现。
2. 在 Runtime Settings 保存 provider、Webhook 或 Review 控制修改；若响应提示 `requiresRestart`，重启服务后再验证。
3. 在 Review Tuning 修改 Prompt Template 或 Review Prompt 后先 Save draft，检查内容和版本历史，再 Publish。
4. 新建 Skill 时，使用 `any` 或 `claude` provider；按目标 Review Prompt 填写 `promptIds`，按改动路径填写 `fileGlobs`，用 `priority` 控制命中 Skill 的注入顺序。
5. 为指定 Prompt 记录带备注的反馈，运行 Analyze feedback，审查 Proposal 后 Apply proposal；最后发布被修改的 Prompt 草稿。

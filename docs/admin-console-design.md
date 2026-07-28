# GitLab Claude Webhook 管理后台设计

## 目标

管理后台为常驻 GitLab Webhook 服务提供运行时配置和 Review 定制能力。它与
Webhook 执行链共用持久化数据目录：管理员保存的配置会用于后续任务，Review
资产会用于后续多轮 Review。

## 架构

```text
GitLab Webhook
  -> WebhookServer
  -> EventProcessor
       -> StreamingClaudeExecutor | CodexExecutor
       -> GitLabReviewService
  -> GitLabService

Admin SPA (/admin)
  -> /api/admin/*
       -> AdminAuth
       -> RuntimeConfigService
       -> ReviewCustomizationService
       -> JSON stores in DATA_DIR
```

`/admin` 提供静态 SPA。所有 `/api/admin/*` 请求均要求 `X-Admin-Key`，并由
`ADMIN_TOKEN` 验证。未配置 `ADMIN_TOKEN` 时管理 API 保持不可用。

## 运行时配置

运行时配置由 `RuntimeConfigService` 管理，并持久化为
`${DATA_DIR}/runtime-config.json`。首次启动使用环境变量和内置默认值初始化；后续
启动及管理页面保存均以持久化配置为准。

配置包含 Claude、Codex、GitLab、Webhook、Review、工作目录和日志级别。新任务在
开始时读取当前配置；单次 Claude 或 Codex 调用在开始时取得配置快照，因此正在运行
的调用不会被之后的保存修改。

`webhook.port` 与 `workDir` 的保存结果会标记为 `requiresRestart`。其他运行时字段会
用于后续任务；`LOG_LEVEL` 成功保存后会立即更新 Winston 的日志级别。

管理 API 返回密钥的已配置状态与脱敏值，不返回明文。空的替换密钥输入表示保留已有
值。Claude 与 Codex 执行环境会移除继承的 provider 凭据，再注入本次调用所需的运行时
凭据。

## Review 工作流

普通 MR Review 使用 mention 指定的 provider，默认检查 diff、源码和历史。只有用户
明确请求时才运行 build、test、lint、compile 或 format 验证；这一约束由提示词和
工作流实施，不是操作系统级只读沙箱。

`/code-review` 根据运行时 Review provider 执行多个 Review pass，合并候选 finding，
再评分并按置信度阈值发布。所有终态汇总在发布前重新读取 MR，检查其状态与 head SHA；
已关闭、被跳过的草稿 MR、head SHA 已变化，或在 `REVIEW_SKIP_EXISTING_SHA=true` 时已有
相同 SHA Review 的 MR 不会发布新的终态汇总。

Review 不收集或发布文件变更，也不创建 commit、branch 或 Merge Request。可定位的高
置信度 finding 会尝试发布为 GitLab 行内 discussion，汇总中保留 head SHA 标记。

## Prompt 与 Skill

Review Tuning 管理 Prompt Template、Review Prompt、Skill、Feedback 和 Proposal。

Prompt Template 与 Review Prompt 都维护草稿和发布版本。Save draft 不改变执行行为；
Publish 创建新的不可变版本并供后续任务使用；Rollback 从指定历史版本复制内容并发布为
新版本。已发布 Review Prompt 的空 `systemInstructions` 保持为空。

多轮 Review 使用所有启用 Review Prompt 的已发布 `focus` 和 `systemInstructions`。Prompt
的 provider 是保存的元数据，不用于筛选 Review Prompt。

Skill 通过以下条件匹配对应 Review pass：

1. Skill 已启用，且 provider 为 `any` 或与实际 Review provider 相同。
2. `promptIds` 为空，或包含当前 Review Prompt ID。
3. `fileGlobs` 为空，或命中 MR 改动的新路径或旧路径。
4. `languageHints` 为空，或命中从 MR 改动路径识别出的语言。
5. 匹配结果按 `priority` 降序、Skill 名称升序排列。

命中的 Skill 的 `systemInstructions` 会加入对应 Review pass。

## Feedback 与 Proposal

Feedback 可关联 Review Prompt，并保存标签、备注和来源。Analyze feedback 按 Prompt 汇总
符合条件的反馈，生成 Open Proposal。Open Proposal 可 Apply 或 Dismiss：Apply 将建议写入
目标 Review Prompt 草稿，仍需 Publish 才用于后续 Review；Dismiss 后不能重新打开。

## 持久化文件

`DATA_DIR` 下保存以下 JSON 文件：

- `runtime-config.json`：运行时配置。
- `prompt-templates.json`：Prompt Template 及版本。
- `review-prompts.json`：Review Prompt 及版本。
- `review-skills.json`：Review Skill。
- `review-feedback.json`：Review 反馈。
- `prompt-proposals.json`：优化 Proposal。
- `prompt-proposal-transaction.json`：Apply Proposal 的自动恢复事务日志，由服务内部维护。

基础 Compose 将宿主机 `./data` 挂载为 `/app/data`，入口脚本会自动修复 `./data` 和
`./logs` 的 ownership；Node 进程以 UID/GID `1001:1001` 运行。Winston 将错误日志与综合
日志分别写入 `./logs/error.log` 和 `./logs/combined.log`。

## 管理接口

管理接口均以 `/api/admin` 为前缀，覆盖以下资源：

- 状态与运行时配置：`/status`、`/config`、`/config/reload`、`/test/*`。
- Prompt Template：`/prompt-templates` 及其读取、更新、发布和回滚接口。
- Review Prompt：`/prompts` 及其创建、预览、读取、更新、发布和回滚接口。
- Skill：`/skills` 及其创建、更新、启用和禁用接口。
- Feedback 与 Proposal：`/feedback`、`/prompt-optimizer/analyze`、
  `/prompt-optimizer/proposals` 及其 Apply、Dismiss 接口。

Provider 测试接口检查对应 Base URL 与凭据的配置状态，不发起远程请求。

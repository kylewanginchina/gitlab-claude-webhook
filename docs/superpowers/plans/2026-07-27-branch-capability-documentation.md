# 分支能力文档更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 根据当前分支相对 `main` 的全部已实现功能，完成中文 README、配置参考、管理页面指南、GitLab 使用指南和环境变量模板更新。

**架构：** 文档分为五层：README 提供能力与使用入口，`docs/CONFIG.md` 提供完整配置事实，`docs/admin-console.md` 提供管理操作手册，`docs/gitlab-setup.md` 提供 GitLab 接入与使用说明，`.env.example` 提供可执行配置模板。所有描述直接对照当前 TypeScript、Docker 和 Compose 实现，不从规划文档推断能力。

**技术栈：** Markdown、Docker Compose、Node.js 20、TypeScript、Express、Claude Agent SDK、OpenAI Codex SDK

## 全局约束

- 所有本次更新的用户文档统一使用中文。
- 只描述当前代码已经实现的能力。
- 代码标识、环境变量、HTTP 路径、SDK 名称和界面实际标签保持原样。
- 不声称 Provider 测试接口会访问远程服务。
- 不声称每个 AI 请求都会修改代码或创建 Merge Request。
- Docker 命令统一使用 `docker compose`。
- 默认值和允许值必须与 `src/admin/runtimeConfigService.ts` 完全一致。
- 管理接口必须与 `src/admin/adminRoutes.ts` 完全一致。
- 保留当前分支已有的 DeepFlow 镜像说明，但不得把它描述为 DeepFlow 官方发布构建环境。

---

### Task 1：重写 README 能力与使用入口

**文件：**
- 修改：`README.md`

**接口：**
- 输入：`src/utils/webhook.ts` 的 mention 与参数解析规则
- 输入：`src/services/eventProcessor.ts` 的 edit/review 分流和多轮 Review
- 输入：`src/services/runQueue.ts`、`src/server/webhookServer.ts` 的队列行为
- 输出：面向使用者的项目总览、快速开始、使用示例和处理流程

- [ ] **Step 1：记录 README 必须覆盖的当前能力**

在修改前逐项核对以下内容：

```text
Claude Agent SDK / OpenAI Codex SDK
@claude 和 @codex 显式 provider mention
[model=...,timeout=...] 参数
普通 edit 模式
MR 自然语言只读 review 模式
/code-review 多轮 review
默认全局并发 2
相同 MR/Issue 串行、不同资源并行
排队评论和带起始时间的进度评论
/admin 和 /api/admin
Prompt Template / Review Prompt / Skill / Feedback / Proposal
运行时配置持久化与凭据隔离
源码行链接和 GitLab 行内讨论
可选 DeepFlow 工具链镜像
```

- [ ] **Step 2：重写功能总览、快速开始和使用示例**

README 至少包含以下示例，并明确 `/code-review` 只支持 MR：

```text
@claude 请分析这个问题并给出修改
@codex[model=gpt-5.1-codex-max,timeout=20] 修复认证模块
@claude review this merge request
@claude /code-review
@codex /code-review 重点检查并发安全
```

说明 `timeout` 单位为分钟；普通自然语言 Review 使用 mention 指定的 provider，
`/code-review` 使用 `REVIEW_DEFAULT_PROVIDER`。

- [ ] **Step 3：重写处理流程**

处理流程按下列顺序描述：

```text
Webhook 验签
提取 @claude/@codex 指令
按 project + MR/Issue 生成资源键并入队
立即返回 queued 响应
克隆独立工作目录
判断 /code-review、自然语言 review 或普通 edit
执行多轮 review 或单次 SDK 任务
发布 Review 结果，或对 edit 产生的有效文件变更创建分支和 MR
清理临时工作目录
```

- [ ] **Step 4：更新接口、配置摘要、Codex provider 和项目结构**

接口摘要必须列出：

```text
GET /
GET /health
POST /webhook
GET /admin
/api/admin/*
```

Codex 部分明确：

```text
启动时仍生成 ~/.codex/config.toml。
每次 Codex SDK 调用同时传入当前 runtime base URL、API key 和 task-local provider 配置。
管理页面保存的新配置由后续执行读取，无需依赖重启重新生成 config.toml。
```

项目结构补充 `frontend/`、`src/admin/`、`src/storage/`、`runQueue.ts`、
`gitlabReviewService.ts`、`gitlabMarkdown.ts`、`providerEnvironment.ts` 和
`timeBudget.ts`。

- [ ] **Step 5：校验 README**

运行：

```bash
npx prettier --check README.md
rg -n "docker-compose|每个请求.*Merge Request|自动生成.*唯一|Pipeline events|Wiki" README.md
```

预期：Prettier 通过；`rg` 不应发现旧版 `docker-compose` 命令或不准确能力描述。

- [ ] **Step 6：提交 README**

```bash
git add README.md
git commit -m "docs: refresh current capability overview"
```

---

### Task 2：补齐环境变量模板和配置参考

**文件：**
- 修改：`.env.example`
- 修改：`docs/CONFIG.md`

**接口：**
- 输入：`RuntimeConfig` 和 `RuntimeConfigService.createConfigFromEnv`
- 输入：`RuntimeConfigService.restartRequiredFields`
- 输入：`providerEnvironment.ts`
- 输出：完整的环境变量与运行时配置参考

- [ ] **Step 1：补齐 `.env.example`**

模板必须包含下列变量和默认值：

```dotenv
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=sk-your-anthropic-token
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-proj-your-openai-key
AI_DEFAULT_PROVIDER=claude
CLAUDE_DEFAULT_MODEL=claude-sonnet-4-20250514
CLAUDE_REASONING_EFFORT=high
CODEX_DEFAULT_MODEL=gpt-5.1-codex-max
CODEX_REASONING_EFFORT=high
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=glpat-your-gitlab-token
WEBHOOK_SECRET=your-webhook-secret
WEBHOOK_TASK_CONCURRENCY=2
PORT=3000
ADMIN_TOKEN=change-me-admin-token
DATA_DIR=/app/data
CLAUDE_DEFAULT_TIMEOUT_MINUTES=30
CODEX_DEFAULT_TIMEOUT_MINUTES=30
REVIEW_ENABLED=true
REVIEW_DEFAULT_PROVIDER=claude-multipass
REVIEW_MIN_CONFIDENCE=80
REVIEW_MAX_CANDIDATE_FINDINGS=12
REVIEW_MAX_FINAL_FINDINGS=8
REVIEW_PASS_CONCURRENCY=4
REVIEW_SCORING_CONCURRENCY=4
REVIEW_SKIP_DRAFT=true
REVIEW_SKIP_EXISTING_SHA=true
REVIEW_ALLOWED_COMMANDS=/code-review
WORK_DIR=/tmp/gitlab-claude-work
LOG_LEVEL=info
```

- [ ] **Step 2：重构 `docs/CONFIG.md` 的配置表**

按以下分组给出变量、默认值、允许值和用途：

```text
管理认证与数据目录
GitLab 与 Webhook
Claude
Codex
任务队列
多轮 Review
工作目录与日志
DeepFlow 构建参数
```

校验规则必须包含：

```text
port: 1..65535
timeout/concurrency/finding caps: >= 1 的整数
minConfidence: 0..100 的整数
Claude effort: low|medium|high|xhigh|max
Codex effort: minimal|low|medium|high|xhigh
review provider: claude-multipass|codex-multipass
log level: debug|info|warn|error
allowed commands: 逗号或换行分隔的非空字符串
```

明确所有 Webhook 指令仍必须使用 `@claude` 或 `@codex` 显式选择执行器；
`AI_DEFAULT_PROVIDER` 不会覆盖 mention 中的 provider。

- [ ] **Step 3：说明配置优先级、热更新和快照**

写明：

```text
首次启动：环境变量/.env/默认值 -> runtime-config.json
后续启动：runtime-config.json 为运行时事实来源，缺失字段由环境/default 补齐
管理页面保存：写入 runtime-config.json
新执行：读取更新后的 runtime 配置
单次 Claude/Codex executor 调用：捕获一次配置快照
运行中的 executor 调用：不受后续保存影响
```

热更新列表必须包含 Claude/Codex base URL、凭据、模型、reasoning effort、
timeout，GitLab 配置、Webhook secret、task concurrency、全部 Review 控制和
log level。重启项仅写 `webhook.port` 与 `workDir`；Docker volume/network
单独标为部署变更。

- [ ] **Step 4：说明凭据替换与隔离**

准确说明：

```text
管理 API 返回的密钥只有 configured 和 masked。
密钥输入留空表示保留旧值。
新值写入 runtime-config.json。
Claude 执行环境会移除继承的 Anthropic/Claude OAuth 凭据，再注入 runtime token/base URL。
Codex 执行环境会移除继承的 OpenAI/Codex 凭据，再注入 runtime API key。
无需通过重启容器清理旧 provider 环境变量。
```

- [ ] **Step 5：保留并校正 DeepFlow 说明**

所有命令使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml build gitlab-claude-webhook
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml up -d gitlab-claude-webhook
./scripts/verify-deepflow-image-files.sh
```

说明镜像使用 Node 20 Bookworm、rustup stable、Go、protobuf、Clang/LLVM、
libpcap/libelf/libbpf 和 named volume 缓存，但不替代 DeepFlow 官方发布构建镜像。

- [ ] **Step 6：校验配置项覆盖**

运行：

```bash
for key in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN OPENAI_BASE_URL OPENAI_API_KEY AI_DEFAULT_PROVIDER CLAUDE_DEFAULT_MODEL CLAUDE_REASONING_EFFORT CODEX_DEFAULT_MODEL CODEX_REASONING_EFFORT GITLAB_BASE_URL GITLAB_TOKEN WEBHOOK_SECRET WEBHOOK_TASK_CONCURRENCY PORT ADMIN_TOKEN DATA_DIR CLAUDE_DEFAULT_TIMEOUT_MINUTES CODEX_DEFAULT_TIMEOUT_MINUTES REVIEW_ENABLED REVIEW_DEFAULT_PROVIDER REVIEW_MIN_CONFIDENCE REVIEW_MAX_CANDIDATE_FINDINGS REVIEW_MAX_FINAL_FINDINGS REVIEW_PASS_CONCURRENCY REVIEW_SCORING_CONCURRENCY REVIEW_SKIP_DRAFT REVIEW_SKIP_EXISTING_SHA REVIEW_ALLOWED_COMMANDS WORK_DIR LOG_LEVEL; do
  rg -q "$key" .env.example docs/CONFIG.md || exit 1
done
npx prettier --check docs/CONFIG.md
```

预期：循环退出码为 `0`；Prettier 通过。

- [ ] **Step 7：提交配置文档**

```bash
git add .env.example docs/CONFIG.md
git commit -m "docs: complete runtime configuration reference"
```

---

### Task 3：完善管理页面操作手册

**文件：**
- 修改：`docs/admin-console.md`

**接口：**
- 输入：`src/admin/adminRoutes.ts`
- 输入：`src/admin/reviewCustomizationService.ts`
- 输入：`frontend/src/pages/*.tsx`
- 输出：管理页面和管理 API 的完整中文操作说明

- [ ] **Step 1：说明访问、认证和数据持久化**

包含以下事实：

```text
页面：http(s)://<host>:<port>/admin
API 前缀：/api/admin
请求头：X-Admin-Key
未设置 ADMIN_TOKEN：503
错误 ADMIN_TOKEN：401
浏览器 localStorage 保存管理 key
Docker 数据目录：/app/data
```

列出：

```text
runtime-config.json
prompt-templates.json
review-prompts.json
review-skills.json
review-feedback.json
prompt-proposals.json
```

- [ ] **Step 2：说明三个页面**

```text
Dashboard：服务状态、uptime、模型/timeout/effort、并发、Review 门槛、脱敏密钥
Runtime Settings：provider、凭据、Webhook、任务并发、Review 控制、日志和重启字段
Review Tuning：Prompt Template、Review Prompt、Skill、Feedback、Proposal
```

- [ ] **Step 3：记录内置 Prompt Template**

列出当前九个模板 ID：

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

说明双花括号变量、草稿不生效、Publish 创建不可变版本、Rollback 从历史版本
复制并发布新版本、禁用模板时回退到代码内置模板。

- [ ] **Step 4：说明 Review Prompt、Skill 和反馈优化**

准确描述：

```text
默认四个 Review pass
Review Prompt 的 focus/systemInstructions 草稿与发布
当前多轮 Review 使用所有 enabled Review Prompt；Prompt provider 字段作为保存的元数据
当前多轮 Review 的 Skill 匹配 provider 为 claude，因此命中 any/claude Skill
Skill 再按 enabled/promptIds/fileGlobs 匹配并按 priority 降序
languageHints 当前作为可配置元数据保存
Feedback 标签与来源
Analyze feedback 只使用有 promptId、有 note 且标签为 false_positive、
missed_issue、unclear、accepted 或 rejected 的记录
Apply proposal 只更新草稿
最终仍需 Publish
```

- [ ] **Step 5：列出所有管理接口**

按组记录下列路由：

```text
GET /api/admin/status
GET /api/admin/config
PUT /api/admin/config
POST /api/admin/config/reload
POST /api/admin/test/gitlab
POST /api/admin/test/claude
POST /api/admin/test/codex
GET /api/admin/prompt-templates
GET /api/admin/prompt-templates/:id
PUT /api/admin/prompt-templates/:id
POST /api/admin/prompt-templates/:id/publish
POST /api/admin/prompt-templates/:id/rollback
GET /api/admin/prompts
POST /api/admin/prompts
POST /api/admin/prompts/render
GET /api/admin/prompts/:id
PUT /api/admin/prompts/:id
POST /api/admin/prompts/:id/publish
POST /api/admin/prompts/:id/rollback
GET /api/admin/skills
POST /api/admin/skills
PUT /api/admin/skills/:id
POST /api/admin/skills/:id/enable
POST /api/admin/skills/:id/disable
GET /api/admin/feedback
POST /api/admin/feedback
GET /api/admin/prompt-optimizer/proposals
POST /api/admin/prompt-optimizer/analyze
POST /api/admin/prompt-optimizer/proposals/:id/apply
```

明确三个 `/test/*` 接口只判断 URL 与密钥是否已配置。

- [ ] **Step 6：校验路由和 Markdown**

运行：

```bash
rg -o "router\\.(get|put|post)\\('[^']+'" src/admin/adminRoutes.ts
npx prettier --check docs/admin-console.md
```

预期：文档中的路由集合覆盖命令输出；Prettier 通过。

- [ ] **Step 7：提交管理页面文档**

```bash
git add docs/admin-console.md
git commit -m "docs: document admin console operations"
```

---

### Task 4：校正 GitLab 接入和 Review 使用说明

**文件：**
- 修改：`docs/gitlab-setup.md`

**接口：**
- 输入：`WebhookServer.getInstructionText`
- 输入：`EventProcessor.extractInstruction`
- 输入：`GitLabReviewService.postReview`
- 输出：准确的 GitLab 配置、触发和结果说明

- [ ] **Step 1：校正 Webhook 事件**

只保留代码实际处理的事件：

```text
Issues events
Merge request events
Comments / Note events
```

移除 Pipeline、Wiki 以及不存在的 `GITLAB_USE_MR`、`GITLAB_AUTO_MERGE`
配置。说明普通编辑任务有可发布文件变更时，服务固定创建时间戳分支和 MR。

- [ ] **Step 2：增加指令与模式示例**

```text
@claude 解释这个 Issue
@codex 修复这个问题并补充测试
@claude review this merge request
@claude /code-review
@codex[timeout=20] /code-review 重点检查资源泄漏
```

说明自然语言 Review 仅在 MR 上识别；以 `/` 开头但不在
`REVIEW_ALLOWED_COMMANDS` 中的请求不会被自然语言 Review 识别。

- [ ] **Step 3：说明队列和异步响应**

```text
POST /webhook 在入队后返回 200 和 runId/queuePosition 等信息。
任务不在 HTTP 请求生命周期内同步完成。
相同 project + MR/Issue 资源键串行。
不同资源最多运行 WEBHOOK_TASK_CONCURRENCY 个。
等待任务会收到 AI Agent Queue Status 评论。
服务生成的 Queue/Progress 评论不会再次触发 AI 任务。
```

- [ ] **Step 4：说明 Review 结果**

```text
/code-review：多轮 pass -> 候选合并 -> 独立评分 -> 置信度过滤
结果汇总包含 head SHA 隐藏标记，支持避免同一 SHA 重复 Review
高置信度 finding 尝试创建 GitLab 行内 discussion
汇总 finding 链接到对应 blob 和代码行
普通自然语言 Review 输出中的反引号文件/行引用会转换为源码链接
部分阶段失败时标注 partial coverage
```

- [ ] **Step 5：更新故障排查**

增加排队、Review 被跳过、相同 SHA 已 Review、runtime-config 覆盖 `.env`、
管理密钥认证和进度评论更新失败等排查项。

- [ ] **Step 6：校验 GitLab 指南**

运行：

```bash
npx prettier --check docs/gitlab-setup.md
rg -n "Pipeline events|Wiki Page events|GITLAB_USE_MR|GITLAB_AUTO_MERGE|docker-compose" docs/gitlab-setup.md
```

预期：Prettier 通过；`rg` 无输出。

- [ ] **Step 7：提交 GitLab 指南**

```bash
git add docs/gitlab-setup.md
git commit -m "docs: align GitLab setup with current behavior"
```

---

### Task 5：执行跨文档一致性校验

**文件：**
- 检查：`README.md`
- 检查：`.env.example`
- 检查：`docs/CONFIG.md`
- 检查：`docs/admin-console.md`
- 检查：`docs/gitlab-setup.md`

**接口：**
- 输入：Tasks 1-4 的全部文档
- 输出：格式、链接、命令、代码事实和工作树状态的最终证据

- [ ] **Step 1：检查格式和空白错误**

```bash
npx prettier --check README.md docs/CONFIG.md docs/admin-console.md docs/gitlab-setup.md
git diff --check main...HEAD
```

预期：两个命令均退出 `0`。

- [ ] **Step 2：检查本地 Markdown 链接**

运行：

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const files = ['README.md', 'docs/CONFIG.md', 'docs/admin-console.md', 'docs/gitlab-setup.md'];
let failed = false;
for (const file of files) {
  const body = fs.readFileSync(file, 'utf8');
  for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      console.error(`${file}: missing ${target}`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
NODE
```

预期：无输出，退出码为 `0`。

- [ ] **Step 3：校验 Docker 和 DeepFlow 文件**

```bash
GITLAB_TOKEN=test WEBHOOK_SECRET=test ANTHROPIC_AUTH_TOKEN=test ADMIN_TOKEN=test docker compose config >/tmp/gitlab-claude-webhook-compose.yml
./scripts/verify-deepflow-image-files.sh
```

预期：Compose 配置解析成功；DeepFlow 文件校验通过。

- [ ] **Step 4：运行项目验证**

```bash
npm run type-check
npm test -- --runInBand
npm run build:admin
```

预期：TypeScript 类型检查、Jest 测试和管理前端构建均通过。

- [ ] **Step 5：核对最终差异**

```bash
git status --short
git diff --stat main...HEAD
git log --oneline --decorate -8
```

预期：工作树干净；最近提交包含规格、实施计划和四组文档提交。

- [ ] **Step 6：提交验证过程中发现的文档修正**

如果校验产生必要修正，执行：

```bash
git add README.md .env.example docs/CONFIG.md docs/admin-console.md docs/gitlab-setup.md
git commit -m "docs: fix capability documentation validation issues"
```

如果没有修正，不创建空提交。

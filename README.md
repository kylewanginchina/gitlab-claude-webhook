# GitLab Claude Webhook Service

[![CI](https://github.com/kylewanginchina/gitlab-claude-webhook/actions/workflows/ci.yml/badge.svg)](https://github.com/kylewanginchina/gitlab-claude-webhook/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

面向 GitLab Issue、Merge Request（MR）及其评论的 AI Webhook 服务。它通过 Claude Agent SDK 和 OpenAI Codex SDK 执行任务，将处理进度、审查结论或代码变更反馈到 GitLab。

## 功能总览

- 使用 `@claude` 或 `@codex` 显式选择 Claude Agent SDK 或 OpenAI Codex SDK。
- 在 mention 后使用 `[model=...,timeout=...]` 覆盖模型与任务超时；`timeout` 的单位为分钟。
- 普通指令按 edit 模式执行；仅有效文件变更才会创建分支并发起 MR。
- MR 上的自然语言 review 请求以只读模式执行，使用 mention 指定的 provider，不修改工作区或 Git 状态。
- `@claude /code-review` 与 `@codex /code-review` 执行多轮 GitLab MR 审查，可附加关注点；该命令只支持 MR。
- 默认全局并发为 2；同一 MR 或 Issue 串行，不同资源可并行执行。
- Webhook 立即返回已入队响应；排队任务会发布队列评论，执行期间持续更新带起始时间和耗时的进度评论。
- 审查结果可生成源码行链接并发布为 GitLab 行内讨论。
- `/admin` 提供运行时配置与审查定制入口：Prompt Template、Review Prompt、Skill、Feedback 和 Proposal。
- 运行时配置持久化保存，凭据按 provider 隔离；管理页面的新配置会由后续任务直接读取。
- 可选使用包含 DeepFlow 工具链的容器镜像，以在任务中运行所需的构建或验证工具。

## 快速开始

### 前置条件

- Node.js 18+ 或 Docker。
- 可配置 Webhook 的 GitLab 项目。
- GitLab API Token。
- 至少一个 provider 的凭据：Claude 使用 Anthropic Token，Codex 使用 OpenAI API Key。

### 配置

```bash
git clone <repository-url>
cd gitlab-claude-webhook
cp .env.example .env
```

在 `.env` 中填写至少以下值：

```bash
ANTHROPIC_AUTH_TOKEN=your-anthropic-token
OPENAI_API_KEY=your-openai-key
GITLAB_TOKEN=glpat-your-gitlab-token
WEBHOOK_SECRET=your-webhook-secret
ADMIN_TOKEN=change-me-admin-token
```

只使用一个 provider 时，可省略另一个 provider 的凭据。随后在 GitLab 项目中将 Webhook URL 设置为 `http://<host>:3000/webhook`，并启用 Issue、Merge request 和 Comment 事件。Token 需要 `api`、`read_repository` 与 `write_repository` 权限。

完整的 GitLab 配置说明见 [docs/gitlab-setup.md](docs/gitlab-setup.md)，环境变量说明见 [docs/CONFIG.md](docs/CONFIG.md)。

### 启动

本地运行：

```bash
npm install
npm run build
npm start
```

开发模式使用 `npm run dev`。AI SDK 的权限绕过模式要求以非 root 用户运行。

Docker 运行：

```bash
docker compose up -d
docker compose logs -f gitlab-claude-webhook
```

默认镜像只包含常规 Webhook 和 review 所需工具。需要在容器内执行 DeepFlow 编译或验证时，使用仓库提供的可选 DeepFlow 工具链镜像；该镜像增加 Rust/Cargo、Go、protobuf、Clang/LLVM、`libpcap`、`libelf`、`libbpf`、`make` 与 `pkg-config`，并为常用依赖提供缓存。该镜像用于自动化 Review/验证，不替代 DeepFlow 官方发布构建镜像和脚本。

使用 DeepFlow compose overlay 构建并启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml build gitlab-claude-webhook
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml up -d gitlab-claude-webhook
```

## 使用方式

在 Issue、MR 描述或评论中写入以下指令：

```text
@claude 请分析这个问题并给出修改
```

```text
@codex[model=gpt-5.1-codex-max,timeout=20] 修复认证模块
```

`model` 可选；`timeout` 可选，单位为分钟。解析器只接受 `@claude` 和 `@codex` mention，并读取方括号内以逗号分隔的 `model`、`timeout` 参数。

### 普通 edit

普通指令在独立工作目录中执行。任务完成后，服务只会在存在可发布的有效文件变更时创建分支、提交并创建 MR；无变更时仅发布执行结果。

### MR 自然语言 review

在 MR 或其评论中使用包含 review 语义的自然语言：

```text
@claude review this merge request
```

这类请求仅在 MR 上识别为只读 review，使用 mention 指定的 provider。它不会修改文件或 Git 状态，结果作为评论发布到 MR。

### 多轮 `/code-review`

`/code-review` 只支持 MR 或 MR 评论，不支持 Issue。它会按配置执行多轮审查、合并候选问题、评分并发布结果；可在命令后附加专项关注点：

```text
@claude /code-review
@codex /code-review 重点检查并发安全
```

此模式的执行 provider 由运行时配置 `REVIEW_DEFAULT_PROVIDER` 决定，而不是由 mention 决定。可选值为 `claude-multipass` 与 `codex-multipass`。

## 处理流程

1. 验证 GitLab Webhook 签名。
2. 提取 `@claude` 或 `@codex` 指令及可选参数。
3. 使用项目与 MR/Issue 生成资源键，并将任务加入队列。
4. 立即返回 `queued` 响应。
5. 克隆独立工作目录。
6. 判断任务是 `/code-review`、自然语言 review 还是普通 edit。
7. 执行多轮 review，或执行单次 SDK 任务。
8. 发布 Review 结果；或在 edit 产生有效文件变更时创建分支和 MR。
9. 清理临时工作目录。

队列以资源键保证同一 MR 或 Issue 的任务串行，并在全局并发限制内调度不同资源。服务会对未立即启动的 AI 任务发布队列状态评论；执行开始后创建并更新包含开始时间的进度评论。

## 接口摘要

| 方法   | 路径           | 用途                    |
| ------ | -------------- | ----------------------- |
| `GET`  | `/`            | 服务信息                |
| `GET`  | `/health`      | 健康检查                |
| `POST` | `/webhook`     | GitLab Webhook 接收端点 |
| `GET`  | `/admin`       | 管理页面                |
| `*`    | `/api/admin/*` | 管理 API                |

`/admin` 是可直接加载的静态管理 SPA 入口，本身不要求管理认证。浏览器加载页面后，前端 AuthGate 会要求输入 `ADMIN_TOKEN`，并在访问 `/api/admin/*` 时通过 `X-Admin-Key` 携带该令牌；所有管理 API 请求都由管理认证中间件保护。要使用管理 API，必须设置 `ADMIN_TOKEN`。

## 配置摘要

服务首次启动时从环境变量初始化运行时配置，并持久化到 `${DATA_DIR}/runtime-config.json`；后续由管理页面保存的配置会直接用于新任务。密码、Token 和 API Key 在管理 API 中以掩码状态返回，且每个 SDK 任务只注入其所需 provider 凭据。

| 分类       | 主要变量                                                                                               | 默认值或说明                      |
| ---------- | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Claude     | `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_DEFAULT_MODEL`、`CLAUDE_DEFAULT_TIMEOUT_MINUTES` | Claude provider；默认超时 30 分钟 |
| Codex      | `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`CODEX_DEFAULT_MODEL`、`CODEX_DEFAULT_TIMEOUT_MINUTES`            | Codex provider；默认超时 30 分钟  |
| GitLab     | `GITLAB_BASE_URL`、`GITLAB_TOKEN`                                                                      | GitLab 实例与 API Token           |
| Webhook    | `WEBHOOK_SECRET`、`PORT`、`WEBHOOK_TASK_CONCURRENCY`                                                   | 默认端口 3000、全局并发 2         |
| Review     | `REVIEW_ENABLED`、`REVIEW_DEFAULT_PROVIDER`、`REVIEW_ALLOWED_COMMANDS`                                 | 默认命令为 `/code-review`         |
| 管理与存储 | `ADMIN_TOKEN`、`DATA_DIR`                                                                              | 管理认证与运行时数据目录          |
| 工作与日志 | `WORK_DIR`、`LOG_LEVEL`                                                                                | 临时工作目录与日志级别            |

更多变量、默认值和部署配置见 [docs/CONFIG.md](docs/CONFIG.md)。

### Codex provider

启动时服务仍会生成 `~/.codex/config.toml`，以兼容本地与容器环境。每次 Codex SDK 调用都会同时传入当前运行时 Base URL、API Key 和任务本地的 provider 配置。管理页面保存的新 Codex 配置由后续执行直接读取，不需要依赖重启来重新生成 `config.toml`。

## 管理控制台

访问 `/admin` 管理运行时配置、检查 provider 状态，并维护以下审查资产：

- Prompt Template：edit、review、上下文和评分提示词模板。
- Review Prompt：多轮 review 的审查阶段与专项提示。
- Skill：按文件、语言和 provider 匹配的审查规则。
- Feedback：记录有效、误报、遗漏或不清晰的审查反馈。
- Proposal：基于反馈生成并应用或驳回的提示词优化建议。

详细操作见 [docs/admin-console.md](docs/admin-console.md)。

## 项目结构

```text
frontend/                         管理控制台前端
src/admin/                        管理 API、运行时配置与审查定制
src/server/webhookServer.ts       Express Webhook、管理路由与队列入口
src/services/eventProcessor.ts    指令分流、edit 与 review 执行编排
src/services/runQueue.ts          按资源串行、全局并发队列
src/services/gitlabReviewService.ts 多轮 MR review 与结果发布
src/storage/                      JSON 持久化存储
src/utils/webhook.ts              签名校验、mention 和参数解析
src/utils/gitlabMarkdown.ts       进度评论、源码链接与行内讨论格式化
src/utils/providerEnvironment.ts  provider 凭据隔离的执行环境
src/utils/timeBudget.ts           任务超时与收尾时间预算
```

## 开发

```bash
npm run build
npm run lint
npm test
```

## 安全注意事项

- 为每个 GitLab Webhook 配置强随机 `WEBHOOK_SECRET`。
- 按最小权限原则授予 GitLab Token 权限。
- 在生产环境设置强随机 `ADMIN_TOKEN`，并限制管理入口的网络访问。
- 将 `DATA_DIR` 放在受保护的持久化存储中，避免泄露运行时配置和凭据。

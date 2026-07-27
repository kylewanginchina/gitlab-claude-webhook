# 配置参考

服务从系统环境变量和项目根目录的 `.env` 读取初始值。可先复制模板并替换示例凭据：

```bash
cp .env.example .env
```

启动时必须提供 `GITLAB_TOKEN`、`WEBHOOK_SECRET`，并至少提供 `ANTHROPIC_AUTH_TOKEN` 或 `OPENAI_API_KEY` 之一。`ADMIN_TOKEN` 用于访问管理页面和管理 API，应使用足够长的随机值。

## 管理认证与数据目录

| 变量          | 默认值                                | 允许值       | 用途                                                    |
| ------------- | ------------------------------------- | ------------ | ------------------------------------------------------- |
| `ADMIN_TOKEN` | 无                                    | 非空字符串   | 管理页面 `/admin` 与管理 API 的认证令牌。               |
| `DATA_DIR`    | `data`（Docker 镜像中为 `/app/data`） | 可写目录路径 | 持久化 `runtime-config.json` 及 Review 配置数据的目录。 |

## GitLab 与 Webhook

| 变量                       | 默认值               | 允许值            | 用途                             |
| -------------------------- | -------------------- | ----------------- | -------------------------------- |
| `GITLAB_BASE_URL`          | `https://gitlab.com` | GitLab 基础 URL   | GitLab API 地址。                |
| `GITLAB_TOKEN`             | 无                   | 非空字符串        | GitLab API 访问令牌。            |
| `WEBHOOK_SECRET`           | 无                   | 非空字符串        | Webhook 请求验证密钥。           |
| `WEBHOOK_TASK_CONCURRENCY` | `2`                  | 大于等于 1 的整数 | 不同 MR/Issue 任务的全局并发数。 |
| `PORT`                     | `3000`               | `1..65535` 的整数 | Webhook 监听端口。               |

所有 Webhook 指令仍必须显式使用 `@claude` 或 `@codex` 选择执行器，例如 `@claude 修复测试` 或 `@codex[timeout=30] 重构模块`。`AI_DEFAULT_PROVIDER` 不会覆盖指令中的 provider，也不会使省略 mention 的文本成为可执行指令。

## Claude

| 变量                             | 默认值                      | 允许值                                  | 用途                                             |
| -------------------------------- | --------------------------- | --------------------------------------- | ------------------------------------------------ |
| `ANTHROPIC_BASE_URL`             | `https://api.anthropic.com` | Claude API 基础 URL                     | Claude API 端点。                                |
| `ANTHROPIC_AUTH_TOKEN`           | 无                          | 非空字符串                              | Claude API 认证令牌。                            |
| `CLAUDE_DEFAULT_MODEL`           | `claude-sonnet-4-20250514`  | 非空字符串                              | 未在 `@claude[...]` 指令中指定模型时使用的模型。 |
| `CLAUDE_REASONING_EFFORT`        | `high`                      | `low`、`medium`、`high`、`xhigh`、`max` | Claude 默认推理强度。                            |
| `CLAUDE_DEFAULT_TIMEOUT_MINUTES` | `30`                        | 大于等于 1 的整数                       | Claude 单次调用的默认超时分钟数。                |

## Codex

| 变量                            | 默认值                      | 允许值                                      | 用途                                            |
| ------------------------------- | --------------------------- | ------------------------------------------- | ----------------------------------------------- |
| `OPENAI_BASE_URL`               | `https://api.openai.com/v1` | OpenAI API 基础 URL                         | Codex API 端点。                                |
| `OPENAI_API_KEY`                | 无                          | 非空字符串                                  | Codex API 密钥。                                |
| `CODEX_DEFAULT_MODEL`           | `gpt-5.1-codex-max`         | 非空字符串                                  | 未在 `@codex[...]` 指令中指定模型时使用的模型。 |
| `CODEX_REASONING_EFFORT`        | `high`                      | `minimal`、`low`、`medium`、`high`、`xhigh` | Codex 默认推理强度。                            |
| `CODEX_DEFAULT_TIMEOUT_MINUTES` | `30`                        | 大于等于 1 的整数                           | Codex 单次调用的默认超时分钟数。                |

## 任务队列

| 变量                       | 默认值   | 允许值            | 用途                                                                        |
| -------------------------- | -------- | ----------------- | --------------------------------------------------------------------------- |
| `AI_DEFAULT_PROVIDER`      | `claude` | `claude`、`codex` | 运行时默认 AI provider 设置；不会改变 Webhook 指令必须显式 mention 的规则。 |
| `WEBHOOK_TASK_CONCURRENCY` | `2`      | 大于等于 1 的整数 | 任务队列全局并发数；同时见“GitLab 与 Webhook”。                             |

## 多轮 Review

| 变量                            | 默认值             | 允许值                                | 用途                                                            |
| ------------------------------- | ------------------ | ------------------------------------- | --------------------------------------------------------------- |
| `REVIEW_ENABLED`                | `true`             | `true`、`false`                       | 是否启用多轮 Review。只有值恰为 `false` 时关闭。                |
| `REVIEW_DEFAULT_PROVIDER`       | `claude-multipass` | `claude-multipass`、`codex-multipass` | 多轮 Review 的执行器。                                          |
| `REVIEW_MIN_CONFIDENCE`         | `80`               | `0..100` 的整数                       | 保留 finding 所需的最低置信度。                                 |
| `REVIEW_MAX_CANDIDATE_FINDINGS` | `12`               | 大于等于 1 的整数                     | 进入评分阶段的候选 finding 上限。                               |
| `REVIEW_MAX_FINAL_FINDINGS`     | `8`                | 大于等于 1 的整数                     | 最终输出 finding 上限。                                         |
| `REVIEW_PASS_CONCURRENCY`       | `4`                | 大于等于 1 的整数                     | Review pass 的并发数。                                          |
| `REVIEW_SCORING_CONCURRENCY`    | `4`                | 大于等于 1 的整数                     | Review finding 评分的并发数。                                   |
| `REVIEW_SKIP_DRAFT`             | `true`             | `true`、`false`                       | 是否跳过草稿 MR。只有值恰为 `false` 时关闭。                    |
| `REVIEW_SKIP_EXISTING_SHA`      | `true`             | `true`、`false`                       | 是否跳过已处理过相同 SHA 的 Review。只有值恰为 `false` 时关闭。 |
| `REVIEW_ALLOWED_COMMANDS`       | `/code-review`     | 逗号或换行分隔的非空字符串            | 可触发 Review 的命令列表，例如 `/code-review,/review`。         |

## 工作目录与日志

| 变量        | 默认值                    | 允许值                           | 用途                               |
| ----------- | ------------------------- | -------------------------------- | ---------------------------------- |
| `WORK_DIR`  | `/tmp/gitlab-claude-work` | 可写目录路径                     | 克隆仓库和执行任务使用的工作目录。 |
| `LOG_LEVEL` | `info`                    | `debug`、`info`、`warn`、`error` | 服务日志最低级别。                 |

## 配置校验

管理 API 保存运行时配置时执行以下校验：端口必须是 `1..65535` 的整数；超时、并发数和 finding 上限必须是大于等于 1 的整数；`minConfidence` 必须是 `0..100` 的整数。Claude reasoning effort 仅可为 `low`、`medium`、`high`、`xhigh` 或 `max`；Codex reasoning effort 仅可为 `minimal`、`low`、`medium`、`high` 或 `xhigh`；Review provider 仅可为 `claude-multipass` 或 `codex-multipass`；日志级别仅可为 `debug`、`info`、`warn` 或 `error`。`allowedCommands` 在运行时配置中必须是每项均为非空字符串的数组；环境变量输入时使用逗号或换行分隔。

## 运行时配置、优先级与热更新

运行时配置文件位于 `${DATA_DIR}/runtime-config.json`。首次启动时，服务按“环境变量、`.env`、内置默认值”的结果创建完整配置并写入该文件。后续启动时，`runtime-config.json` 是运行时事实来源；文件中缺失的字段才由环境变量或默认值补齐，补齐后的完整结果会重新写入文件。管理页面保存配置时同样写入该文件。

每次新的执行任务会读取当前运行时配置。每次单独的 Claude 或 Codex executor 调用会在开始时捕获一次配置快照，并在整个调用中使用该快照；已经运行中的调用不会受到之后管理页面保存的影响。因此下列保存会立即影响后续执行，无需重启容器：

- Claude 与 Codex 的 base URL、凭据、默认模型、reasoning effort 和超时。
- GitLab base URL 与令牌、Webhook secret、任务并发数、`AI_DEFAULT_PROVIDER`。
- 全部 Review 控制项：启用状态、provider、置信度、finding 上限、两个并发数、两个跳过开关和允许命令。
- `LOG_LEVEL`。

管理 API 的 `requiresRestart` 返回字段只会报告 `webhook.port` 和 `workDir`。端口或工作目录变更后需要重启服务；Docker volume 和 network 属于部署变更，应通过 Compose 或容器部署更新，而不是作为运行时 API 的重启字段处理。

## 凭据替换与隔离

管理 API 对 Claude token、Codex API key、GitLab token 和 Webhook secret 只返回 `configured` 与 `masked` 状态，不返回明文。更新时将密钥输入留空表示保留旧值；提供新值后会写入 `runtime-config.json`。

启动时会生成不含 provider 凭据的子进程基础环境。Claude 执行环境会移除继承的 Anthropic 凭据、Anthropic base URL 和 Claude OAuth 凭据，再注入运行时的 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_BASE_URL`。Codex 执行环境会移除继承的 OpenAI/Codex 凭据和 OpenAI base URL，再注入运行时 API key；运行时 base URL 由 Codex SDK 配置提供。替换凭据后无需通过重启容器来清理旧的 provider 环境变量。

## Docker 配置

可通过环境变量、`.env` 或 Compose 的 `env_file` 向容器传入初始配置。默认 Compose 配置将 `./data` 挂载为 `/app/data`，使 `runtime-config.json` 在容器重建后仍可保留。

## DeepFlow 构建参数

DeepFlow overlay 是供 AI Review 执行常见 DeepFlow 编译和验证命令的可选构建环境。它使用 Node 20 Bookworm、rustup stable、Go、protobuf、Clang/LLVM、`libpcap`、`libelf`、`libbpf` 以及 named volume 缓存；它不替代 DeepFlow 官方发布构建镜像或官方构建流程。

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml build gitlab-claude-webhook
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml up -d gitlab-claude-webhook
./scripts/verify-deepflow-image-files.sh
```

| 变量                              | 默认值                                                                | 用途                     |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| `DEEPFLOW_DEBIAN_MIRROR`          | `https://mirrors.aliyun.com/debian`                                   | Debian 主与更新源。      |
| `DEEPFLOW_DEBIAN_SECURITY_MIRROR` | `https://mirrors.aliyun.com/debian-security`                          | Debian security 源。     |
| `DEEPFLOW_RUSTUP_INIT_URL`        | `https://rsproxy.cn/rustup/dist/x86_64-unknown-linux-gnu/rustup-init` | `rustup-init` 下载地址。 |
| `DEEPFLOW_RUSTUP_DIST_SERVER`     | `https://rsproxy.cn`                                                  | Rust toolchain 分发源。  |
| `DEEPFLOW_RUSTUP_UPDATE_ROOT`     | `https://rsproxy.cn/rustup`                                           | Rustup 更新源。          |

overlay 定义 `deepflow-cargo-registry`、`deepflow-cargo-git`、`deepflow-go-cache`、`deepflow-go-mod-cache`、`deepflow-npm-cache` 和 `deepflow-work` named volume，用于保留依赖、构建缓存和临时工作目录。

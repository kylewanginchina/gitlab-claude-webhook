# 环境配置指南

## 配置文件支持

本项目支持多种环境变量配置方式：

### 1. `.env` 文件配置

在项目根目录创建 `.env` 文件：

```bash
# Claude API配置
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=sk-your-token-here

# OpenAI/Codex API配置 (可选，用于Codex提供者)
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-proj-your-openai-key

# AI 提供者配置 (可选，都有默认值)
AI_DEFAULT_PROVIDER=claude                     # 默认: claude
CLAUDE_DEFAULT_MODEL=claude-sonnet-4-20250514  # 默认: claude-sonnet-4-20250514
CODEX_DEFAULT_MODEL=gpt-5.1-codex-max          # 默认: gpt-5.1-codex-max
CODEX_REASONING_EFFORT=high                    # 默认: high

# GitLab配置
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=glpat-your-token-here

# Webhook配置
WEBHOOK_SECRET=your-secret-here
PORT=3000

# 管理后台配置
ADMIN_TOKEN=change-me-admin-token
DATA_DIR=/app/data

# 运行时默认配置
CLAUDE_DEFAULT_TIMEOUT_MINUTES=30
CODEX_DEFAULT_TIMEOUT_MINUTES=30
REVIEW_ENABLED=true
REVIEW_MIN_CONFIDENCE=80
REVIEW_MAX_CANDIDATE_FINDINGS=12
REVIEW_MAX_FINAL_FINDINGS=8

# 其他配置
WORK_DIR=/tmp/gitlab-claude-work
LOG_LEVEL=info
```

### 2. 变量替换功能

支持在 `.env` 文件中引用其他环境变量：

```bash
# 基础配置
BASE_URL=https://api.example.com
API_VERSION=v1
HOME_DIR=/home/user

# 使用变量替换
ANTHROPIC_BASE_URL=${BASE_URL}
LOG_FILE=${WORK_DIR}/app.log
```

支持两种语法：

- `${VAR}` - 推荐格式
- `$VAR` - 简化格式

### 3. Docker 环境配置

#### 方法1：环境变量传递

```bash
docker run -d \
  -e ANTHROPIC_AUTH_TOKEN=sk-your-token \
  -e GITLAB_TOKEN=glpat-your-token \
  -e WEBHOOK_SECRET=your-secret \
  -p 3000:3000 \
  gitlab-claude-webhook
```

#### 方法2：.env文件挂载

```bash
docker run -d \
  -v $(pwd)/.env:/app/.env:ro \
  -p 3000:3000 \
  gitlab-claude-webhook
```

#### 方法3：Docker Compose

```yaml
version: '3.8'
services:
  gitlab-claude-webhook:
    build: .
    ports:
      - '3000:3000'
    env_file:
      - .env
    # 或者直接指定环境变量
    environment:
      - ANTHROPIC_AUTH_TOKEN=sk-your-token
      - GITLAB_TOKEN=glpat-your-token
      - WEBHOOK_SECRET=your-secret
```

#### 方法4：可选 DeepFlow 构建工具镜像

默认镜像保持轻量，只包含 webhook 服务和常规 review/edit 所需工具。如果希望 AI review 在容器内执行 DeepFlow 的编译或验证命令，可以使用可选覆盖文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml build gitlab-claude-webhook
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml up -d gitlab-claude-webhook
```

该镜像会额外包含：

- Rust/Cargo，用于 DeepFlow agent 相关 `cargo build`/`cargo test`
- Go，用于 DeepFlow server/controller 相关构建检查
- `protobuf-compiler`，提供 `protoc`
- Clang/LLVM、gcc、make、cmake、`pkg-config`
- `libpcap-dev`、`libelf-dev`、`libbpf-dev`
- bash、git、curl、ripgrep 等仓库检查工具

覆盖文件会增加以下 named volume 缓存：

| Volume                    | 用途                      |
| ------------------------- | ------------------------- |
| `deepflow-cargo-registry` | Cargo registry 缓存       |
| `deepflow-cargo-git`      | Cargo git dependency 缓存 |
| `deepflow-go-cache`       | Go build cache            |
| `deepflow-go-mod-cache`   | Go module cache           |
| `deepflow-npm-cache`      | npm cache                 |
| `deepflow-work`           | DeepFlow 临时构建目录     |

可以用以下命令确认当前容器内工具链：

```bash
docker exec gitlab-claude-webhook sh -lc 'node --version && npm --version && cargo --version && rustc --version && go version && protoc --version && clang --version | head -n 1 && make --version | head -n 1 && pkg-config --version'
```

该镜像基于 Debian/Node 20 安装通用构建工具，目标是让 AI review 可以执行常见 DeepFlow 编译/验证命令。若要生产级复刻 DeepFlow 官方发布构建，请仍以 DeepFlow 官方 `hub.deepflow.yunshan.net/public/rust-build` 镜像和官方构建脚本为准。

可选构建参数：

| 变量                              | 默认值                                       | 说明                  |
| --------------------------------- | -------------------------------------------- | --------------------- |
| `DEEPFLOW_DEBIAN_MIRROR`          | `https://mirrors.aliyun.com/debian`          | Debian main/update 源 |
| `DEEPFLOW_DEBIAN_SECURITY_MIRROR` | `https://mirrors.aliyun.com/debian-security` | Debian security 源    |

如果构建环境访问官方 Debian 源更快，可以覆盖为：

```bash
DEEPFLOW_DEBIAN_MIRROR=http://deb.debian.org/debian \
DEEPFLOW_DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security \
docker compose -f docker-compose.yml -f docker-compose.deepflow.yml build gitlab-claude-webhook
```

### 4. 配置优先级

服务启动时会先加载环境变量和 `.env`，再用管理后台保存的运行时配置覆盖这些默认来源。

运行时配置优先级（高到低）：

1. 管理后台保存的 `${DATA_DIR}/runtime-config.json`
2. 系统环境变量
3. `.env` 文件
4. 默认值

第一次启动且 `${DATA_DIR}/runtime-config.json` 不存在时，服务会从环境变量、`.env` 和默认值生成初始运行时配置。

### 5. 调试配置

在非生产环境下，应用启动时会显示配置调试信息：

```bash
NODE_ENV=development npm start
```

输出示例：

```
🔧 Configuration Debug Information:
=====================================

📁 Environment Files:
Working Directory: /app
NODE_ENV: development

🔑 Loaded Configuration:
Anthropic Base URL: https://api.anthropic.com
Anthropic Auth Token: ***e4f5g6h7
GitLab Base URL: https://gitlab.com
GitLab Token: ***h7i8j9k0
...
```

### 6. 必需与可选配置项

#### 核心必需配置（启动时验证）

- `GITLAB_TOKEN` - GitLab API 令牌
- `WEBHOOK_SECRET` - Webhook 验证密钥

#### AI 提供者配置（根据使用情况）

**使用 Claude 时必需：**

- `ANTHROPIC_AUTH_TOKEN` - Anthropic API 令牌

**使用 Codex 时必需：**

- `OPENAI_API_KEY` - OpenAI API 令牌

**可选配置（都有默认值）：**

| 配置项                           | 说明                        | 默认值                      |
| -------------------------------- | --------------------------- | --------------------------- |
| `AI_DEFAULT_PROVIDER`            | 默认 AI 提供者              | `claude`                    |
| `ANTHROPIC_BASE_URL`             | Anthropic API 基础 URL      | `https://api.anthropic.com` |
| `OPENAI_BASE_URL`                | OpenAI API 基础 URL         | `https://api.openai.com/v1` |
| `CLAUDE_DEFAULT_MODEL`           | Claude 默认模型             | `claude-sonnet-4-20250514`  |
| `CODEX_DEFAULT_MODEL`            | Codex 默认模型              | `gpt-5.1-codex-max`         |
| `CODEX_REASONING_EFFORT`         | Codex 推理等级              | `high`                      |
| `CLAUDE_DEFAULT_TIMEOUT_MINUTES` | Claude 默认超时时间（分钟） | `30`                        |
| `CODEX_DEFAULT_TIMEOUT_MINUTES`  | Codex 默认超时时间（分钟）  | `30`                        |
| `REVIEW_ENABLED`                 | 是否默认启用 review         | `true`                      |
| `REVIEW_MIN_CONFIDENCE`          | review 置信度阈值           | `80`                        |
| `REVIEW_MAX_CANDIDATE_FINDINGS`  | review 候选问题上限         | `12`                        |
| `REVIEW_MAX_FINAL_FINDINGS`      | review 最终问题上限         | `8`                         |

### 7. 配置模板

复制 `.env.example` 文件作为配置模板：

```bash
cp .env.example .env
# 然后编辑 .env 文件，填入实际的配置值
```

这样可以确保包含所有必要的配置项。

## 管理后台配置

管理后台路径为 `/admin`，管理 API 前缀为 `/api/admin`。

必需变量：

| 配置项        | 说明                                    |
| ------------- | --------------------------------------- |
| `ADMIN_TOKEN` | 管理后台登录密钥，请使用长随机字符串    |
| `DATA_DIR`    | 运行时配置目录，Docker 默认 `/app/data` |

保存到管理后台的运行时配置位于 `${DATA_DIR}/runtime-config.json`。第一次启动时如果文件不存在，服务会从 `.env` 生成初始配置。

Prompt/Skill/反馈优化数据也位于 `${DATA_DIR}`：

| 文件                    | 说明                                   |
| ----------------------- | -------------------------------------- |
| `review-prompts.json`   | review prompt 草稿、发布版本和回滚历史 |
| `review-skills.json`    | 可启停的 review skill 指令             |
| `review-feedback.json`  | 管理后台录入的 review 反馈             |
| `prompt-proposals.json` | 基于反馈生成的 prompt 优化建议         |

新的 review 任务会读取当前已发布 prompt 版本和启用的匹配 skill，不需要重启服务。优化建议只会应用到草稿，不会自动发布。

保存后立即影响新任务的配置包括：

- 默认 Claude/Codex 模型
- 默认 Claude/Codex 超时时间
- Codex reasoning effort
- 默认 AI provider
- review confidence 阈值
- review candidate/final finding 数量
- GitLab/Claude/Codex token
- 已发布 review prompt
- 启用的 review skill

以下配置需要重启服务后生效：

- webhook 监听端口
- 工作目录
- Docker volume 和 Docker network

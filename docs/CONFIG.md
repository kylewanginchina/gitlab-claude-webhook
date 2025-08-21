# 环境配置指南

## 配置文件支持

本项目支持多种环境变量配置方式：

### 1. `.env` 文件配置

在项目根目录创建 `.env` 文件：

```bash
# Claude API配置
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=sk-your-token-here

# GitLab配置
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=glpat-your-token-here

# Webhook配置
WEBHOOK_SECRET=your-secret-here
PORT=3000

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

### 4. 配置优先级

配置加载优先级（高到低）：

1. 系统环境变量
2. `.env` 文件
3. 默认值

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

### 6. 必需配置项

以下配置项是必需的：

- `ANTHROPIC_AUTH_TOKEN` - Anthropic API 令牌
- `GITLAB_TOKEN` - GitLab API 令牌
- `WEBHOOK_SECRET` - Webhook 验证密钥

启动时会自动验证这些配置项，缺少任何一项都会导致应用启动失败。

### 7. 配置模板

复制 `.env.example` 文件作为配置模板：

```bash
cp .env.example .env
# 然后编辑 .env 文件，填入实际的配置值
```

这样可以确保包含所有必要的配置项。

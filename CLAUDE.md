# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Multi-Provider AI Support

This project supports both **Claude Code** and **OpenAI Codex** as AI providers. Users can specify the provider via mentions:
- `@claude` - Uses Claude Code CLI (default)
- `@codex` - Uses OpenAI Codex CLI
- `@claude[model=xxx]` or `@codex[model=xxx]` - Specify custom model

## Development Commands

```bash
# Build the project
npm run build

# Development with hot reload (requires non-root privileges)
npm run dev

# Run linting
npm run lint

# Run tests
npm test

# Production start
npm start

# Docker development
docker-compose up -d
docker-compose logs -f gitlab-claude-webhook
```

## Architecture Overview

This is a GitLab webhook service that integrates with Claude Code CLI to provide AI-powered code assistance directly from GitLab issues, merge requests, and comments.

### Core Flow

1. **Webhook Reception** (`src/server/webhookServer.ts`) - Express server receives GitLab webhooks
2. **Event Processing** (`src/services/eventProcessor.ts`) - Main orchestrator that extracts `@claude` or `@codex` instructions and manages the workflow
3. **Project Management** (`src/services/projectManager.ts`) - Handles git operations, cloning, and branch management
4. **AI Execution** - Provider-based execution via official SDKs:
   - `src/services/streamingClaudeExecutor.ts` - Uses `@anthropic-ai/claude-agent-sdk` `query()` API with streaming messages
   - `src/services/codexExecutor.ts` - Uses `@openai/codex-sdk` `Codex` class with `runStreamed()` events
5. **MR Generation** (`src/utils/mrGenerator.ts`) - Creates smart merge requests with conventional commit titles and structured descriptions
6. **GitLab Integration** (`src/services/gitlabService.ts`) - Handles all GitLab API interactions

### Key Components

**EventProcessor** - Central orchestrator that:

- Extracts Claude instructions from webhook events using `@claude` pattern
- Creates timestamp-based branches for Claude changes
- Manages the full workflow from instruction to merge request creation
- Provides real-time feedback via GitLab comments

**StreamingClaudeExecutor** - Uses `@anthropic-ai/claude-agent-sdk`:

- Calls `query()` with `permissionMode: 'bypassPermissions'` for automated execution
- Iterates over `SDKMessage` async generator for real-time streaming progress
- Extracts progress from `assistant`, `tool_progress`, and `system` message types
- Handles `SDKResultMessage` for success/error detection with cost and usage tracking
- Supports abort via `AbortController` for timeout handling

**CodexExecutor** - Uses `@openai/codex-sdk`:

- Creates `Codex` instance and starts threads with `approvalPolicy: 'never'` and `sandboxMode: 'danger-full-access'`
- Uses `thread.runStreamed()` to receive `ThreadEvent` stream
- Handles `item.started`, `item.completed`, `turn.completed`, and error events for progress
- Supports `AbortSignal` for timeout handling

**MRGenerator** - Intelligent merge request creation:

- Analyzes instruction content and file changes to determine type (feat, fix, docs, etc.)
- Auto-detects scope from file paths
- Generates conventional commit format titles
- Creates structured descriptions with testing checklists

**ProjectManager** - Git operations wrapper:

- Clones repositories to temporary directories
- Handles branch creation and switching
- Manages commits and pushes with proper cleanup

## Environment Configuration

**Core required (validated at startup):**

- `GITLAB_TOKEN` - GitLab API token with `api`, `read_repository`, `write_repository` scopes
- `WEBHOOK_SECRET` - GitLab webhook secret for signature verification

**Required based on AI provider:**

- `ANTHROPIC_AUTH_TOKEN` - Required when using Claude
- `OPENAI_API_KEY` - Required when using Codex

**Optional (all have defaults):**

- `AI_DEFAULT_PROVIDER` (default: claude) - Default AI provider
- `ANTHROPIC_BASE_URL` (default: https://api.anthropic.com)
- `OPENAI_BASE_URL` (default: https://api.openai.com/v1)
- `CLAUDE_DEFAULT_MODEL` (default: claude-sonnet-4-20250514)
- `CODEX_DEFAULT_MODEL` (default: gpt-5.1-codex-max)
- `CODEX_REASONING_EFFORT` (default: high)
- `GITLAB_BASE_URL` (default: https://gitlab.com)
- `PORT` (default: 3000)
- `WORK_DIR` (default: /tmp/gitlab-claude-work)
- `LOG_LEVEL` (default: info)

## GitLab Webhook Setup

Configure GitLab webhooks to trigger on:

- Issues events
- Merge request events
- Comments (Push comments, Issue comments, Merge request comments)

The service detects `@claude` and `@codex` mentions in:

- Issue descriptions and comments
- Merge request descriptions and comments
- Any webhook event content

Optional model specification: `@claude[model=xxx]` or `@codex[model=xxx]`

## AI SDK Integration

The service uses official SDKs (not CLI spawning) for AI execution:

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`):
- Uses `query()` function to execute prompts with streaming `SDKMessage` events
- Configured with `permissionMode: 'bypassPermissions'` for automated execution
- The SDK spawns the Claude Code binary internally

**OpenAI Codex SDK** (`@openai/codex-sdk`):
- Uses `Codex` class with `startThread()` and `thread.runStreamed()` for streaming events
- Configured with `approvalPolicy: 'never'` and `sandboxMode: 'danger-full-access'`
- The SDK spawns the Codex CLI binary internally

Both SDKs require their respective CLI tools to be installed:
```bash
npm install -g @anthropic-ai/claude-code  # Required by claude-agent-sdk
npm install -g @openai/codex              # Required by codex-sdk
```

For Docker deployments, both CLIs are installed globally in the container.

## Codex Custom Provider Configuration

Codex config is **auto-generated** at container startup from environment variables:

```bash
# Example for custom endpoint (88code.org)
OPENAI_BASE_URL=https://88code.org/openai/v1
OPENAI_API_KEY=your-api-key
CODEX_DEFAULT_MODEL=gpt-5.1-codex-max
```

Provider name is auto-extracted from URL (e.g., `88code.org` → `88code`).

## Branch and MR Workflow

1. Service creates timestamped branches (format: `claude-YYYYMMDDTHHMMSS-XXXXXX`)
2. Claude Code CLI executes in the project context
3. Changes are committed and pushed to the new branch
4. Smart merge request is created with:
   - Conventional commit title (e.g., `feat(api): add user authentication`)
   - Structured description with change categorization
   - Testing checklist appropriate for change type
5. Progress updates streamed back to original GitLab issue/MR as comments

## Key File Locations

- `/src/types/gitlab.ts` - GitLab webhook event type definitions
- `/src/types/common.ts` - Shared interfaces (ProcessResult, FileChange)
- `/src/utils/webhook.ts` - Webhook signature verification and instruction extraction
- `/src/utils/config.ts` - Environment configuration loading
- `/src/utils/logger.ts` - Winston-based logging configuration

## Troubleshooting

### Common Issues

**Claude Code Execution Failures**:
- Check logs for detailed error information and execution context
- Verify Claude Code CLI is properly installed (`claude --version`)
- Ensure ANTHROPIC_AUTH_TOKEN is valid and has sufficient credits
- Review execution logs for authentication or network issues

**Intermittent "Execution error" Messages**:
- **FIXED**: Issue was caused by aggressive exploration system prompt that forced Claude to explore entire project structure, causing timeouts in large repositories
- **FIXED**: Removed `Bash(git:*)` tool restriction that could cause parameter parsing issues
- **FIXED**: Simplified system prompt to avoid mandatory exploration that leads to timeouts
- Enhanced logging captures Claude Code stdout/stderr for debugging
- Check service logs with `LOG_LEVEL=debug` for detailed execution traces
- Verify system resources and network connectivity

**Permission Issues**:
- Service must run with non-root privileges
- Ensure proper file system permissions for work directories
- Docker containers should use non-root user

## Docker Deployment

The service is containerized and includes:

- Health checks on `/health` endpoint
- Proper volume mounting for temporary work directories
- Network isolation with custom subnet
- Automatic restart policies

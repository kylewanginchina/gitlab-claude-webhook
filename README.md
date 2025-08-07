# GitLab Claude Webhook Service

A webhook service that integrates GitLab with Claude Code CLI, enabling AI-powered code assistance directly from GitLab issues, merge requests, and comments.

## Features

- **GitLab Integration**: Receives webhook events from GitLab for issues, merge requests, and comments
- **Claude AI Processing**: Automatically detects `@claude` mentions and executes Claude Code CLI commands
- **Secure Webhook Verification**: Validates webhook signatures to ensure security
- **Branch-aware Processing**: Automatically works with the correct branch/tag for each context
- **Automatic Code Changes**: Commits and pushes changes made by Claude back to the repository
- **Real-time Feedback**: Posts results and errors as comments back to GitLab

## Quick Start

### Prerequisites

- Node.js 18+ or Docker
- Claude Code CLI installed (if running locally)
- GitLab project with webhook access
- Anthropic API key
- GitLab API token

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd gitlab-claude-webhook
```

2. Copy environment configuration:
```bash
cp .env.example .env
```

3. Configure environment variables in `.env`:
```bash
# Claude API Configuration
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=sk-your-anthropic-token

# GitLab Configuration
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=glpat-your-gitlab-token

# Webhook Configuration
WEBHOOK_SECRET=your-webhook-secret
PORT=3000

# Working Directory
WORK_DIR=/tmp/gitlab-claude-work

# Logging
LOG_LEVEL=info
```

### Running with Docker (Recommended)

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f
```

### Running Locally

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start the service
npm start

# For development with hot reload
npm run dev
```

## GitLab Configuration

For detailed GitLab setup instructions, including webhook configuration, token permissions, and troubleshooting, see:

📋 **[Complete GitLab Setup Guide](docs/gitlab-setup.md)**

### Quick Setup Summary

1. **Create GitLab Token**: Generate a personal or project access token with `api`, `read_repository`, and `write_repository` scopes
2. **Configure Webhook**: Add webhook to your project with URL `http://your-domain:3000/webhook` and secret token
3. **Set Trigger Events**: Enable Issues events, Merge request events, and Comments
4. **Test Integration**: Create an issue with `@claude` mention to verify setup

## Usage

### In GitLab Issues

Create or comment on an issue with:
```
@claude Please help me optimize this function in src/utils/helper.js
```

### In Merge Requests

Add to MR description or comment:
```
@claude Review the security implications of these changes and suggest improvements
```

### Advanced Usage

You can provide specific instructions:
```
@claude 
- Fix the TypeScript errors in the authentication module
- Add proper error handling 
- Update the unit tests accordingly
```

## How It Works

1. **Webhook Reception**: Service receives GitLab webhook events
2. **Signature Verification**: Validates webhook authenticity using secret
3. **Content Analysis**: Scans for `@claude` mentions in issues/MRs/comments
4. **Project Preparation**: Clones the GitLab project to a temporary directory
5. **Branch Management**: Switches to the appropriate branch (source branch for MRs, default for issues)
6. **Claude Execution**: Runs Claude Code CLI with the extracted instructions
7. **Change Handling**: Commits and pushes any code changes made by Claude
8. **Feedback**: Posts results or errors as comments back to GitLab

## API Endpoints

- `GET /` - Service information
- `GET /health` - Health check endpoint
- `POST /webhook` - GitLab webhook receiver

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_BASE_URL` | Anthropic API base URL | `https://api.anthropic.com` |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic API token | Required |
| `GITLAB_BASE_URL` | GitLab instance URL | `https://gitlab.com` |
| `GITLAB_TOKEN` | GitLab API token | Required |
| `WEBHOOK_SECRET` | Webhook validation secret | Required |
| `PORT` | Server port | `3000` |
| `WORK_DIR` | Temporary work directory | `/tmp/gitlab-claude-work` |
| `LOG_LEVEL` | Logging level | `info` |

### GitLab Token Permissions

Your GitLab token needs the following scopes:
- `api` - Full API access
- `read_user` - Read user information
- `read_repository` - Read repository
- `write_repository` - Write to repository

## Security Considerations

- Always use webhook secrets for signature verification
- Limit GitLab token permissions to minimum required
- Run the service in a secure environment
- Monitor logs for suspicious activity
- Consider network restrictions and firewall rules

## Troubleshooting

### Common Issues

1. **"Claude CLI not found"**
   - Ensure Claude Code CLI is installed and in PATH
   - For Docker: Claude CLI needs to be available in the container

2. **"Invalid webhook signature"**
   - Verify `WEBHOOK_SECRET` matches GitLab webhook configuration
   - Check that GitLab is sending the correct header

3. **"Failed to clone project"**
   - Verify GitLab token has repository access
   - Check network connectivity to GitLab
   - Ensure branch exists

4. **"Permission denied"**
   - Verify GitLab token has write permissions
   - Check repository settings and branch protection rules

### Logs

View detailed logs:
```bash
# Docker
docker-compose logs -f gitlab-claude-webhook

# Local
tail -f combined.log
```

## Development

### Building

```bash
npm run build
```

### Linting

```bash
npm run lint
```

### Project Structure

```
src/
├── index.ts              # Main entry point
├── server/
│   └── webhookServer.ts  # Express server and webhook handling
├── services/
│   ├── eventProcessor.ts # GitLab event processing logic
│   ├── projectManager.ts # Git operations and project management
│   ├── claudeExecutor.ts # Claude Code CLI execution
│   └── gitlabService.ts  # GitLab API interactions
├── types/
│   ├── gitlab.ts         # GitLab-related type definitions
│   └── common.ts         # Common type definitions
└── utils/
    ├── config.ts         # Configuration management
    ├── logger.ts         # Logging utility
    └── webhook.ts        # Webhook utilities
```

## Documentation

- 📋 [GitLab Configuration Guide](docs/gitlab-setup.md) - Complete setup instructions for GitLab integration
- 🔧 [API Reference](#api-endpoints) - Available endpoints and usage
- 🏗️ [Project Structure](#project-structure) - Codebase organization
- 🐛 [Troubleshooting](#troubleshooting) - Common issues and solutions

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details
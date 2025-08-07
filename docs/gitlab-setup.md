# GitLab Configuration Guide

This guide walks you through setting up GitLab webhooks and permissions to work with the Claude Code integration service.

## Table of Contents

- [Prerequisites](#prerequisites)
- [GitLab Token Setup](#gitlab-token-setup)
- [Webhook Configuration](#webhook-configuration)
- [Project Permissions](#project-permissions)
- [Branch Protection Settings](#branch-protection-settings)
- [Testing the Integration](#testing-the-integration)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before configuring GitLab, ensure you have:

- **GitLab Account**: Admin or maintainer access to the target GitLab project
- **Webhook Service**: The Claude webhook service running and accessible
- **Domain/IP**: Public URL where your webhook service is hosted
- **Webhook Secret**: A secure secret token for webhook verification

## GitLab Token Setup

### 1. Create a Personal Access Token

1. Go to **GitLab** → **Preferences** → **Access Tokens**
   - URL: `https://gitlab.com/-/profile/personal_access_tokens` (for GitLab.com)
   - For self-hosted: `https://your-gitlab-instance.com/-/profile/personal_access_tokens`

2. Create a new token with the following settings:
   - **Token name**: `claude-code-integration`
   - **Expiration date**: Set according to your security policy
   - **Scopes**: Select the following permissions:
     - ✅ `api` - Complete read/write access to the API
     - ✅ `read_user` - Read user information
     - ✅ `read_repository` - Read access to repository
     - ✅ `write_repository` - Write access to repository

3. **Important**: Copy the token immediately and store it securely. It won't be shown again.

### 2. Alternative: Project Access Token (GitLab 13.9+)

For project-specific access:

1. Go to your **Project** → **Settings** → **Access Tokens**
2. Create a new token with:
   - **Token name**: `claude-code-bot`
   - **Role**: `Maintainer` (required for pushing changes)
   - **Scopes**: 
     - ✅ `api`
     - ✅ `read_repository`
     - ✅ `write_repository`

## Webhook Configuration

### 1. Add Webhook to Project

1. Navigate to your GitLab project
2. Go to **Settings** → **Webhooks**
3. Click **Add new webhook**

### 2. Webhook Settings

Configure the following fields:

#### URL
```
https://your-domain.com:3000/webhook
```
Replace `your-domain.com` with your actual domain or IP address.

#### Secret Token
Enter the same secret you configured in your service's `WEBHOOK_SECRET` environment variable.

#### Trigger Events
Select the following events:
- ✅ **Issues events** - For `@claude` mentions in issues
- ✅ **Merge request events** - For `@claude` mentions in MR descriptions
- ✅ **Comments** - For `@claude` mentions in comments
- ✅ **Pipeline events** - (Optional) For pipeline-related integrations
- ✅ **Wiki Page events** - (Optional) If you want wiki integration

#### SSL Verification
- ✅ **Enable SSL verification** - Recommended for production
- ❌ **Disable** only for testing with self-signed certificates

### 3. Test the Webhook

1. Click **Add webhook** to save
2. Find your newly created webhook in the list
3. Click **Test** → **Push events** to send a test payload
4. Check your webhook service logs for successful reception

## Project Permissions

### User Permissions
Ensure the token owner has the following project permissions:

| Permission | Required Level | Purpose |
|------------|----------------|---------|
| **Repository** | Developer+ | Clone and read repository |
| **Issues** | Reporter+ | Read and comment on issues |
| **Merge Requests** | Developer+ | Read and comment on MRs |
| **Push to Repository** | Developer+ | Commit and push changes |

### Branch Access
- **Unprotected branches**: No additional setup required
- **Protected branches**: See [Branch Protection Settings](#branch-protection-settings)

## Branch Protection Settings

If you have protected branches (like `main` or `develop`):

### Option 1: Allow Direct Push (Simplest)
1. Go to **Project Settings** → **Repository** → **Protected Branches**
2. Find your protected branch
3. Under **Allowed to push**, add:
   - The user associated with your GitLab token
   - Or create a specific service account for Claude

### Option 2: Use Merge Requests (Recommended)
1. Configure the service to create merge requests instead of direct pushes
2. Set up auto-merge rules for Claude-generated MRs
3. Add this to your `.env` configuration:
   ```bash
   GITLAB_USE_MR=true
   GITLAB_AUTO_MERGE=true
   ```

### Option 3: Push Rules (GitLab Premium)
Create push rules that allow the service account to bypass certain restrictions:
1. Go to **Project Settings** → **Push Rules**
2. Add exception for the service account
3. Configure rules as needed

## Testing the Integration

### 1. Simple Test
Create a new issue with:
```
@claude Hello! Can you help me understand what this service does?
```

### 2. Code-related Test
Create an issue with:
```
@claude Please review the main entry point file and suggest any improvements.
```

### 3. Advanced Test
Create a merge request and comment:
```
@claude 
Please review this MR for:
- Security vulnerabilities
- Performance issues
- Code style consistency
- Missing error handling
```

### 4. Verify Results
After each test:
1. Check webhook service logs for processing
2. Look for Claude's response comments in GitLab
3. Verify any code changes were properly committed
4. Confirm new branches/MRs were created if applicable

## Troubleshooting

### Common Issues

#### "Webhook signature verification failed"
**Symptoms**: 403 errors in webhook service logs
**Solutions**:
1. Verify `WEBHOOK_SECRET` matches GitLab webhook secret token exactly
2. Check GitLab webhook logs for delivery attempts
3. Ensure webhook URL is correct and accessible

#### "GitLab API authentication failed"  
**Symptoms**: 401 errors when accessing GitLab API
**Solutions**:
1. Verify GitLab token is valid and hasn't expired
2. Check token permissions include required scopes
3. Test token manually: `curl -H "Authorization: Bearer $TOKEN" https://gitlab.com/api/v4/user`

#### "Failed to push changes"
**Symptoms**: Git push errors in service logs
**Solutions**:
1. Check branch protection settings
2. Verify token has push permissions
3. Review Git credentials configuration
4. Check if branch exists and is accessible

#### "No response from Claude"
**Symptoms**: Webhook received but no Claude processing
**Solutions**:
1. Verify `@claude` mention format is correct
2. Check if issue/MR contains actual content to process
3. Review Claude service logs for errors
4. Confirm Anthropic API token is valid

### Webhook Debugging

#### Test Webhook Manually
```bash
curl -X POST https://your-domain.com:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Token: your-webhook-secret" \
  -H "X-Gitlab-Event: Issue Hook" \
  -d @test-payload.json
```

#### View Webhook Deliveries
1. Go to **Project Settings** → **Webhooks**
2. Click on your webhook
3. Scroll down to **Recent Deliveries**
4. Click on individual deliveries to see request/response details

#### Enable Debug Logging
Add to your service configuration:
```bash
LOG_LEVEL=debug
GITLAB_DEBUG=true
```

### GitLab API Rate Limits

If you encounter rate limiting:

1. **GitLab.com**: 2,000 requests per minute per token
2. **Self-hosted**: Check your instance configuration
3. **Solutions**:
   - Implement request queuing
   - Add delays between API calls
   - Use project tokens instead of personal tokens
   - Consider upgrading GitLab plan for higher limits

### Network and Firewall Issues

#### Webhook Not Reaching Service
1. Check firewall rules allow incoming connections on webhook port
2. Verify DNS resolution for your webhook URL
3. Test connectivity: `curl -I https://your-domain.com:3000/health`
4. Consider using ngrok for local testing:
   ```bash
   ngrok http 3000
   # Use the generated HTTPS URL as your webhook URL
   ```

#### Service Can't Reach GitLab
1. Check outbound firewall rules
2. Verify DNS resolution for GitLab instance
3. Test connectivity: `curl -I https://gitlab.com`
4. Check proxy settings if behind corporate network

### Security Considerations

#### Production Checklist
- ✅ Use HTTPS for webhook URLs
- ✅ Enable webhook secret verification
- ✅ Use minimal required token permissions
- ✅ Regular token rotation
- ✅ Monitor webhook logs for suspicious activity
- ✅ Implement rate limiting on webhook endpoint
- ✅ Use dedicated service accounts
- ✅ Regular security audits

#### Token Security
- Store tokens in secure environment variables
- Never commit tokens to repository
- Use token rotation policies
- Monitor token usage in GitLab audit logs
- Revoke tokens immediately if compromised

For additional help, check the main [README.md](../README.md) or create an issue in the project repository.
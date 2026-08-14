import { config } from './config';
import { runtimeConfigService } from './runtimeConfig';

/* eslint-disable no-console */

/**
 * Debug configuration loading
 * Useful for troubleshooting environment variable issues
 */
export function debugConfig(): void {
  const runtimeConfig = runtimeConfigService.isLoaded()
    ? runtimeConfigService.getConfig()
    : {
        ai: {
          defaultProvider: config.ai.defaultProvider,
        },
        claude: {
          baseUrl: config.anthropic.baseUrl,
          authToken: config.anthropic.authToken,
          defaultModel: config.anthropic.defaultModel,
          reasoningEffort: config.anthropic.reasoningEffort,
          defaultTimeoutMinutes: 30,
        },
        codex: {
          baseUrl: config.openai.baseUrl,
          apiKey: config.openai.apiKey,
          defaultModel: config.openai.defaultModel,
          reasoningEffort: config.openai.reasoningEffort,
          defaultTimeoutMinutes: 30,
        },
        gitlab: {
          baseUrl: config.gitlab.baseUrl,
          token: config.gitlab.token,
        },
        webhook: {
          secret: config.webhook.secret,
          port: config.webhook.port,
          taskConcurrency: config.webhook.taskConcurrency,
        },
        workDir: config.workDir,
        logLevel: config.logLevel,
      };

  console.log('🔧 Configuration Debug Information:');
  console.log('=====================================');

  console.log('\n📁 Environment Files:');
  console.log(`Working Directory: ${process.cwd()}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV || 'undefined'}`);
  console.log(`Runtime Config Loaded: ${runtimeConfigService.isLoaded()}`);

  console.log('\n🔑 Loaded Runtime Configuration:');
  console.log(`Default Provider: ${runtimeConfig.ai.defaultProvider}`);
  console.log(`Claude Base URL: ${runtimeConfig.claude.baseUrl}`);
  console.log(`Claude Auth Token: ${runtimeConfig.claude.authToken ? '********' : 'NOT SET'}`);
  console.log(`Claude Default Model: ${runtimeConfig.claude.defaultModel}`);
  console.log(`Claude Reasoning Effort: ${runtimeConfig.claude.reasoningEffort}`);
  console.log(`Claude Default Timeout: ${runtimeConfig.claude.defaultTimeoutMinutes} minutes`);
  console.log(`OpenAI Base URL: ${runtimeConfig.codex.baseUrl}`);
  console.log(`OpenAI API Key: ${runtimeConfig.codex.apiKey ? '********' : 'NOT SET'}`);
  console.log(`Codex Default Model: ${runtimeConfig.codex.defaultModel}`);
  console.log(`Codex Reasoning Effort: ${runtimeConfig.codex.reasoningEffort}`);
  console.log(`GitLab Base URL: ${runtimeConfig.gitlab.baseUrl}`);
  console.log(`GitLab Token: ${runtimeConfig.gitlab.token ? '********' : 'NOT SET'}`);
  console.log(`Webhook Secret: ${runtimeConfig.webhook.secret ? '********' : 'NOT SET'}`);
  console.log(`Port: ${runtimeConfig.webhook.port}`);
  console.log(`Webhook Task Concurrency: ${runtimeConfig.webhook.taskConcurrency}`);
  console.log(`Work Directory: ${runtimeConfig.workDir}`);
  console.log(`Log Level: ${runtimeConfig.logLevel}`);

  console.log('\n=====================================');
}

/**
 * Validate that all required configuration is present
 * Note: AI provider tokens are validated based on which provider is being used
 */
export function validateRequiredConfig(): { isValid: boolean; missing: string[] } {
  const runtimeConfig = runtimeConfigService.isLoaded()
    ? runtimeConfigService.getConfig()
    : {
        gitlab: { token: config.gitlab.token },
        webhook: { secret: config.webhook.secret },
        claude: { authToken: config.anthropic.authToken },
        codex: { apiKey: config.openai.apiKey },
      };

  const missing: string[] = [];

  // Core required
  if (!runtimeConfig.gitlab.token) missing.push('GITLAB_TOKEN');
  if (!runtimeConfig.webhook.secret) missing.push('WEBHOOK_SECRET');

  // AI provider specific - warn if neither is set
  if (!runtimeConfig.claude.authToken && !runtimeConfig.codex.apiKey) {
    missing.push('ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY (at least one required)');
  }

  return {
    isValid: missing.length === 0,
    missing,
  };
}

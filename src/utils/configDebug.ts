import { config } from './config';

/* eslint-disable no-console */

/**
 * Debug configuration loading
 * Useful for troubleshooting environment variable issues
 */
export function debugConfig(): void {
  console.log('🔧 Configuration Debug Information:');
  console.log('=====================================');

  console.log('\n📁 Environment Files:');
  console.log(`Working Directory: ${process.cwd()}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV || 'undefined'}`);

  console.log('\n🔑 Loaded Configuration:');

  // AI Provider Settings
  console.log(`\n[AI Provider]`);
  console.log(`Default Provider: ${config.ai.defaultProvider}`);

  // Claude/Anthropic Settings
  console.log(`\n[Claude]`);
  console.log(`Anthropic Base URL: ${config.anthropic.baseUrl}`);
  console.log(`Anthropic Auth Token: ${config.anthropic.authToken ? '********' : 'NOT SET'}`);
  console.log(`Claude Default Model: ${config.anthropic.defaultModel}`);

  // OpenAI/Codex Settings
  console.log(`\n[Codex]`);
  console.log(`OpenAI Base URL: ${config.openai.baseUrl}`);
  console.log(`OpenAI API Key: ${config.openai.apiKey ? '********' : 'NOT SET'}`);
  console.log(`Codex Default Model: ${config.openai.defaultModel}`);

  // GitLab Settings
  console.log(`\n[GitLab]`);
  console.log(`GitLab Base URL: ${config.gitlab.baseUrl}`);
  console.log(`GitLab Token: ${config.gitlab.token ? '********' : 'NOT SET'}`);

  // Webhook Settings
  console.log(`\n[Webhook]`);
  console.log(`Webhook Secret: ${config.webhook.secret ? '********' : 'NOT SET'}`);
  console.log(`Port: ${config.webhook.port}`);

  // Other Settings
  console.log(`\n[Other]`);
  console.log(`Work Directory: ${config.workDir}`);
  console.log(`Log Level: ${config.logLevel}`);

  console.log('\n🌐 Raw Environment Variables:');
  const envVars = [
    'AI_DEFAULT_PROVIDER',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_DEFAULT_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'CODEX_DEFAULT_MODEL',
    'CODEX_REASONING_EFFORT',
    'GITLAB_BASE_URL',
    'GITLAB_TOKEN',
    'WEBHOOK_SECRET',
    'PORT',
    'WORK_DIR',
    'LOG_LEVEL',
    'SYSTEM_PROMPT_APPEND'
  ];

  envVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
      const masked =
        varName.includes('TOKEN') || varName.includes('SECRET') || varName.includes('KEY')
          ? '***' + value.slice(-4)
          : value;
      console.log(`${varName}: ${masked}`);
    } else {
      console.log(`${varName}: NOT SET`);
    }
  });

  console.log('\n=====================================');
}

/**
 * Validate that all required configuration is present
 * Note: AI provider tokens are validated based on which provider is being used
 */
export function validateRequiredConfig(): { isValid: boolean; missing: string[] } {
  const missing: string[] = [];

  // Core required
  if (!config.gitlab.token) missing.push('GITLAB_TOKEN');
  if (!config.webhook.secret) missing.push('WEBHOOK_SECRET');

  // AI provider specific - warn if neither is set
  if (!config.anthropic.authToken && !config.openai.apiKey) {
    missing.push('ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY (at least one required)');
  }

  return {
    isValid: missing.length === 0,
    missing,
  };
}

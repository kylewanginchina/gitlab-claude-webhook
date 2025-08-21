import { config } from './config';

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
  console.log(`Anthropic Base URL: ${config.anthropic.baseUrl}`);
  console.log(
    `Anthropic Auth Token: ${config.anthropic.authToken ? '***' + config.anthropic.authToken.slice(-8) : 'NOT SET'}`
  );
  console.log(`GitLab Base URL: ${config.gitlab.baseUrl}`);
  console.log(
    `GitLab Token: ${config.gitlab.token ? '***' + config.gitlab.token.slice(-8) : 'NOT SET'}`
  );
  console.log(
    `Webhook Secret: ${config.webhook.secret ? '***' + config.webhook.secret.slice(-4) : 'NOT SET'}`
  );
  console.log(`Port: ${config.webhook.port}`);
  console.log(`Work Directory: ${config.workDir}`);
  console.log(`Log Level: ${config.logLevel}`);

  console.log('\n🌐 Raw Environment Variables:');
  const envVars = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'GITLAB_BASE_URL',
    'GITLAB_TOKEN',
    'WEBHOOK_SECRET',
    'PORT',
    'WORK_DIR',
    'LOG_LEVEL',
  ];

  envVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
      const masked =
        varName.includes('TOKEN') || varName.includes('SECRET') ? '***' + value.slice(-4) : value;
      console.log(`${varName}: ${masked}`);
    } else {
      console.log(`${varName}: NOT SET`);
    }
  });

  console.log('\n=====================================');
}

/**
 * Validate that all required configuration is present
 */
export function validateRequiredConfig(): { isValid: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!config.anthropic.authToken) missing.push('ANTHROPIC_AUTH_TOKEN');
  if (!config.gitlab.token) missing.push('GITLAB_TOKEN');
  if (!config.webhook.secret) missing.push('WEBHOOK_SECRET');

  return {
    isValid: missing.length === 0,
    missing,
  };
}

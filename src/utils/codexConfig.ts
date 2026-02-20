import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from './config';
import logger from './logger';

/**
 * Generate Codex config.toml from environment variables
 * This is needed for both Docker and local npm start
 */
export function generateCodexConfig(): void {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configFile = path.join(codexHome, 'config.toml');

  // Create directory if it doesn't exist
  if (!fs.existsSync(codexHome)) {
    fs.mkdirSync(codexHome, { recursive: true });
  }

  // Get configuration from environment/config
  const codexModel = config.openai.defaultModel;
  const codexBaseUrl = config.openai.baseUrl;
  const codexReasoningEffort = process.env.CODEX_REASONING_EFFORT || 'high';

  // Auto-extract provider name from base URL
  const codexProvider = extractProviderFromUrl(codexBaseUrl);

  // Generate config.toml content
  const configContent = `# Auto-generated Codex configuration
# Generated from environment variables at application startup

model = "${codexModel}"
model_provider = "${codexProvider}"
model_reasoning_effort = "${codexReasoningEffort}"
disable_response_storage = true

# Sandbox configuration - disable for webhook environment
# Since we're running in a controlled environment, we disable the Landlock sandbox
sandbox_mode = "danger-full-access"
approval_policy = "never"

# Custom model provider configuration
[model_providers.${codexProvider}]
name = "${codexProvider}"
base_url = "${codexBaseUrl}"
wire_api = "responses"
env_key = "OPENAI_API_KEY"

[notice]
hide_full_access_warning = true
"hide_gpt-5.1-codex-max_migration_prompt" = true
`;

  fs.writeFileSync(configFile, configContent, 'utf-8');

  logger.info('Generated Codex config', {
    configFile,
    provider: codexProvider,
    baseUrl: codexBaseUrl,
    model: codexModel,
  });
}

/**
 * Extract provider name from base URL
 * e.g., https://88code.org/openai/v1 -> 88code
 * e.g., https://api.openai.com/v1 -> openai (default)
 */
function extractProviderFromUrl(url: string): string {
  try {
    // Remove protocol
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    // Extract first part of hostname (before first dot)
    const provider = host.split('.')[0];
    // If it's 'api', use 'openai' as default
    return provider === 'api' ? 'openai' : provider;
  } catch {
    return 'openai';
  }
}

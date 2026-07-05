import crypto from 'crypto';
import { config } from './config';
import logger from './logger';
import { AIProvider } from '../types/common';
import { runtimeConfigService } from './runtimeConfig';

export interface AIInstructionResult {
  provider: AIProvider;
  model?: string;
  timeout?: number;
  command: string;
}

interface CodeReviewCommandMatch {
  matchedCommand: string;
  focus?: string;
}

function getWebhookSecret(): string {
  if (runtimeConfigService.isLoaded()) {
    return runtimeConfigService.getConfig().webhook.secret;
  }

  return config.webhook.secret;
}

export function verifyGitLabSignature(body: string, signature: string): boolean {
  if (!signature) {
    logger.warn('No signature provided in webhook request');
    return false;
  }

  const webhookSecret = getWebhookSecret();

  if (!webhookSecret) {
    logger.warn('No webhook secret configured');
    return false;
  }

  // GitLab can send either:
  // 1. Secret token directly (X-Gitlab-Token header)
  // 2. SHA256 signature (starts with "sha256=")

  // Check if it's a direct secret token match
  if (signature === webhookSecret) {
    logger.debug('Webhook verified using direct secret token');
    return true;
  }

  // Check if it's a SHA256 signature
  if (signature.startsWith('sha256=')) {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body, 'utf8')
      .digest('hex');

    const providedSignature = signature.replace('sha256=', '');

    // Check if both signatures have the same length before comparing
    if (expectedSignature.length !== providedSignature.length) {
      logger.warn('Signature length mismatch', {
        expected: expectedSignature.length,
        provided: providedSignature.length,
      });
      return false;
    }

    try {
      const isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(providedSignature, 'hex')
      );

      if (!isValid) {
        logger.warn('Invalid webhook SHA256 signature');
      }

      return isValid;
    } catch (error) {
      logger.error('Error in SHA256 signature verification:', error);
      return false;
    }
  }

  // Neither direct token nor valid SHA256 signature
  logger.warn('Invalid webhook authentication - not a direct token or SHA256 signature', {
    receivedLength: signature.length,
    receivedValue: signature.substring(0, 10) + '...',
  });
  return false;
}

/**
 * Extract AI instructions from text with provider and optional parameter selection.
 * Supports:
 * - @claude instruction (uses Claude provider)
 * - @codex instruction (uses Codex provider)
 * - @claude[model=xxx,timeout=20] instruction (uses Claude with specific model and 20 min timeout)
 * - @codex[timeout=30] instruction (uses Codex with 30 min timeout)
 */
export function extractAIInstructions(text: string): AIInstructionResult | null {
  if (!text) return null;

  // Pattern to match @claude or @codex with optional parameters in brackets
  // Group 1: provider (claude or codex)
  // Group 2: optional parameters (e.g., [model=xxx,timeout=20])
  // Group 3: the actual command/instruction
  const aiPattern = /@(claude|codex)(?:\[([^\]]+)\])?\s+([\s\S]*?)(?=@\w+|$)/i;
  const match = text.match(aiPattern);

  if (match) {
    const provider = match[1].toLowerCase() as AIProvider;
    const paramsStr = match[2];
    const command = match[3].trim();

    let model: string | undefined;
    let timeout: number | undefined;

    if (paramsStr) {
      const params = paramsStr.split(',').map(p => p.trim());
      for (const param of params) {
        const [key, value] = param.split('=').map(s => s.trim());
        if (!key || !value) continue;

        if (key.toLowerCase() === 'model') {
          model = value;
        } else if (key.toLowerCase() === 'timeout') {
          const t = parseInt(value, 10);
          if (!isNaN(t)) {
            timeout = t;
          }
        }
      }
    }

    if (command) {
      logger.debug('Extracted AI instruction', {
        provider,
        model,
        timeout,
        commandLength: command.length,
      });
      return {
        provider,
        model,
        timeout,
        command,
      };
    }
  }

  return null;
}

function findCodeReviewCommandMatch(
  command: string,
  allowedCommands: string[] = ['/code-review']
): CodeReviewCommandMatch | null {
  if (!command) {
    return null;
  }

  const trimmedCommand = command.trim();
  const normalizedCommand = trimmedCommand.toLowerCase();

  for (const configuredCommand of allowedCommands) {
    const trimmedConfiguredCommand = configuredCommand.trim();
    if (!trimmedConfiguredCommand) {
      continue;
    }

    const normalizedConfiguredCommand = trimmedConfiguredCommand.toLowerCase();
    if (
      normalizedCommand === normalizedConfiguredCommand ||
      (normalizedCommand.startsWith(normalizedConfiguredCommand) &&
        /\s/.test(trimmedCommand.charAt(trimmedConfiguredCommand.length)))
    ) {
      const focus = trimmedCommand.slice(trimmedConfiguredCommand.length).trim();
      return {
        matchedCommand: trimmedConfiguredCommand,
        focus: focus || undefined,
      };
    }
  }

  return null;
}

export function isCodeReviewCommand(command: string, allowedCommands?: string[]): boolean {
  return Boolean(findCodeReviewCommandMatch(command, allowedCommands));
}

export function extractCodeReviewFocus(command: string, allowedCommands?: string[]): string | undefined {
  return findCodeReviewCommandMatch(command, allowedCommands)?.focus;
}

/**
 * Legacy function for backward compatibility.
 * Extracts Claude instructions from text.
 */
export function extractClaudeInstructions(text: string): string | null {
  const result = extractAIInstructions(text);
  return result?.command || null;
}

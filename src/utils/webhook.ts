import crypto from 'crypto';
import { config } from './config';
import logger from './logger';
import { AIProvider } from '../types/common';

export interface AIInstructionResult {
  provider: AIProvider;
  model?: string;
  command: string;
}

export function verifyGitLabSignature(body: string, signature: string): boolean {
  if (!signature) {
    logger.warn('No signature provided in webhook request');
    return false;
  }

  if (!config.webhook.secret) {
    logger.warn('No webhook secret configured');
    return false;
  }

  // GitLab can send either:
  // 1. Secret token directly (X-Gitlab-Token header)
  // 2. SHA256 signature (starts with "sha256=")

  // Check if it's a direct secret token match
  if (signature === config.webhook.secret) {
    logger.debug('Webhook verified using direct secret token');
    return true;
  }

  // Check if it's a SHA256 signature
  if (signature.startsWith('sha256=')) {
    const expectedSignature = crypto
      .createHmac('sha256', config.webhook.secret)
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
 * Extract AI instructions from text with provider and optional model selection.
 * Supports:
 * - @claude instruction (uses Claude provider)
 * - @codex instruction (uses Codex provider)
 * - @claude[model=xxx] instruction (uses Claude with specific model)
 * - @codex[model=xxx] instruction (uses Codex with specific model)
 */
export function extractAIInstructions(text: string): AIInstructionResult | null {
  if (!text) return null;

  // Pattern to match @claude or @codex with optional [model=xxx] parameter
  // Group 1: provider (claude or codex)
  // Group 2: optional model parameter (e.g., [model=claude-sonnet-4-20250514])
  // Group 3: the actual command/instruction
  const aiPattern = /@(claude|codex)(?:\[model=([^\]]+)\])?\s+([\s\S]*?)(?=@\w+|$)/i;
  const match = text.match(aiPattern);

  if (match) {
    const provider = match[1].toLowerCase() as AIProvider;
    const model = match[2] || undefined;
    const command = match[3].trim();

    if (command) {
      logger.debug('Extracted AI instruction', { provider, model, commandLength: command.length });
      return {
        provider,
        model,
        command,
      };
    }
  }

  return null;
}

/**
 * Legacy function for backward compatibility.
 * Extracts Claude instructions from text.
 */
export function extractClaudeInstructions(text: string): string | null {
  const result = extractAIInstructions(text);
  return result?.command || null;
}

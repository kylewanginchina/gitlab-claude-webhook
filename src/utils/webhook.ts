import crypto from 'crypto';
import { config } from './config';
import logger from './logger';

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
        provided: providedSignature.length
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
    receivedValue: signature.substring(0, 10) + '...'
  });
  return false;
}

export function extractClaudeInstructions(text: string): string | null {
  if (!text) return null;
  
  const claudePattern = /@claude\s+([\s\S]*?)(?=@\w+|$)/i;
  const match = text.match(claudePattern);
  
  if (match) {
    return match[1].trim();
  }
  
  return null;
}
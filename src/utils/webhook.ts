import crypto from 'crypto';
import { config } from './config';
import logger from './logger';

export function verifyGitLabSignature(body: string, signature: string): boolean {
  if (!signature) {
    logger.warn('No signature provided in webhook request');
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', config.webhook.secret)
    .update(body, 'utf8')
    .digest('hex');

  const providedSignature = signature.replace('sha256=', '');
  
  const isValid = crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(providedSignature, 'hex')
  );

  if (!isValid) {
    logger.warn('Invalid webhook signature');
  }

  return isValid;
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
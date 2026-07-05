import crypto from 'crypto';
import {
  verifyGitLabSignature,
  extractClaudeInstructions,
  extractAIInstructions,
  isCodeReviewCommand,
  extractCodeReviewFocus,
} from '../utils/webhook';
import { runtimeConfigService } from '../utils/runtimeConfig';

// Mock the config
jest.mock('../utils/config', () => ({
  config: {
    webhook: {
      secret: 'test-secret',
    },
  },
}));

jest.mock('../utils/runtimeConfig', () => ({
  runtimeConfigService: {
    isLoaded: jest.fn(),
    getConfig: jest.fn(),
  },
}));

describe('Webhook Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (runtimeConfigService.isLoaded as jest.Mock).mockReturnValue(false);
    (runtimeConfigService.getConfig as jest.Mock).mockReturnValue({
      webhook: {
        secret: 'runtime-secret',
      },
    });
  });

  describe('verifyGitLabSignature', () => {
    it('should verify direct token signature', () => {
      const body = 'test body';
      const signature = 'test-secret';

      expect(verifyGitLabSignature(body, signature)).toBe(true);
    });

    it('should reject invalid signature', () => {
      const body = 'test body';
      const signature = 'invalid-secret';

      expect(verifyGitLabSignature(body, signature)).toBe(false);
    });

    it('should reject empty signature', () => {
      const body = 'test body';
      const signature = '';

      expect(verifyGitLabSignature(body, signature)).toBe(false);
    });

    it('should accept an updated runtime webhook secret without restart', () => {
      const body = 'test body';
      const runtimeSecret = 'updated-runtime-secret';
      const signature = `sha256=${crypto
        .createHmac('sha256', runtimeSecret)
        .update(body, 'utf8')
        .digest('hex')}`;

      (runtimeConfigService.isLoaded as jest.Mock).mockReturnValue(true);
      (runtimeConfigService.getConfig as jest.Mock).mockReturnValue({
        webhook: {
          secret: runtimeSecret,
        },
      });

      expect(verifyGitLabSignature(body, signature)).toBe(true);
    });

    it('should preserve static config fallback before runtime config initialization', () => {
      const body = 'test body';
      const signature = `sha256=${crypto
        .createHmac('sha256', 'test-secret')
        .update(body, 'utf8')
        .digest('hex')}`;

      (runtimeConfigService.isLoaded as jest.Mock).mockReturnValue(false);
      (runtimeConfigService.getConfig as jest.Mock).mockReturnValue({
        webhook: {
          secret: 'updated-runtime-secret',
        },
      });

      expect(verifyGitLabSignature(body, signature)).toBe(true);
    });
  });

  describe('extractClaudeInstructions', () => {
    it('should extract claude instruction from text', () => {
      const text = 'Some text @claude fix the bug in authentication module';
      const instruction = extractClaudeInstructions(text);

      expect(instruction).toBe('fix the bug in authentication module');
    });

    it('should return null if no claude instruction found', () => {
      const text = 'Some text without claude instruction';
      const instruction = extractClaudeInstructions(text);

      expect(instruction).toBe(null);
    });

    it('should handle multiline claude instructions', () => {
      const text = `Some text @claude
      fix the bug
      and add tests`;
      const instruction = extractClaudeInstructions(text);

      expect(instruction).toContain('fix the bug');
      expect(instruction).toContain('and add tests');
    });
  });

  describe('extractAIInstructions', () => {
    it('should extract claude instruction with provider', () => {
      const text = 'Some text @claude fix the bug in authentication module';
      const result = extractAIInstructions(text);

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('claude');
      expect(result?.command).toBe('fix the bug in authentication module');
      expect(result?.model).toBeUndefined();
    });

    it('should extract codex instruction with provider', () => {
      const text = 'Some text @codex refactor this function';
      const result = extractAIInstructions(text);

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('codex');
      expect(result?.command).toBe('refactor this function');
      expect(result?.model).toBeUndefined();
    });

    it('should extract claude instruction with model parameter', () => {
      const text = '@claude[model=claude-sonnet-4-20250514] fix the TypeScript errors';
      const result = extractAIInstructions(text);

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('claude');
      expect(result?.model).toBe('claude-sonnet-4-20250514');
      expect(result?.command).toBe('fix the TypeScript errors');
    });

    it('should extract codex instruction with model parameter', () => {
      const text = '@codex[model=gpt-5.1-codex-max] optimize performance';
      const result = extractAIInstructions(text);

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('codex');
      expect(result?.model).toBe('gpt-5.1-codex-max');
      expect(result?.command).toBe('optimize performance');
    });

    it('should return null if no AI instruction found', () => {
      const text = 'Some text without ai instruction';
      const result = extractAIInstructions(text);

      expect(result).toBeNull();
    });

    it('should handle multiline instructions', () => {
      const text = `@claude
      - fix the bug
      - add tests
      - update docs`;
      const result = extractAIInstructions(text);

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('claude');
      expect(result?.command).toContain('fix the bug');
      expect(result?.command).toContain('add tests');
    });
  });

  describe('isCodeReviewCommand', () => {
    it('should detect the official code review slash command', () => {
      expect(isCodeReviewCommand('/code-review')).toBe(true);
      expect(isCodeReviewCommand('/code-review focus on bugs')).toBe(true);
    });

    it('should use configured review commands with exact-or-whitespace matching', () => {
      expect(isCodeReviewCommand('/review-me', ['/review-me'])).toBe(true);
      expect(isCodeReviewCommand('/review-me auth edge cases', ['/review-me'])).toBe(true);
      expect(isCodeReviewCommand('/review-me-now', ['/review-me'])).toBe(false);
    });

    it('should reject non-review commands', () => {
      expect(isCodeReviewCommand('review this merge request')).toBe(false);
      expect(isCodeReviewCommand('fix the bug')).toBe(false);
    });
  });

  describe('extractCodeReviewFocus', () => {
    it('should extract trailing review focus text', () => {
      expect(extractCodeReviewFocus('/code-review focus on auth edge cases')).toBe(
        'focus on auth edge cases'
      );
    });

    it('should extract focus from the matched configured review command', () => {
      expect(extractCodeReviewFocus('/review-me auth edge cases', ['/review-me'])).toBe(
        'auth edge cases'
      );
    });

    it('should return undefined when no extra focus is provided', () => {
      expect(extractCodeReviewFocus('/code-review')).toBeUndefined();
      expect(extractCodeReviewFocus('fix the bug')).toBeUndefined();
    });
  });
});

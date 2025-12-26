import {
  verifyGitLabSignature,
  extractClaudeInstructions,
  extractAIInstructions,
} from '../utils/webhook';

// Mock the config
jest.mock('../utils/config', () => ({
  config: {
    webhook: {
      secret: 'test-secret',
    },
  },
}));

describe('Webhook Utils', () => {
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
});

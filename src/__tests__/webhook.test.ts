import { verifyGitLabSignature, extractClaudeInstructions } from '../utils/webhook';

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
});

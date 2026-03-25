import {
  GitLabReviewService,
  PreparedReviewContext,
  ReviewFinding,
} from '../services/gitlabReviewService';

describe('GitLabReviewService', () => {
  const service = new GitLabReviewService({} as any);

  const context: PreparedReviewContext = {
    projectId: 1,
    mergeRequestIid: 2,
    mergeRequestTitle: 'Test MR',
    mergeRequestDescription: 'Description',
    mergeRequestUrl: 'https://gitlab.example.com/group/project/-/merge_requests/2',
    mergeRequestState: 'opened',
    draft: false,
    workInProgress: false,
    sourceBranch: 'feature/test',
    targetBranch: 'main',
    baseSha: 'base-sha',
    startSha: 'start-sha',
    headSha: 'head-sha',
    diffs: [{ old_path: 'src/a.ts', new_path: 'src/a.ts' }],
    claudeGuidelineFiles: ['CLAUDE.md'],
  };

  describe('buildReviewPasses', () => {
    it('should create multiple review passes and include user focus', () => {
      const passes = service.buildReviewPasses(context, 'focus on auth');

      expect(passes).toHaveLength(4);
      expect(passes[0]?.prompt).toContain('focus on auth');
    });
  });

  describe('parseReviewOutput', () => {
    it('should parse findings from a JSON code block', () => {
      const output = `\`\`\`json
{
  "summary": "Found an issue",
  "findings": [
    {
      "title": "Bug",
      "body": "This is real",
      "confidence": 90,
      "path": "src/a.ts",
      "line": 12,
      "line_type": "new",
      "category": "bug",
      "old_path": "src/a.ts",
      "new_path": "src/a.ts"
    }
  ]
}
\`\`\``;

      const result = service.parseReviewOutput(output);

      expect(result.summary).toBe('Found an issue');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.title).toBe('Bug');
    });
  });

  describe('mergeCandidateFindings', () => {
    it('should merge duplicate findings and combine sources', () => {
      const findings: ReviewFinding[] = [
        {
          title: 'Bug',
          body: 'First rationale',
          confidence: 70,
          path: 'src/a.ts',
          line: 10,
          lineType: 'new',
          sources: ['Bug scan'],
        },
        {
          title: 'Bug',
          body: 'Second rationale',
          confidence: 85,
          path: 'src/a.ts',
          line: 10,
          lineType: 'new',
          sources: ['History and blame context'],
        },
      ];

      const merged = service.mergeCandidateFindings(findings);

      expect(merged).toHaveLength(1);
      expect(merged[0]?.confidence).toBe(85);
      expect(merged[0]?.body).toContain('Additional corroboration');
      expect(merged[0]?.sources).toEqual([
        'Bug scan',
        'History and blame context',
      ]);
    });
  });

  describe('parseScoredFinding', () => {
    it('should preserve fallback fields when the scorer omits them', () => {
      const fallback: ReviewFinding = {
        title: 'Fallback title',
        body: 'Fallback body',
        confidence: 60,
        path: 'src/a.ts',
        line: 7,
        lineType: 'new',
        sources: ['Bug scan'],
      };

      const output = `\`\`\`json
{
  "title": "Verified issue",
  "body": "Verified body",
  "confidence": 95,
  "path": "src/a.ts",
  "line": 7,
  "line_type": "new",
  "verdict": "Confirmed in diff"
}
\`\`\``;

      const scored = service.parseScoredFinding(output, fallback);

      expect(scored).not.toBeNull();
      expect(scored?.confidence).toBe(95);
      expect(scored?.verdict).toBe('Confirmed in diff');
      expect(scored?.sources).toEqual(['Bug scan']);
    });
  });

  describe('buildIncompleteReviewMessage', () => {
    it('should mention partial coverage and failed stages', () => {
      const message = service.buildIncompleteReviewMessage('head-sha', {
        completedStages: ['History and blame context'],
        failedStages: ['Shallow bug scan', 'CLAUDE.md compliance'],
        note: 'Some stages timed out.',
      });

      expect(message).toContain('Review completed with partial coverage.');
      expect(message).toContain('Shallow bug scan');
      expect(message).toContain('CLAUDE.md compliance');
      expect(message).toContain('Some stages timed out.');
    });
  });
});

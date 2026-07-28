import {
  GitLabReviewService,
  PreparedReviewContext,
  ReviewFinding,
} from '../services/gitlabReviewService';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';

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

    it('uses published admin prompt versions for review passes', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-service-prompts-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.updatePrompt('bug-scan', {
        draft: {
          focus: ['Look specifically for cache invalidation regressions.'],
          systemInstructions: 'Prefer reproducible data flow evidence.',
        },
      });
      await customization.publishPrompt('bug-scan', 'Cache focus');

      const customService = new GitLabReviewService({} as any, customization);
      const passes = customService.buildReviewPasses(context);
      const bugPass = passes.find(pass => pass.id === 'bug-scan');

      expect(bugPass?.label).toBe('Shallow bug scan');
      expect(bugPass?.prompt).toContain('Look specifically for cache invalidation regressions.');
      expect(bugPass?.prompt).toContain('Prefer reproducible data flow evidence.');
    });

    it('appends matching admin skills to review pass prompts', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-service-skills-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.createSkill({
        name: 'Security review',
        description: 'Security focused pass instructions.',
        provider: 'any',
        fileGlobs: ['src/**'],
        languageHints: ['typescript'],
        promptIds: ['bug-scan'],
        systemInstructions: 'Prioritize auth bypasses and leaked secrets.',
        priority: 50,
      });

      const customService = new GitLabReviewService({} as any, customization);
      const passes = customService.buildReviewPasses(context);
      const bugPass = passes.find(pass => pass.id === 'bug-scan');
      const guidelinePass = passes.find(pass => pass.id === 'claude-guidelines');

      expect(bugPass?.prompt).toContain('Admin skill instructions:');
      expect(bugPass?.prompt).toContain('Security review');
      expect(bugPass?.prompt).toContain('Prioritize auth bypasses and leaked secrets.');
      expect(guidelinePass?.prompt).not.toContain('Prioritize auth bypasses');
    });

    it('uses the actual review provider when matching skills', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-provider-skills-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.createSkill({
        name: 'Codex TypeScript review',
        description: '',
        provider: 'codex',
        fileGlobs: ['src/**'],
        languageHints: ['typescript'],
        promptIds: ['bug-scan'],
        systemInstructions: 'Inspect TypeScript state transitions.',
        priority: 20,
      });
      const customService = new GitLabReviewService({} as any, customization);

      const codexPasses = customService.buildReviewPasses(context, undefined, undefined, 'codex');
      const claudePasses = customService.buildReviewPasses(context, undefined, undefined, 'claude');

      expect(codexPasses.find(pass => pass.id === 'bug-scan')?.prompt).toContain(
        'Inspect TypeScript state transitions.'
      );
      expect(claudePasses.find(pass => pass.id === 'bug-scan')?.prompt).not.toContain(
        'Inspect TypeScript state transitions.'
      );
    });

    it('renders timeout budget variables in review pass prompt templates', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-pass-time-budget-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.updatePromptTemplate('review.pass.template', {
        draft: {
          body:
            'Pass {{reviewPassLabel}} budget {{timeoutMinutes}}/{{softDeadlineMinutes}}/{{wrapUpMinutes}}.',
        },
      });
      await customization.publishPromptTemplate('review.pass.template', 'Custom pass budget');

      const customService = new GitLabReviewService({} as any, customization);
      const passes = (customService as any).buildReviewPasses(context, undefined, {
        timeoutMinutes: 13,
        softDeadlineMinutes: 10,
        wrapUpMinutes: 2,
      });

      expect(passes[0]?.prompt).toBe('Pass CLAUDE.md compliance budget 13/10/2.');
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

  describe('buildScoringPrompt', () => {
    it('uses published admin review scoring prompt templates', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-scoring-template-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.updatePromptTemplate('review.scoring.template', {
        draft: {
          body: 'Custom score {{candidateTitle}} in {{mergeRequestUrl}}.',
        },
      });
      await customization.publishPromptTemplate('review.scoring.template', 'Custom scoring');

      const customService = new GitLabReviewService({} as any, customization);
      const prompt = customService.buildScoringPrompt(context, {
        title: 'Potential regression',
        body: 'The change may break retry handling.',
        confidence: 80,
        path: 'src/a.ts',
        line: 10,
        lineType: 'new',
      });

      expect(prompt).toBe(
        'Custom score Potential regression in https://gitlab.example.com/group/project/-/merge_requests/2.'
      );
    });

    it('renders timeout budget variables in review scoring prompt templates', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-scoring-time-budget-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.updatePromptTemplate('review.scoring.template', {
        draft: {
          body:
            'Score {{candidateTitle}} with budget {{timeoutMinutes}}/{{softDeadlineMinutes}}/{{wrapUpMinutes}}.',
        },
      });
      await customization.publishPromptTemplate('review.scoring.template', 'Custom scoring budget');

      const customService = new GitLabReviewService({} as any, customization);
      const prompt = (customService as any).buildScoringPrompt(
        context,
        {
          title: 'Potential regression',
          body: 'The change may break retry handling.',
          confidence: 80,
          path: 'src/a.ts',
          line: 10,
          lineType: 'new',
        },
        undefined,
        {
          timeoutMinutes: 13,
          softDeadlineMinutes: 10,
          wrapUpMinutes: 2,
        }
      );

      expect(prompt).toBe('Score Potential regression with budget 13/10/2.');
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
      expect(merged[0]?.sources).toEqual(['Bug scan', 'History and blame context']);
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

  describe('postReview', () => {
    it('renders structured finding links as readable file line anchors', async () => {
      const gitlabService = {
        addMergeRequestComment: jest.fn().mockResolvedValue(undefined),
        createMergeRequestDiscussion: jest.fn().mockResolvedValue(undefined),
      };
      const customService = new GitLabReviewService(gitlabService as any);

      await customService.postReview(
        {
          object_kind: 'merge_request',
          user: { id: 1, name: 'User', username: 'user', email: 'user@example.com' },
          project: {
            id: 1,
            name: 'project',
            web_url: 'https://gitlab.example.com/group/project',
            default_branch: 'main',
          },
          object_attributes: {},
          merge_request: {
            id: 2,
            iid: 2,
            title: 'Test MR',
            description: '',
            state: 'opened',
            web_url: 'https://gitlab.example.com/group/project/-/merge_requests/2',
            source_branch: 'feature/test',
            target_branch: 'main',
            author: { id: 1, name: 'User', username: 'user', email: 'user@example.com' },
          },
        },
        context,
        {
          summary: 'Found one issue',
          findings: [
            {
              title: 'Bug',
              body: 'This is real',
              confidence: 95,
              path: 'src/a file.ts',
              line: 12,
              lineType: 'new',
            },
          ],
        }
      );

      const body = gitlabService.addMergeRequestComment.mock.calls[0]?.[2] as string;

      expect(body).toContain(
        '[src/a file.ts:12](https://gitlab.example.com/group/project/-/blob/head-sha/src/a%20file.ts#L12)'
      );
      expect(body).not.toContain(
        '\nhttps://gitlab.example.com/group/project/-/blob/head-sha/src/a%20file.ts#L12\n'
      );
    });
  });

  describe('buildIncompleteReviewMessage', () => {
    it('should mention partial coverage and failed stages', () => {
      const message = service.buildIncompleteReviewMessage('head-sha', {
        context,
        completedPasses: [
          {
            passId: 'bug-scan',
            label: 'Shallow bug scan',
            summary: 'Read the changed files and did not find obvious correctness issues.',
            findings: [],
          },
        ],
        completedStages: ['History and blame context'],
        failedStages: ['Shallow bug scan', 'CLAUDE.md compliance'],
        note: 'Some stages timed out.',
      });

      expect(message).toContain('Review completed with partial coverage.');
      expect(message).toContain('Touched files reviewed:');
      expect(message).toContain('src/a.ts');
      expect(message).toContain('Completed stage summaries:');
      expect(message).toContain('Read the changed files');
      expect(message).toContain('Shallow bug scan');
      expect(message).toContain('CLAUDE.md compliance');
      expect(message).toContain('Some stages timed out.');
    });
  });

  describe('buildNoIssuesMessage', () => {
    it('should include reviewed files and completed pass summaries', () => {
      const message = service.buildNoIssuesMessage('head-sha', {
        context,
        completedPasses: [
          {
            passId: 'contracts',
            label: 'Comments and local contracts',
            summary: 'Checked the touched files for local invariants and comments.',
            findings: [],
          },
        ],
      });

      expect(message).toContain('Files reviewed: 1');
      expect(message).toContain('Touched files reviewed:');
      expect(message).toContain('Completed stage summaries:');
      expect(message).toContain('Checked the touched files for local invariants and comments.');
    });
  });
});

/* eslint-disable no-console */
/**
 * Smoke test of one review pass through the production Claude path, against a local git repo:
 *
 *   GitLabReviewService.buildReviewPasses  -> pass prompt, skill names, skill slash command
 *   StreamingClaudeExecutor.executeWithStreaming -> plugin load, slash command prefix,
 *                                                  inline skills, structured output
 *
 * Usage (run as a non-root user with a clean environment, from the repo root):
 *   SMOKE_REPO=/tmp/review-fixture SMOKE_TARGET=main SMOKE_SOURCE=feat/pager-arith \
 *   CLAUDE_DEFAULT_MODEL=<model> npx ts-node --transpile-only scripts/review-pass-smoke.ts [passId]
 *
 * The repo must have SMOKE_SOURCE checked out and SMOKE_TARGET available as a local branch.
 */
import 'dotenv/config';
import path from 'path';
import { execSync } from 'child_process';
import {
  GitLabReviewService,
  PreparedReviewContext,
  REVIEW_PASS_OUTPUT_SCHEMA,
} from '../src/services/gitlabReviewService';
import { StreamingClaudeExecutor } from '../src/services/streamingClaudeExecutor';
import { ReviewSkillCatalog } from '../src/services/reviewSkillCatalog';
import { reviewCustomizationService } from '../src/utils/reviewCustomization';
import type { GitLabWebhookEvent } from '../src/types/gitlab';

const repo = process.env.SMOKE_REPO || '/tmp/review-fixture';
const target = process.env.SMOKE_TARGET || 'main';
const source = process.env.SMOKE_SOURCE || 'feat/pager-arith';
const passId = process.argv[2] || 'bug-scan';
const pluginDir = path.resolve(__dirname, '..', 'review-skills');

const changedFiles = execSync(`git diff --name-only ${target}...HEAD`, {
  cwd: repo,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

const context: PreparedReviewContext = {
  projectId: 1,
  mergeRequestIid: 1,
  mergeRequestTitle: 'perf: simplify pager arithmetic',
  mergeRequestDescription: 'Simplifies the pagination arithmetic in the pager helpers.',
  mergeRequestUrl: 'https://gitlab.example.com/demo/pager/-/merge_requests/1',
  mergeRequestState: 'opened',
  draft: false,
  workInProgress: false,
  sourceBranch: source,
  targetBranch: target,
  baseSha: 'base',
  startSha: 'start',
  headSha: 'head',
  diffs: changedFiles.map(file => ({ old_path: file, new_path: file })),
  claudeGuidelineFiles: [],
};

(async () => {
  const catalog = new ReviewSkillCatalog(pluginDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new GitLabReviewService({} as any, reviewCustomizationService, catalog);
  const pass = service
    .buildReviewPasses(context, undefined, undefined, 'claude')
    .find(candidate => candidate.id === passId);
  if (!pass) {
    throw new Error(`unknown pass id: ${passId}`);
  }

  const inlineSkills = Array.from(pass.prompt.matchAll(/<skill name="([^"]+)">/g)).map(m => m[1]);
  console.log('changed files    :', changedFiles.join(', '));
  console.log('pass.skillNames  :', pass.skillNames.join(', '));
  console.log('pass.skillCommand:', pass.skillCommand);
  console.log(
    'pass.prompt      :',
    `${pass.prompt.length} chars; inline skills: ${inlineSkills.join(', ') || 'none'}`
  );

  const executor = new StreamingClaudeExecutor(reviewCustomizationService, catalog);
  const started = Date.now();
  const result = await executor.executeWithStreaming(
    pass.prompt,
    repo,
    {
      context: 'MR #1: Review',
      projectUrl: 'https://gitlab.example.com/demo/pager',
      branch: source,
      event: { object_kind: 'note' } as GitLabWebhookEvent,
      instruction: 'Review the merge request',
      mode: 'review',
      skills: pass.skillNames,
      skillCommand: pass.skillCommand,
      outputSchema: REVIEW_PASS_OUTPUT_SCHEMA,
      maxTurns: Number(process.env.SMOKE_MAX_TURNS || 25),
    },
    {
      onProgress: async message => console.log('progress         :', message.slice(0, 160)),
      onError: async error => console.log('error            :', error),
    }
  );

  console.log(
    'success          :',
    result.success,
    `elapsed ${Math.round((Date.now() - started) / 1000)}s`
  );
  if (result.error) {
    console.log('error            :', result.error);
  }
  const parsed = service.parseReviewOutput(result.output || '', 0);
  console.log('summary          :', parsed.summary);
  for (const finding of parsed.findings) {
    console.log(
      'finding          :',
      `${finding.path}:${finding.line} [${finding.confidence}] ${finding.title}`
    );
  }
  console.log('raw output       :', (result.output || '').slice(0, 2000));
})().catch(error => {
  console.error('SMOKE FAILED:', error);
  process.exit(1);
});

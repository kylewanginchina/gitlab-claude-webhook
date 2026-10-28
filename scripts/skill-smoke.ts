/* eslint-disable no-console */
/**
 * SDK-level smoke test for the review skill plugin and structured output.
 *
 * Usage (from repo root, with ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL in env or .env):
 *   npx ts-node --transpile-only scripts/skill-smoke.ts [--max-turns-check]
 *
 * Verifies, against the real Agent SDK binary:
 *   1. the review-skills/ plugin loads and `/gitlab-review:mr-review-core` at the start of the
 *      prompt expands the skill (no Skill tool involved)
 *   2. the run returns `structured_output` matching REVIEW_PASS_OUTPUT_SCHEMA
 *   3. (optional) maxTurns is enforced and surfaces as error_max_turns
 *
 * For the full production prompt path use scripts/review-pass-smoke.ts instead.
 */
import 'dotenv/config';
import path from 'path';
import { randomUUID } from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { REVIEW_PASS_OUTPUT_SCHEMA } from '../src/services/gitlabReviewService';
import { createClaudeExecutionEnvironment } from '../src/utils/providerEnvironment';

const pluginPath = path.resolve(__dirname, '..', 'review-skills');
const model = process.env.CLAUDE_DEFAULT_MODEL;
const skillCommand = process.env.SMOKE_SKILL_COMMAND || '/gitlab-review:mr-review-core';

async function run(label: string, maxTurns: number) {
  const sessionId = randomUUID();
  const env = createClaudeExecutionEnvironment(
    process.env.ANTHROPIC_AUTH_TOKEN || '',
    process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    sessionId
  );
  console.log(`\n=== ${label} (maxTurns=${maxTurns}) ===`);
  const started = Date.now();
  const q = query({
    prompt:
      `${skillCommand}\n\n` +
      'Review the most recent commit in this repository (git show HEAD) as if it were a merge request. ' +
      'Return the structured result.',
    options: {
      sessionId,
      cwd: process.env.SMOKE_CWD || process.cwd(),
      model,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      plugins: [{ type: 'local', path: pluginPath }],
      skills: (process.env.SMOKE_SKILLS || 'mr-review-core,typescript-review').split(','),
      tools: ['Bash', 'Read', 'Glob', 'Grep'],
      disallowedTools: ['Task', 'Agent', 'WebFetch', 'WebSearch', 'Write', 'Edit'],
      maxTurns,
      outputFormat: { type: 'json_schema', schema: REVIEW_PASS_OUTPUT_SCHEMA },
      env,
    },
  });

  for await (const m of q) {
    const msg = m as any;
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log('init.model      :', msg.model);
      console.log('init.tools      :', msg.tools);
      console.log('init.skills     :', msg.skills);
      console.log('init.plugins    :', msg.plugins);
      console.log('init.slash_cmds :', msg.slash_commands);
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'text') {
          console.log('assistant.text  :', String(block.text).replace(/\n/g, ' ').slice(0, 400));
        }
        if (block.type === 'tool_use') {
          const brief = JSON.stringify(block.input).slice(0, 100);
          console.log(`tool_use        : ${block.name} ${brief}`);
        }
      }
    }
    if (msg.type === 'result') {
      console.log('result.subtype  :', msg.subtype);
      console.log('result.turns    :', msg.num_turns, 'cost:', msg.total_cost_usd);
      console.log('result.errors   :', msg.errors);
      console.log('result.keys     :', Object.keys(msg).join(','));
      console.log('result.text     :', String(msg.result || '').slice(0, 1500));
      console.log('structured_output:', JSON.stringify(msg.structured_output, null, 2));
      console.log('elapsed         :', Math.round((Date.now() - started) / 1000), 's');
    }
  }
}

(async () => {
  await run('full run', Number(process.env.SMOKE_MAX_TURNS || 30));
  if (process.argv.includes('--max-turns-check')) {
    await run('max-turns check', 2);
  }
})().catch(err => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});

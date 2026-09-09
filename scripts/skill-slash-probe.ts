/* eslint-disable no-console */
/**
 * Probe: can a review skill be triggered deterministically, without relying on the
 * model choosing to call the Skill tool?
 *
 *   PROBE_MODE=slash  -> prompt starts with "/<plugin>:<skill> ..." (slash-command expansion)
 *   PROBE_MODE=agent  -> main-thread agent with AgentDefinition.skills preload
 *
 * Prints every message in the stream (including user messages, where slash
 * expansion shows up) so the mechanism can be observed directly.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeExecutionEnvironment } from '../src/utils/providerEnvironment';

const env = createClaudeExecutionEnvironment(
  process.env.ANTHROPIC_AUTH_TOKEN || '',
  process.env.ANTHROPIC_BASE_URL || ''
);
const mode = process.env.PROBE_MODE || 'slash';
const prompt = process.env.PROBE_PROMPT_FILE
  ? fs.readFileSync(process.env.PROBE_PROMPT_FILE, 'utf8').trimEnd()
  : process.env.PROBE_PROMPT || '/gitlab-review:mr-review-core';
const skills = (process.env.SMOKE_SKILLS || 'mr-review-core').split(',');

function short(value: unknown, n = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > n ? `${text.slice(0, n)}…(${text.length} chars)` : text;
}

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: any = {
    cwd: process.cwd(),
    model: process.env.CLAUDE_DEFAULT_MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    plugins: [{ type: 'local', path: path.resolve(process.env.PLUGIN_DIR || 'review-skills') }],
    skills,
    tools: (process.env.PROBE_TOOLS || 'Read,Skill').split(',').filter(Boolean),
    maxTurns: Number(process.env.SMOKE_MAX_TURNS || 3),
    env,
    stderr: (d: string) => {
      if (/error|warn/i.test(d)) process.stdout.write(`[stderr] ${d}`);
    },
  };
  if (mode === 'agent') {
    options.agents = {
      'gitlab-reviewer': {
        description: 'GitLab merge request reviewer',
        prompt: 'You are a merge request reviewer.',
        skills,
      },
    };
    options.agent = 'gitlab-reviewer';
  }
  console.log(`mode=${mode} skills=${skills.join(',')}`);
  console.log(`prompt=${short(prompt, 200)}`);

  const started = Date.now();
  const q = query({ prompt, options });
  for await (const m of q) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = m as any;
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log('init.skills      :', JSON.stringify(msg.skills));
      console.log('init.slash_cmds  :', JSON.stringify(msg.slash_commands));
      console.log('init.agents      :', JSON.stringify(msg.agents));
      continue;
    }
    if (msg.type === 'user') {
      const content = msg.message?.content;
      if (typeof content === 'string') {
        console.log('user.text        :', short(content));
      } else {
        for (const b of content || []) {
          if (b.type === 'text') console.log('user.text        :', short(b.text));
          if (b.type === 'tool_result') console.log('user.tool_result :', short(b.content, 300));
        }
      }
      continue;
    }
    if (msg.type === 'assistant') {
      for (const b of msg.message?.content || []) {
        if (b.type === 'tool_use') console.log('assistant.tool   :', b.name, short(b.input, 200));
        if (b.type === 'text') console.log('assistant.text   :', short(b.text, 600));
      }
      continue;
    }
    if (msg.type === 'result') {
      console.log(
        'result           :',
        msg.subtype,
        'turns',
        msg.num_turns,
        'cost',
        msg.total_cost_usd,
        'elapsed',
        `${Math.round((Date.now() - started) / 1000)}s`,
        msg.errors || ''
      );
      continue;
    }
    console.log('other            :', msg.type, msg.subtype || '');
  }
})().catch(e => console.error('ERR', e.message));

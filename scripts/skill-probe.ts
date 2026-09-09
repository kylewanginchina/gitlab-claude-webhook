/* eslint-disable no-console */
import 'dotenv/config';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeExecutionEnvironment } from '../src/utils/providerEnvironment';
const env = createClaudeExecutionEnvironment(
  process.env.ANTHROPIC_AUTH_TOKEN || '',
  process.env.ANTHROPIC_BASE_URL || ''
);
const skills = (process.env.SMOKE_SKILLS || 'mr-review-core').split(',');
(async () => {
  const q = query({
    prompt:
      'List every skill name available to you via the Skill tool (just the names, one per line). Then invoke the skill whose name contains "mr-review-core" and reply with the first heading of its content. Do not read any files.',
    options: {
      cwd: process.cwd(),
      model: process.env.CLAUDE_DEFAULT_MODEL,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      plugins: [{ type: 'local', path: path.resolve('review-skills') }],
      skills,
      tools: ['Read', 'Skill'],
      maxTurns: 6,
      env,
      stderr: (d: string) => {
        if (/error|warn/i.test(d)) process.stdout.write('[stderr] ' + d);
      },
    },
  });
  const t = Date.now();
  for await (const m of q) {
    const msg = m as any;
    if (msg.type === 'system' && msg.subtype === 'init')
      console.log('init.skills:', JSON.stringify(msg.skills));
    if (msg.type === 'assistant')
      for (const b of msg.message?.content || []) {
        if (b.type === 'tool_use') console.log('tool_use:', b.name, JSON.stringify(b.input));
        if (b.type === 'text') console.log('text:', b.text.slice(0, 600));
      }
    if (msg.type === 'user')
      for (const b of msg.message?.content || [])
        if (b.type === 'tool_result')
          console.log('tool_result:', JSON.stringify(b.content).slice(0, 300));
    if (msg.type === 'result')
      console.log(
        'result:',
        msg.subtype,
        'turns',
        msg.num_turns,
        'elapsed',
        Math.round((Date.now() - t) / 1000) + 's',
        msg.errors || ''
      );
  }
})().catch(e => console.error('ERR', e.message));

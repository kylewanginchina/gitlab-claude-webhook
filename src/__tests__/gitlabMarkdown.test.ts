import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  formatProgressComment,
  inferProgressStatus,
  linkifyReviewReferences,
  sanitizeProgressMessage,
} from '../utils/gitlabMarkdown';

describe('gitlab markdown helpers', () => {
  it('formats progress updates as an aligned, low-noise GitLab table', () => {
    const startedAt = new Date('2026-07-06T09:13:32.817Z');
    const updatedAt = new Date('2026-07-06T09:20:31.817Z');

    const body = formatProgressComment({
      entries: [
        {
          timestamp: startedAt,
          status: 'search',
          message: '🔎 Grep infer_l7_class_1 in /tmp/gitlab-claude-work/agent/src/ebpf/k...',
        },
        {
          timestamp: updatedAt,
          status: 'success',
          message: '✅ Claude execution completed successfully!',
        },
      ],
      isComplete: true,
      updatedAt,
    });

    expect(body).toContain('### AI Agent Progress Report');
    expect(body).toContain('| Time (UTC+08) | Status | Activity |');
    expect(body).toContain(
      '| 17:13:32 | Search | Grep `infer_l7_class_1` in `/tmp/gitlab-claude-work/agent/src/ebpf/k...` |'
    );
    expect(body).toContain('| 17:20:31 | Completed | Claude execution completed successfully. |');
    expect(body).toContain('**Status:** Completed successfully');
    expect(body).toContain('Last updated: 2026-07-06 17:20:31 UTC+08:00');
    expect(body).not.toContain('🔎');
    expect(body).not.toContain('✅');
    expect(body).not.toContain('2026-07-06T09:20:31.817Z');
  });

  it('shows progress start time and elapsed duration when provided', () => {
    const startedAt = new Date('2026-07-06T09:13:32.000Z');
    const updatedAt = new Date('2026-07-06T09:15:37.000Z');

    const body = formatProgressComment({
      entries: [
        {
          timestamp: startedAt,
          status: 'queued',
          message: 'Claude is starting to work.',
        },
      ],
      startedAt,
      updatedAt,
    });

    expect(body).toContain('### AI Agent Progress Report');
    expect(body).toContain('**Started:** 2026-07-06 17:13:32 UTC+08:00');
    expect(body).toContain('**Elapsed:** 2m 5s');
  });

  it('normalizes noisy progress emoji into professional status text', () => {
    expect(sanitizeProgressMessage('📖 Read /tmp/project/agent/src/ebpf/user/config.h')).toBe(
      'Read `/tmp/project/agent/src/ebpf/user/config.h`'
    );
    expect(sanitizeProgressMessage('⚠️ A validation command failed before review.')).toBe(
      'A validation command failed before review.'
    );
  });

  it.each([
    ['[Scorer 2] 📖 Read /tmp/project/file.ts', '[Scorer 2] Read `/tmp/project/file.ts`'],
    [
      '[Security review] 🔎 Grep unsafe in /tmp/project',
      '[Security review] Grep `unsafe` in `/tmp/project`',
    ],
    ['[Scorer 1] 💻 Bash git diff -- src/a.ts', '[Scorer 1] Bash `git diff -- src/a.ts`'],
    ['[Diff review] 🗂️ Glob **/*.ts', '[Diff review] Glob `**/*.ts`'],
    ['[Scorer 2] ⚙️ Using tool: StructuredOutput', '[Scorer 2] Using tool: StructuredOutput'],
    ['[Scorer 1] ⏳ Bash still running (1m 5s)', '[Scorer 1] Bash `still running (1m 5s)`'],
    [
      '[Scorer 2] ✅ Claude execution completed successfully!',
      '[Scorer 2] Claude execution completed successfully.',
    ],
    [
      '  [Scorer 1]  ⚠️ A validation command failed before review. ',
      '[Scorer 1] A validation command failed before review.',
    ],
    ['[Scorer 2] ❌ Execution failed: unavailable', '[Scorer 2] Execution failed: unavailable'],
    [
      '[Scorer 1] 🤖 Checking unicode 🔒 in /tmp/🔑/配置.ts.',
      '[Scorer 1] Checking unicode 🔒 in /tmp/🔑/配置.ts.',
    ],
    ['[Scorer 2] 📖 Read /tmp/🔑/配置.ts', '[Scorer 2] Read `/tmp/🔑/配置.ts`'],
    ['[Scorer 1] Read `/tmp/project/file.ts`', '[Scorer 1] Read `/tmp/project/file.ts`'],
  ])('normalizes stage progress without changing its label or content: %s', (message, expected) => {
    expect(sanitizeProgressMessage(message)).toBe(expected);
    expect(sanitizeProgressMessage(expected)).toBe(expected);
  });

  it.each([
    ['[Scorer 2] 📖 Read /tmp/project/file.ts', 'read'],
    ['[Security review] 🔎 Grep unsafe in /tmp/project', 'search'],
    ['[Scorer 1] 💻 Bash git diff', 'command'],
    ['[Security review] Read /tmp/project/file.ts', 'read'],
    ['[Scorer 2] Grep unsafe in /tmp/project', 'search'],
    ['[Scorer 1] Bash git diff', 'command'],
    ['[Security review] ⚙️ Using tool: StructuredOutput', 'running'],
    ['[Scorer 1] 🤖 Reviewing the changed lines.', 'review'],
    ['[Scorer 2] 🔧 Claude session initialized', 'queued'],
    ['[Scorer 2] ✅ Claude execution completed successfully!', 'success'],
    ['[Scorer 1] ⚠️ A validation command failed before review.', 'warning'],
    ['📖 Read /tmp/project/file.ts', 'read'],
    ['🔎 Grep unsafe in /tmp/project', 'search'],
    ['💻 Bash git diff', 'command'],
  ])('infers status from the activity after the stage label: %s', (message, expected) => {
    expect(inferProgressStatus(message)).toBe(expected);
    expect(inferProgressStatus(sanitizeProgressMessage(message))).toBe(expected);
  });

  it('keeps explicit completion and error flags authoritative for stage progress', () => {
    expect(inferProgressStatus('[Scorer 1] Read file.ts', true)).toBe('success');
    expect(inferProgressStatus('[Scorer 1] Read file.ts', false, true)).toBe('error');
    expect(inferProgressStatus('[Scorer 1] ✅ Completed successfully!', true, true)).toBe('error');
  });

  it('links review file and symbol references to GitLab blob lines when they can be resolved', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlab-markdown-links-'));
    await fs.mkdir(path.join(projectPath, 'agent/src/ebpf/user'), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'agent/src/ebpf/user/socket_trace.bpf.c'),
      [
        '#include "socket_trace.bpf.h"',
        '',
        'static int process_data_common(void *ctx) {',
        '  return 0;',
        '}',
        '',
      ].join('\n')
    );
    await fs.writeFile(
      path.join(projectPath, 'agent/src/ebpf/user/config.h'),
      ['#pragma once', '#define USE_SOCKET_TRACE_SYSCALL_TAIL_CALLS 1', ''].join('\n')
    );

    const output = [
      '重点检查点',
      '',
      '- `socket_trace.bpf.c`',
      '  - `process_data_common()` 对 syscall 路径作写入。',
      '  - `agent/src/ebpf/user/config.h:2` 中新增顺序一致。',
      '',
    ].join('\n');

    const linked = await linkifyReviewReferences(output, {
      projectPath,
      projectUrl: 'https://gitlab.example.com/group/project',
      ref: 'feature/review-links',
    });

    expect(linked).toContain(
      '[`socket_trace.bpf.c`](https://gitlab.example.com/group/project/-/blob/feature%2Freview-links/agent/src/ebpf/user/socket_trace.bpf.c)'
    );
    expect(linked).toContain(
      '[`process_data_common()`](https://gitlab.example.com/group/project/-/blob/feature%2Freview-links/agent/src/ebpf/user/socket_trace.bpf.c#L3)'
    );
    expect(linked).toContain(
      '[`agent/src/ebpf/user/config.h:2`](https://gitlab.example.com/group/project/-/blob/feature%2Freview-links/agent/src/ebpf/user/config.h#L2)'
    );
  });
});

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  formatProgressComment,
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

  it('normalizes noisy progress emoji into professional status text', () => {
    expect(sanitizeProgressMessage('📖 Read /tmp/project/agent/src/ebpf/user/config.h')).toBe(
      'Read `/tmp/project/agent/src/ebpf/user/config.h`'
    );
    expect(sanitizeProgressMessage('⚠️ A validation command failed before review.')).toBe(
      'A validation command failed before review.'
    );
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

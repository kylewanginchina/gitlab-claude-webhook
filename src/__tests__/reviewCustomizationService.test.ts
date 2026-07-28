import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';

async function buildService() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-customization-'));
  const service = new ReviewCustomizationService({ dataDir });
  await service.initialize();
  return { dataDir, service };
}

describe('ReviewCustomizationService', () => {
  it('initializes the default review prompts as published passes', async () => {
    const { service } = await buildService();

    const prompts = service.listPrompts();
    const passes = service.getPublishedReviewPasses();

    expect(prompts.map(prompt => prompt.id)).toEqual([
      'claude-guidelines',
      'bug-scan',
      'history-context',
      'comments-and-contracts',
    ]);
    expect(passes).toHaveLength(4);
    expect(passes[0]).toMatchObject({
      id: 'claude-guidelines',
      label: 'CLAUDE.md compliance',
      version: 1,
    });
  });

  it('does not fall back to draft instructions when the published value is empty', async () => {
    const { service } = await buildService();

    await service.updatePrompt('bug-scan', {
      draft: { focus: ['Published focus'], systemInstructions: '' },
    });
    await service.publishPrompt('bug-scan', 'Publish empty instructions');
    await service.updatePrompt('bug-scan', {
      draft: { focus: ['Draft focus'], systemInstructions: 'UNPUBLISHED_DRAFT' },
    });

    const pass = service.getPublishedReviewPasses().find(item => item.id === 'bug-scan');
    expect(pass).toMatchObject({
      focus: ['Published focus'],
      systemInstructions: '',
    });
  });

  it('updates a prompt draft, publishes a new version, and rolls back through version history', async () => {
    const { service } = await buildService();

    await service.updatePrompt('bug-scan', {
      draft: {
        focus: ['Look for state bugs.', 'Ignore formatting noise.'],
        systemInstructions: 'Prefer concrete runtime failures.',
      },
    });

    const published = await service.publishPrompt('bug-scan', 'Tighten bug scope');
    expect(published.currentVersion).toBe(2);
    expect(published.versions).toHaveLength(2);
    expect(published.versions[1]?.focus).toEqual([
      'Look for state bugs.',
      'Ignore formatting noise.',
    ]);

    const rolledBack = await service.rollbackPrompt('bug-scan', 1, 'Restore original scan');
    expect(rolledBack.currentVersion).toBe(3);
    expect(rolledBack.versions[2]?.focus[0]).toContain('Read only the merge request changes');
    expect(rolledBack.draft.focus[0]).toContain('Read only the merge request changes');
  });

  it('initializes default prompt templates and renders published template variables', async () => {
    const { service } = await buildService();

    const templates = service.listPromptTemplates();

    expect(templates.map(template => template.id)).toEqual([
      'claude.edit.system',
      'claude.review.system',
      'claude.context.wrapper',
      'claude.review.fallback',
      'codex.edit.instructions',
      'codex.review.instructions',
      'codex.context.wrapper',
      'review.pass.template',
      'review.scoring.template',
    ]);
    expect(service.getPromptTemplate('claude.edit.system')).toMatchObject({
      provider: 'claude',
      scope: 'edit',
      currentVersion: 1,
    });

    await service.updatePromptTemplate('claude.context.wrapper', {
      draft: {
        body: 'Context={{context}}\nMode={{mode}}\nRequest={{command}}\nUnknown={{missing}}',
      },
    });
    await service.publishPromptTemplate('claude.context.wrapper', 'Custom wrapper');

    expect(
      service.renderPromptTemplate(
        'claude.context.wrapper',
        {
          context: 'MR #1',
          mode: 'edit',
          command: 'Implement change',
        },
        'fallback'
      )
    ).toBe('Context=MR #1\nMode=edit\nRequest=Implement change\nUnknown={{missing}}');
  });

  it('keeps built-in review templates static-first unless validation is explicitly requested', async () => {
    const { service } = await buildService();

    for (const id of [
      'claude.review.system',
      'codex.review.instructions',
      'review.pass.template',
      'review.scoring.template',
    ]) {
      const body = service.getPromptTemplate(id).versions[0]?.body || '';
      expect(body).toContain(
        'Do not run build, compile, test, lint, or format commands unless the user explicitly requests that validation.'
      );
    }
  });

  it('refreshes unmodified system prompt template defaults when built-in defaults change', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-customization-migrate-'));
    const oldBody =
      'You are working in an automated webhook environment in read-only review mode. Return a concise, structured review result.';
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'prompt-templates.json'),
      JSON.stringify(
        [
          {
            id: 'claude.review.system',
            label: 'Claude review system prompt',
            description: 'System prompt append used by Claude read-only review tasks.',
            enabled: true,
            provider: 'claude',
            scope: 'review',
            currentVersion: 1,
            draft: { body: oldBody },
            versions: [
              {
                body: oldBody,
                version: 1,
                createdAt: '2026-07-01T00:00:00.000Z',
                createdBy: 'system',
                changelog: 'Initial default prompt template',
              },
            ],
            defaultBody: oldBody,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
        null,
        2
      )
    );

    const service = new ReviewCustomizationService({ dataDir });
    await service.initialize();

    const template = service.getPromptTemplate('claude.review.system');
    expect(template.defaultBody).toContain('{{timeoutMinutes}}');
    expect(template.draft.body).toContain('{{timeoutMinutes}}');
    expect(template.versions[0]?.body).toContain('{{timeoutMinutes}}');
  });

  it('rolls prompt templates back by publishing a new version', async () => {
    const { service } = await buildService();

    await service.updatePromptTemplate('codex.edit.instructions', {
      draft: {
        body: 'Custom Codex edit instructions.',
      },
    });
    const published = await service.publishPromptTemplate(
      'codex.edit.instructions',
      'Custom edit instructions'
    );

    expect(published.currentVersion).toBe(2);
    expect(published.versions[1]?.body).toBe('Custom Codex edit instructions.');

    const rolledBack = await service.rollbackPromptTemplate(
      'codex.edit.instructions',
      1,
      'Restore default edit instructions'
    );

    expect(rolledBack.currentVersion).toBe(3);
    expect(rolledBack.draft.body).toContain('Make code changes directly');
    expect(rolledBack.versions[2]?.body).toContain('Make code changes directly');
  });

  it('creates and toggles skills', async () => {
    const { service } = await buildService();

    const skill = await service.createSkill({
      name: 'Security review',
      description: 'Look for auth and secret handling issues.',
      provider: 'any',
      fileGlobs: ['src/**'],
      languageHints: ['typescript'],
      promptIds: ['bug-scan'],
      systemInstructions: 'Prioritize auth bypasses and secret leaks.',
      priority: 20,
    });

    expect(skill.enabled).toBe(true);

    await service.setSkillEnabled(skill.id, false);
    expect(service.listSkills().find(item => item.id === skill.id)?.enabled).toBe(false);

    await service.setSkillEnabled(skill.id, true);
    expect(service.listSkills().find(item => item.id === skill.id)?.enabled).toBe(true);
  });

  it('matches skills by provider, prompt, file glob, and language together', async () => {
    const { service } = await buildService();
    const skill = await service.createSkill({
      name: 'TypeScript Codex review',
      description: '',
      provider: 'codex',
      fileGlobs: ['src/**'],
      languageHints: ['TS'],
      promptIds: ['bug-scan'],
      systemInstructions: 'Inspect TypeScript state transitions.',
      priority: 10,
    });

    expect(
      service
        .getMatchingSkills({ diffs: [{ new_path: 'src/app.ts' }] }, 'bug-scan', 'codex')
        .map(item => item.id)
    ).toContain(skill.id);
    expect(
      service.getMatchingSkills({ diffs: [{ new_path: 'src/app.rs' }] }, 'bug-scan', 'codex')
    ).toEqual([]);
    expect(
      service.getMatchingSkills({ diffs: [{ new_path: 'src/app.ts' }] }, 'bug-scan', 'claude')
    ).toEqual([]);
  });

  it('matches skills with no language hints regardless of detected languages', async () => {
    const { service } = await buildService();
    const skill = await service.createSkill({
      name: 'Codex review without language limit',
      description: '',
      provider: 'codex',
      fileGlobs: ['src/**'],
      languageHints: [],
      promptIds: ['bug-scan'],
      systemInstructions: 'Review all supported languages.',
      priority: 10,
    });

    expect(
      service
        .getMatchingSkills(
          { diffs: [{ new_path: 'src/app.py' }, { new_path: 'src/main.rs' }] },
          'bug-scan',
          'codex'
        )
        .map(item => item.id)
    ).toContain(skill.id);
  });

  it('matches multi-language hints when one changed-file language intersects', async () => {
    const { service } = await buildService();
    const skill = await service.createSkill({
      name: 'TypeScript or Python review',
      description: '',
      provider: 'codex',
      fileGlobs: ['src/**'],
      languageHints: ['TS', 'Py'],
      promptIds: ['bug-scan'],
      systemInstructions: 'Review TypeScript and Python changes.',
      priority: 10,
    });

    expect(
      service
        .getMatchingSkills(
          { diffs: [{ new_path: 'src/main.rs' }, { new_path: 'src/worker.py' }] },
          'bug-scan',
          'codex'
        )
        .map(item => item.id)
    ).toContain(skill.id);
    expect(
      service.getMatchingSkills(
        { diffs: [{ new_path: 'src/main.rs' }, { new_path: 'src/worker.go' }] },
        'bug-scan',
        'codex'
      )
    ).toEqual([]);
  });

  it('records feedback and creates reviewable prompt optimization proposals', async () => {
    const { service } = await buildService();

    await service.createFeedback({
      promptId: 'bug-scan',
      label: 'false_positive',
      note: 'The reviewer flagged generated schema noise that is not actionable.',
      source: 'admin',
    });
    await service.createFeedback({
      promptId: 'bug-scan',
      label: 'missed_issue',
      note: 'It missed a null state regression in request retry handling.',
      source: 'admin',
    });

    const proposals = await service.analyzeFeedback();

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      promptId: 'bug-scan',
      baseVersion: 1,
      status: 'open',
    });
    expect(proposals[0]?.suggestedDraft.focus.join('\n')).toContain('generated schema noise');
    expect(proposals[0]?.suggestedDraft.focus.join('\n')).toContain('null state regression');

    const applied = await service.applyProposal(proposals[0]!.id);
    const prompt = service.getPrompt('bug-scan');

    expect(applied.status).toBe('applied');
    expect(prompt.draft.focus.join('\n')).toContain('generated schema noise');
    expect(prompt.currentVersion).toBe(1);
  });

  it('rejects invalid IDs and malformed payloads', async () => {
    const { service } = await buildService();

    await expect(service.updatePrompt('missing', { label: 'Missing' })).rejects.toThrow(
      'prompt not found'
    );
    await expect(
      service.updatePromptTemplate('missing', {
        draft: { body: 'Missing' },
      })
    ).rejects.toThrow('prompt template not found');
    await expect(
      service.createSkill({
        name: '',
        description: 'No name',
        provider: 'any',
        fileGlobs: [],
        languageHints: [],
        promptIds: [],
        systemInstructions: 'Invalid',
        priority: 1,
      })
    ).rejects.toThrow('skill.name is required');
  });
});

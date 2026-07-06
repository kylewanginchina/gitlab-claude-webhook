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

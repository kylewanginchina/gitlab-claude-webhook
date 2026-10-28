import {
  GitLabReviewService,
  PreparedReviewContext,
  ReviewFinding,
} from '../services/gitlabReviewService';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';
import { runtimeConfigService } from '../utils/runtimeConfig';
import { ReviewSkillCatalog } from '../services/reviewSkillCatalog';
import type { GitLabService } from '../services/gitlabService';

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
    describe.each(['claude', 'codex'] as const)('asset validation for %s', provider => {
      afterEach(() => jest.restoreAllMocks());

      it.each([
        'missing',
        'empty',
        'missing-file',
        'unreadable',
        'empty-body',
        'invalid-frontmatter',
        'invalid-manifest',
        'nameless-manifest',
      ])('rejects %s assets for passes and scoring', async variant => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-invalid-assets-'));
        try {
          if (variant !== 'missing') await fs.mkdir(path.join(root, 'skills'));
          if (!['missing', 'empty'].includes(variant)) {
            const skillDir = path.join(root, 'skills', 'custom-core');
            await fs.mkdir(skillDir);
            const file = path.join(skillDir, 'SKILL.md');
            if (variant === 'unreadable') await fs.mkdir(file);
            else if (variant !== 'missing-file')
              await fs.writeFile(
                file,
                `---\nname: custom-core\ndescription: Custom core\nmetadata:\n  review-always: "true"\n---\n${variant === 'empty-body' ? '' : 'Custom methodology'}`
              );
          }
          if (variant === 'invalid-frontmatter') {
            await fs.writeFile(
              path.join(root, 'skills', 'custom-core', 'SKILL.md'),
              '---\nname: custom-core\nBroken header without closing delimiter'
            );
          }
          if (variant === 'invalid-manifest' || variant === 'nameless-manifest') {
            await fs.mkdir(path.join(root, '.claude-plugin'));
            await fs.writeFile(
              path.join(root, '.claude-plugin', 'plugin.json'),
              variant === 'invalid-manifest' ? '{bad json' : '{"name": ""}'
            );
          }
          const customService = new GitLabReviewService(
            {} as any,
            undefined,
            new ReviewSkillCatalog(root)
          );
          for (const run of [
            () => customService.buildReviewPasses(context, undefined, undefined, provider),
            () => customService.getScoringSkillDelivery(provider),
          ]) {
            expect(run).toThrow(/REVIEW_SKILLS_DIR/);
            expect(run).toThrow(root);
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      });

      it('allows disabled builtins without any assets', () => {
        const config = runtimeConfigService.getConfig();
        jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue({
          ...config,
          review: { ...config.review, useBuiltinSkills: false },
        });
        const customService = new GitLabReviewService(
          {} as any,
          undefined,
          new ReviewSkillCatalog('/missing-disabled-assets')
        );
        expect(
          customService
            .buildReviewPasses(context, undefined, undefined, provider)
            .every(pass => pass.skillNames.length === 0)
        ).toBe(true);
        expect(customService.getScoringSkillDelivery(provider)).toEqual({
          skillNames: [],
          inlineSkills: [],
        });
      });

      it('supports custom plugins with optional always-on metadata and no matching pass', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-optional-always-'));
        try {
          const skillDir = path.join(root, 'skills', 'go-only');
          await fs.mkdir(skillDir, { recursive: true });
          await fs.writeFile(
            path.join(skillDir, 'SKILL.md'),
            '---\nname: go-only\ndescription: Go notes\nmetadata:\n  review-languages: go\n---\nGo methodology'
          );
          const customService = new GitLabReviewService(
            {} as any,
            undefined,
            new ReviewSkillCatalog(root)
          );
          expect(
            customService
              .buildReviewPasses(context, undefined, undefined, provider)
              .every(pass => pass.skillNames.length === 0)
          ).toBe(true);
          expect(customService.getScoringSkillDelivery(provider)).toEqual({
            skillNames: [],
            inlineSkills: [],
          });
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      });

      it('keeps manifest-less custom core naming for passes and scoring', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-custom-assets-'));
        try {
          const skillDir = path.join(root, 'skills', 'custom-core');
          await fs.mkdir(skillDir, { recursive: true });
          await fs.writeFile(
            path.join(skillDir, 'SKILL.md'),
            '---\nname: custom-core\ndescription: Custom core\nmetadata:\n  review-always: "true"\n---\nCustom methodology'
          );
          const customService = new GitLabReviewService(
            {} as any,
            undefined,
            new ReviewSkillCatalog(root)
          );
          const pass = customService.buildReviewPasses(context, undefined, undefined, provider)[0];
          const scoring = customService.getScoringSkillDelivery(provider);
          expect(pass.skillNames).toEqual(['custom-core']);
          expect(scoring.skillNames).toEqual(['custom-core']);
          if (provider === 'claude') {
            expect(pass.skillCommand).toBe(`/${path.basename(root)}:custom-core`);
            expect(scoring.skillCommand).toBe(pass.skillCommand);
          } else {
            expect(pass.prompt).toContain('Custom methodology');
            expect(scoring.inlineSkills[0].body).toBe('Custom methodology');
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      });
    });

    describe('custom skill delivery', () => {
      let fixtureDir: string;
      let pluginDir: string;
      const candidate: ReviewFinding = {
        title: 'Bug',
        body: 'Evidence',
        confidence: 80,
        path: 'src/a.ts',
        lineType: 'new',
      };

      beforeEach(async () => {
        fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-custom-delivery-'));
        // Replacement strings must not interpret the dollar sign in a configured path.
        pluginDir = path.join(fixtureDir, 'plugin $& resources');
        await fs.mkdir(path.join(pluginDir, '.claude-plugin'), { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'custom-review' })
        );
      });

      afterEach(async () => {
        await fs.rm(fixtureDir, { recursive: true, force: true });
      });

      async function writeSkill(
        name: string,
        invocable?: boolean | string,
        body = `${name} methodology`
      ): Promise<void> {
        const dir = path.join(pluginDir, 'skills', name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'SKILL.md'),
          [
            '---',
            `name: ${name}`,
            ...(invocable === undefined ? [] : [`user-invocable: ${invocable}`]),
            'metadata:',
            '  review-always: "true"',
            '---',
            body,
          ].join('\n')
        );
      }

      describe.each(['claude', 'codex'] as const)('%s', provider => {
        it.each([
          { core: false, specialized: false, primary: undefined },
          { core: 'false # Internal methodology only', specialized: false, primary: undefined },
          { core: false, specialized: true, primary: 'specialized' },
          { core: undefined, specialized: false, primary: 'core' },
        ])('delivers every skill once with eligibility %j', async eligibility => {
          await writeSkill('core', eligibility.core);
          await writeSkill('specialized', eligibility.specialized);
          const customService = new GitLabReviewService(
            {} as GitLabService,
            undefined,
            new ReviewSkillCatalog(pluginDir)
          );
          const scoring = customService.getScoringSkillDelivery(provider);
          const stages = [
            ...customService.buildReviewPasses(context, undefined, undefined, provider),
            {
              ...scoring,
              prompt: customService.buildScoringPrompt(
                context,
                candidate,
                undefined,
                undefined,
                scoring.inlineSkills
              ),
            },
          ];
          const primary = provider === 'claude' ? eligibility.primary : undefined;
          for (const stage of stages) {
            expect(stage.skillCommand).toBe(primary ? `/custom-review:${primary}` : undefined);
            expect(stage.skillNames).toEqual(['core', 'specialized']);
            for (const name of stage.skillNames) {
              const expectedInlineCount = name === primary ? 0 : 1;
              expect(stage.prompt.split(`<skill name="${name}">`).length - 1).toBe(
                expectedInlineCount
              );
              expect(stage.prompt.split(`${name} methodology`).length - 1).toBe(
                expectedInlineCount
              );
            }
          }
          expect(scoring.inlineSkills.map(skill => skill.name)).toEqual(
            ['core', 'specialized'].filter(name => name !== primary)
          );
        });

        it('binds inline resources to each skill directory in passes and scoring', async () => {
          for (const name of ['core', 'first', 'second']) {
            await writeSkill(
              name,
              undefined,
              'Read ${CLAUDE_SKILL_DIR}/references/rules.md and ' +
                '${CLAUDE_PLUGIN_ROOT}/shared/rules.md. Also read references/extra.md.'
            );
          }
          const catalog = new ReviewSkillCatalog(pluginDir);
          const originalBodies = catalog.listSkills().map(skill => skill.body);
          const customService = new GitLabReviewService({} as GitLabService, undefined, catalog);
          const scoring = customService.getScoringSkillDelivery(provider);
          const prompts = [
            ...customService
              .buildReviewPasses(context, undefined, undefined, provider)
              .map(pass => pass.prompt),
            customService.buildScoringPrompt(
              context,
              candidate,
              undefined,
              undefined,
              scoring.inlineSkills
            ),
          ];
          for (const prompt of prompts) {
            expect(prompt).not.toContain('${CLAUDE_SKILL_DIR}');
            expect(prompt).not.toContain('${CLAUDE_PLUGIN_ROOT}');
            for (const name of provider === 'claude'
              ? ['first', 'second']
              : ['core', 'first', 'second']) {
              const skillDir = path.join(pluginDir, 'skills', name);
              expect(prompt).toContain(`Base directory for this skill: ${skillDir}`);
              expect(prompt.split(`${skillDir}/references/rules.md`).length - 1).toBe(1);
            }
            expect(prompt).toContain(`${pluginDir}/shared/rules.md`);
          }
          expect(catalog.listSkills().map(skill => skill.body)).toEqual(originalBodies);
        });
      });
    });

    it('should create multiple review passes and include user focus', () => {
      const passes = service.buildReviewPasses(context, 'focus on auth');

      expect(passes).toHaveLength(4);
      expect(passes[0]?.prompt).toContain('focus on auth');
    });

    it('expands the core skill via slash command for Claude and inlines the rest', () => {
      const claudePasses = service.buildReviewPasses(context, undefined, undefined, 'claude');
      const bugScan = claudePasses.find(pass => pass.id === 'bug-scan');
      const history = claudePasses.find(pass => pass.id === 'history-context');

      // Core methodology is always first; TypeScript notes match the .ts diff on bug-scan.
      expect(bugScan?.skillNames[0]).toBe('mr-review-core');
      expect(bugScan?.skillNames).toContain('typescript-review');
      expect(bugScan?.skillNames).toContain('security-review');
      expect(bugScan?.skillNames).not.toContain('go-review');
      expect(history?.skillNames).toContain('typescript-review');
      expect(history?.skillNames).not.toContain('security-review');

      // The SDK expands only the first slash command of a prompt, so the core skill takes that
      // slot and the other matched skills travel as inline text.
      expect(bugScan?.skillCommand).toBe('/gitlab-review:mr-review-core');
      expect(bugScan?.prompt).not.toContain('<skill name="mr-review-core">');
      expect(bugScan?.prompt).toContain('<skill name="typescript-review">');
      expect(bugScan?.prompt).toContain('<skill name="security-review">');
      expect(bugScan?.prompt).not.toMatch(/^\//);

      const codexPasses = service.buildReviewPasses(context, undefined, undefined, 'codex');
      const codexBugScan = codexPasses.find(pass => pass.id === 'bug-scan');
      expect(codexBugScan?.skillCommand).toBeUndefined();
      expect(codexBugScan?.prompt).toContain('<skill name="mr-review-core">');
      expect(codexBugScan?.prompt).toContain('<skill name="typescript-review">');
      expect(codexBugScan?.prompt).toContain('# Merge request review methodology');
    });

    it('exposes the always-on skills for the scoring stage', () => {
      const claudeDelivery = service.getScoringSkillDelivery('claude');
      expect(claudeDelivery.skillNames).toEqual(['mr-review-core']);
      expect(claudeDelivery.skillCommand).toBe('/gitlab-review:mr-review-core');
      expect(claudeDelivery.inlineSkills).toEqual([]);

      const codexDelivery = service.getScoringSkillDelivery('codex');
      expect(codexDelivery.skillCommand).toBeUndefined();
      expect(codexDelivery.inlineSkills.map(skill => skill.name)).toEqual(['mr-review-core']);

      const scoringPrompt = service.buildScoringPrompt(
        context,
        {
          title: 'Bug',
          body: 'Body',
          confidence: 70,
          path: 'src/a.ts',
          line: 3,
          lineType: 'new',
        },
        undefined,
        undefined,
        codexDelivery.inlineSkills
      );
      expect(scoringPrompt).toContain('<skill name="mr-review-core">');
      expect(scoringPrompt).toContain('Verification is adversarial');
    });

    it('lets admin skills pin extra on-disk skills by name', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-service-pin-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.createSkill({
        name: 'Go everywhere',
        provider: 'claude',
        promptIds: ['bug-scan'],
        systemInstructions: 'Also apply Go notes.',
        skillNames: ['go-review', 'does-not-exist'],
      });

      const customService = new GitLabReviewService({} as any, customization);
      const bugScan = customService
        .buildReviewPasses(context, undefined, undefined, 'claude')
        .find(pass => pass.id === 'bug-scan');

      expect(bugScan?.skillNames).toContain('go-review');
      expect(bugScan?.skillNames).not.toContain('does-not-exist');
      // Pinned skills are not the primary skill, so they are delivered inline.
      expect(bugScan?.skillCommand).toBe('/gitlab-review:mr-review-core');
      expect(bugScan?.prompt).toContain('<skill name="go-review">');
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
          body: 'Pass {{reviewPassLabel}} budget {{timeoutMinutes}}/{{softDeadlineMinutes}}/{{wrapUpMinutes}}.',
        },
      });
      await customization.publishPromptTemplate('review.pass.template', 'Custom pass budget');

      const customService = new GitLabReviewService({} as any, customization);
      const passes = (customService as any).buildReviewPasses(context, undefined, {
        timeoutMinutes: 13,
        softDeadlineMinutes: 10,
        wrapUpMinutes: 2,
      });

      expect(passes[0]?.prompt).toContain('Pass CLAUDE.md compliance budget 13/10/2.');
    });

    it('keeps the static-inspection policy when disabled pass and scoring templates use built-in fallbacks', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-template-fallback-'));
      const customization = new ReviewCustomizationService({ dataDir });
      await customization.initialize();
      await customization.updatePromptTemplate('review.pass.template', { enabled: false });
      await customization.updatePromptTemplate('review.scoring.template', { enabled: false });

      const customService = new GitLabReviewService({} as any, customization);
      const passPrompt = customService.buildReviewPasses(context)[0]?.prompt;
      const scoringPrompt = customService.buildScoringPrompt(context, {
        title: 'Potential regression',
        body: 'The change may break retry handling.',
        confidence: 80,
        path: 'src/a.ts',
        line: 10,
        lineType: 'new',
      });
      const staticInspectionPolicy =
        'Do not run build, compile, test, lint, or format commands unless the user explicitly requests that validation. If explicitly requested validation fails, record the result and continue with static inspection.';

      expect(passPrompt).toContain(staticInspectionPolicy);
      expect(scoringPrompt).toContain(staticInspectionPolicy);
    });
  });

  describe('inline skills in published review templates', () => {
    const dataDirs: string[] = [];
    const candidate: ReviewFinding = {
      title: 'Potential regression',
      body: 'A concrete state transition can fail.',
      confidence: 80,
      path: 'src/a.ts',
      line: 10,
      lineType: 'new',
    };
    const languageInstruction = '请使用简体中文撰写所有审查结论。';
    const modes = [
      'legacy',
      'default',
      'inline',
      'full-prompt',
      'combined',
      'combined-prompt-first',
      'repeated-inline',
      'disabled',
      'skills-off',
      'inline-skills-off',
    ] as const;

    afterEach(async () => {
      jest.restoreAllMocks();
      await Promise.all(dataDirs.splice(0).map(dataDir => fs.rm(dataDir, { recursive: true })));
    });

    describe.each(['claude', 'codex'] as const)('%s', provider => {
      it.each(modes)(
        'delivers skills once with %s templates without changing publication',
        async mode => {
          const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-inline-templates-'));
          dataDirs.push(dataDir);
          const customization = new ReviewCustomizationService({ dataDir });
          await customization.initialize();
          const skillsEnabled = !mode.endsWith('skills-off');

          for (const [id, fullPromptVariable] of [
            ['review.pass.template', 'reviewPassPrompt'],
            ['review.scoring.template', 'reviewScoringPrompt'],
          ]) {
            if (mode === 'default') {
              continue;
            }
            const defaultBody = customization.getPromptTemplate(id).versions[0]!.body;
            let body = defaultBody.replace('{{inlineSkillsBlock}}', '');
            if (mode === 'inline' || mode === 'inline-skills-off') {
              body = 'Before skills\n{{ inlineSkillsBlock }}\nAfter skills';
            } else if (mode === 'full-prompt') {
              body = `Before prompt\n{{${fullPromptVariable}}}\nAfter prompt`;
            } else if (mode === 'combined') {
              body = `Before skills\n{{inlineSkillsBlock}}\nAfter skills\n{{${fullPromptVariable}}}`;
            } else if (mode === 'combined-prompt-first') {
              body = `Before prompt\n{{${fullPromptVariable}}}\nAfter prompt\n{{inlineSkillsBlock}}`;
            } else if (mode === 'repeated-inline') {
              body = 'Before skills\n{{inlineSkillsBlock}}\nAfter skills\n{{inlineSkillsBlock}}';
            }
            await customization.updatePromptTemplate(id, {
              draft: { body: `${body}\n${languageInstruction}` },
            });
            await customization.publishPromptTemplate(id, 'Custom language v2');
            if (mode === 'disabled') {
              await customization.updatePromptTemplate(id, { enabled: false });
            }
          }

          const publishedTemplates = customization.listPromptTemplates();
          const templateFile = path.join(dataDir, 'prompt-templates.json');
          const storedTemplates = await fs.readFile(templateFile, 'utf8');
          const reloaded = new ReviewCustomizationService({ dataDir });
          await reloaded.initialize();

          if (!skillsEnabled) {
            const config = runtimeConfigService.getConfig();
            jest.spyOn(runtimeConfigService, 'getConfig').mockReturnValue({
              ...config,
              review: { ...config.review, useBuiltinSkills: false },
            });
          }

          const customService = new GitLabReviewService({} as any, reloaded);
          const pass = customService
            .buildReviewPasses(context, undefined, undefined, provider)
            .find(item => item.id === 'bug-scan')!;
          const scoringDelivery = customService.getScoringSkillDelivery(provider);
          const scoringPrompt = customService.buildScoringPrompt(
            context,
            candidate,
            undefined,
            undefined,
            scoringDelivery.inlineSkills
          );
          const expectedPassSkills = !skillsEnabled
            ? []
            : provider === 'claude'
              ? ['security-review', 'silent-failure-review', 'typescript-review']
              : ['mr-review-core', 'security-review', 'silent-failure-review', 'typescript-review'];
          for (const [skillName, heading] of Object.entries({
            'mr-review-core': '# Merge request review methodology',
            'security-review': '# Security review of a merge request',
            'silent-failure-review': '# Silent failure review',
            'typescript-review': '# TypeScript and JavaScript review notes',
          })) {
            const marker = `<skill name="${skillName}">`;
            const scoringCount =
              skillsEnabled && provider === 'codex' && skillName === 'mr-review-core' ? 1 : 0;
            const passCount = expectedPassSkills.includes(skillName) ? 1 : 0;
            expect(scoringPrompt.split(marker).length - 1).toBe(scoringCount);
            expect(scoringPrompt.split(heading).length - 1).toBe(scoringCount);
            expect(pass.prompt.split(marker).length - 1).toBe(passCount);
            expect(pass.prompt.split(heading).length - 1).toBe(passCount);
          }
          const expectedCommand =
            skillsEnabled && provider === 'claude' ? '/gitlab-review:mr-review-core' : undefined;
          expect(pass.skillCommand).toBe(expectedCommand);
          expect(scoringDelivery.skillCommand).toBe(expectedCommand);
          expect(pass.skillNames).toEqual(
            !skillsEnabled
              ? []
              : ['mr-review-core', 'security-review', 'silent-failure-review', 'typescript-review']
          );

          for (const prompt of [pass.prompt, scoringPrompt]) {
            if (mode === 'disabled' || mode === 'default') {
              expect(prompt).not.toContain(languageInstruction);
            } else {
              expect(prompt).toContain(languageInstruction);
            }
            if (
              ['inline', 'combined', 'repeated-inline'].includes(mode) &&
              prompt.includes('<skill name=')
            ) {
              expect(prompt.indexOf('Before skills')).toBeLessThan(prompt.indexOf('<skill name='));
              expect(prompt.indexOf('</skill>')).toBeLessThan(prompt.indexOf('After skills'));
            }
            if (
              ['full-prompt', 'combined-prompt-first'].includes(mode) &&
              prompt.includes('<skill name=')
            ) {
              expect(prompt.indexOf('Before prompt')).toBeLessThan(prompt.indexOf('<skill name='));
              expect(prompt.indexOf('</skill>')).toBeLessThan(prompt.indexOf('After prompt'));
            }
            if (mode === 'legacy' && prompt.includes('<skill name=')) {
              expect(prompt.indexOf(languageInstruction)).toBeLessThan(
                prompt.indexOf('<skill name=')
              );
            }
          }
          if (mode === 'default') {
            expect(pass.prompt.indexOf('</skill>')).toBeLessThan(
              pass.prompt.indexOf('Do not modify files')
            );
            if (provider === 'codex') {
              expect(scoringPrompt.indexOf('</skill>')).toBeLessThan(
                scoringPrompt.indexOf('Use this rubric verbatim:')
              );
            }
          }
          for (const id of ['review.pass.template', 'review.scoring.template']) {
            const published = reloaded.getPromptTemplate(id);
            expect(published.currentVersion).toBe(mode === 'default' ? 1 : 2);
            expect(published.versions).toHaveLength(mode === 'default' ? 1 : 2);
          }
          expect(reloaded.listPromptTemplates()).toEqual(publishedTemplates);
          expect(await fs.readFile(templateFile, 'utf8')).toBe(storedTemplates);
        }
      );
    });
  });

  describe('parseReviewOutput', () => {
    it('parses raw JSON before looking for code fences inside finding text', () => {
      const payload = {
        summary: 'Code sample',
        findings: [
          {
            title: 'Bug',
            body: 'The sample ```json {"bad":true} ``` fails.',
            confidence: 0,
            path: 'src/old.ts',
            line: 7,
            line_type: 'old',
            old_path: 'src/old.ts',
            new_path: 'src/new.ts',
          },
        ],
      };
      const result = service.parseReviewOutput(JSON.stringify(payload), 0);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        body: payload.findings[0].body,
        confidence: 0,
        line: 7,
        lineType: 'old',
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
      });
    });

    it.each([
      '',
      'Review complete',
      '{',
      'null',
      '[]',
      '{}',
      '{"summary":"ok","findings":{}}',
      '{"summary":"ok","findings":[{}]}',
      '{"findings":[]}',
      JSON.stringify({
        summary: 'ok',
        findings: [{ title: 'Bug', body: 'Body', path: 'a.ts', confidence: null }],
      }),
      JSON.stringify({
        summary: 'ok',
        findings: [{ title: 'Bug', body: 'Body', path: 'a.ts', confidence: 101 }],
      }),
    ])('rejects invalid machine pass output in strict mode: %s', output => {
      expect(() => Reflect.apply(service.parseReviewOutput, service, [output, 0, true])).toThrow(
        /review/i
      );
    });

    it('preserves tolerant parsing of JSON fences surrounded by explanatory prose', () => {
      const output = 'Review result:\n```json\n{"summary":"Checked", "findings":[]}\n```\nDone.';
      expect(service.parseReviewOutput(output)).toEqual({ summary: 'Checked', findings: [] });
    });

    it.each(['json', ''])(
      'accepts a prose-wrapped %s fence in strict mode, including inner fences',
      language => {
        const finding = {
          title: 'Bug',
          body: 'The example ```json {"sample":true} ``` fails.',
          confidence: 90,
          path: 'src/a.ts',
          line: 12,
          line_type: 'old',
        };
        const output =
          'Review result:\n```' +
          language +
          '\n' +
          JSON.stringify({ summary: 'Checked', findings: [finding] }) +
          '\n```\nDone.';
        expect(service.parseReviewOutput(output, 0, true)).toMatchObject({
          summary: 'Checked',
          findings: [{ body: finding.body, path: 'src/a.ts', lineType: 'old' }],
        });
      }
    );

    it.each(['./', '.\\', ' ./ '])(
      'rejects a finding that cannot normalize in strict pass mode: %s',
      path => {
        const output = JSON.stringify({
          summary: 'Checked',
          findings: [{ title: 'Bug', body: 'Evidence', confidence: 90, path }],
        });
        expect(() => service.parseReviewOutput(output, 0, true)).toThrow(/review/i);
        expect(service.parseReviewOutput(output, 0)).toMatchObject({ findings: [] });
      }
    );

    it('rejects an unnormalizable finding even when a valid finding survives and its score is below threshold', () => {
      const valid = { title: 'Bug', body: 'Evidence', confidence: 90, path: 'src/a.ts' };
      const output = JSON.stringify({
        summary: 'Checked',
        findings: [valid, { ...valid, path: './', confidence: 0 }],
      });
      expect(() => service.parseReviewOutput(output, 80, true)).toThrow(/review/i);
    });

    it('keeps tolerant parser compatibility for invalid output', () => {
      expect(service.parseReviewOutput('not JSON')).toEqual({
        summary: 'Review completed.',
        findings: [],
      });
    });

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
          body: 'Score {{candidateTitle}} with budget {{timeoutMinutes}}/{{softDeadlineMinutes}}/{{wrapUpMinutes}}.',
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
    it.each([
      '',
      'No issues',
      '{',
      '{}',
      '[]',
      'null',
      '{"title":"Bug","body":"Body","path":"a.ts","confidence":"0"}',
      '{"title":"Bug","body":"Body","path":"a.ts","confidence":0,"line_type":"invalid"}',
    ])('rejects invalid machine scoring output in strict mode: %s', output => {
      expect(() =>
        Reflect.apply(service.parseScoredFinding, service, [output, {} as ReviewFinding, true])
      ).toThrow(/review/i);
    });

    it('accepts a legitimate zero score and preserves old/new line metadata', () => {
      const payload = {
        title: 'Rejected concern',
        body: 'Already guarded',
        path: 'src/old.ts',
        confidence: 0,
        line: 5,
        line_type: 'old',
        old_path: 'src/old.ts',
        new_path: 'src/new.ts',
        verdict: 'False positive',
      };
      const scored = Reflect.apply(service.parseScoredFinding, service, [
        JSON.stringify(payload),
        { sources: ['Bug scan'] } as ReviewFinding,
        true,
      ]);
      expect(scored).toMatchObject({
        confidence: 0,
        line: 5,
        lineType: 'old',
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
        sources: ['Bug scan'],
      });
    });

    it.each(['json', ''])(
      'accepts a prose-wrapped %s scorer fence in strict mode, including inner fences',
      language => {
        const finding = {
          title: 'Rejected concern',
          body: 'The example ```json {"sample":true} ``` is guarded.',
          confidence: 0,
          path: 'src/a.ts',
          line: 12,
          line_type: 'old',
          verdict: 'Guarded',
        };
        const output =
          'Scoring result:\n```' + language + '\n' + JSON.stringify(finding) + '\n```\nDone.';
        expect(
          service.parseScoredFinding(output, { sources: ['Pass 1'] } as ReviewFinding, true)
        ).toMatchObject({
          confidence: 0,
          body: finding.body,
          path: 'src/a.ts',
          lineType: 'old',
          sources: ['Pass 1'],
        });
      }
    );

    it.each(['./', '.\\', ' ./ '])(
      'rejects a finding that cannot normalize in strict scoring mode: %s',
      path => {
        const output = JSON.stringify({ title: 'Bug', body: 'Evidence', confidence: 90, path });
        const fallback = {
          title: 'Candidate',
          body: 'Candidate body',
          confidence: 40,
          path: 'src/a.ts',
          lineType: 'new' as const,
        };
        expect(() => service.parseScoredFinding(output, fallback, true)).toThrow(/review/i);
        expect(service.parseScoredFinding(output, fallback)).toBeNull();
      }
    );

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

import path from 'path';
import { randomUUID } from 'crypto';
import { JsonStore } from '../storage/jsonStore';
import {
  CreateReviewPromptInput,
  PromptTemplate,
  PromptTemplateDraft,
  PromptTemplatePatch,
  PromptTemplateProvider,
  PromptTemplateScope,
  PromptTemplateVersion,
  PromptOptimizationProposal,
  PublishedReviewPassTemplate,
  ReviewFeedback,
  ReviewFeedbackInput,
  ReviewPrompt,
  ReviewPromptDraft,
  ReviewPromptPatch,
  ReviewPromptProvider,
  ReviewPromptVersion,
  ReviewSkill,
  ReviewSkillInput,
  ReviewSkillMatchContext,
} from './reviewCustomizationTypes';

export interface ReviewCustomizationServiceOptions {
  dataDir?: string;
}

const VALID_PROVIDERS: ReviewPromptProvider[] = ['claude', 'codex', 'coderabbit', 'any'];
const VALID_PROMPT_TEMPLATE_PROVIDERS: PromptTemplateProvider[] = [
  'claude',
  'codex',
  'review',
  'shared',
];
const VALID_PROMPT_TEMPLATE_SCOPES: PromptTemplateScope[] = [
  'edit',
  'review',
  'context',
  'fallback',
  'pass',
  'scoring',
];
const VALID_FEEDBACK_LABELS: ReviewFeedback['label'][] = [
  'useful',
  'false_positive',
  'missed_issue',
  'unclear',
  'accepted',
  'rejected',
];
const VALID_FEEDBACK_SOURCES: ReviewFeedback['source'][] = [
  'admin',
  'gitlab-comment',
  'gitlab-resolution',
];

const DEFAULT_REVIEW_PROMPTS: Array<{
  id: string;
  label: string;
  description: string;
  focus: string[];
}> = [
  {
    id: 'claude-guidelines',
    label: 'CLAUDE.md compliance',
    description: 'Audit the merge request against relevant CLAUDE.md guidance.',
    focus: [
      'Audit the merge request against relevant CLAUDE.md guidance.',
      'Only flag issues that are explicitly required by an applicable CLAUDE.md file.',
      'Ignore guidance that is clearly only for code generation and not relevant to review.',
    ],
  },
  {
    id: 'bug-scan',
    label: 'Shallow bug scan',
    description: 'Read changed files and scan for obvious correctness issues.',
    focus: [
      'Read only the merge request changes and do a shallow scan for obvious bugs.',
      'Focus on high-impact correctness issues introduced by the changes.',
      'Do not expand into broad architecture feedback or speculative risks.',
    ],
  },
  {
    id: 'history-context',
    label: 'History and blame context',
    description: 'Use git history to validate likely regressions.',
    focus: [
      'Use git blame, git log, and nearby history to validate whether the change introduces a real regression.',
      'Prefer issues where historical context makes the bug more likely or confirms an existing contract.',
      'Ignore pre-existing issues unless this merge request makes them worse.',
    ],
  },
  {
    id: 'comments-and-contracts',
    label: 'Comments and local contracts',
    description: 'Check touched files against comments, assertions, and local contracts.',
    focus: [
      'Check comments, docblocks, nearby assertions, and naming/contracts in the touched files.',
      'Flag cases where the merge request violates a documented local invariant or explicit comment.',
      'Ignore generic style nits that are not tied to a concrete contract.',
    ],
  },
];

const DEFAULT_PROMPT_TEMPLATES: Array<{
  id: string;
  label: string;
  description: string;
  provider: PromptTemplateProvider;
  scope: PromptTemplateScope;
  body: string;
}> = [
  {
    id: 'claude.edit.system',
    label: 'Claude edit system prompt',
    description: 'System prompt append used by Claude ordinary edit tasks.',
    provider: 'claude',
    scope: 'edit',
    body:
      'You are working in an automated webhook environment. Make code changes directly without asking for permissions. For merge request contexts, use git commands to examine code changes when needed. If an optional build, test, lint, compile, or validation command fails for any reason, record that verification result and continue with repository inspection instead of stopping solely because of that command failure. Focus on implementing requested changes efficiently and provide a clear summary of what was modified.',
  },
  {
    id: 'claude.review.system',
    label: 'Claude review system prompt',
    description: 'System prompt append used by Claude read-only review tasks.',
    provider: 'claude',
    scope: 'review',
    body:
      'You are working in an automated webhook environment in read-only review mode. Do not modify files or git state. Do not use Task, Agent, WebFetch, or WebSearch. Use only local repository inspection tools such as Bash, Read, Glob, and Grep. For merge request contexts, use git commands to inspect changes, history, and blame when needed. If any build, test, lint, compile, or validation command fails for any reason, record that verification result and continue the code review with static repository inspection. Do not stop solely because a command failed. Return a concise, structured review result.',
  },
  {
    id: 'claude.context.wrapper',
    label: 'Claude request wrapper',
    description: 'Prompt wrapper that combines context, MR hints, execution mode, and request text for Claude.',
    provider: 'claude',
    scope: 'context',
    body: '{{contextBlock}}{{mrAnalysisBlock}}{{modeBlock}}**Request:** {{command}}',
  },
  {
    id: 'claude.review.fallback',
    label: 'Claude static review fallback',
    description: 'Fallback request used when a validation command fails before review findings are produced.',
    provider: 'claude',
    scope: 'fallback',
    body: [
      'Continue the merge request review after a build, test, lint, compile, or validation command failed before the review produced findings.',
      '',
      'Original request: {{originalCommand}}',
      '',
      'Previous validation output:',
      '```text',
      '{{previousOutput}}',
      '```',
      '',
      'Treat the failed command as a verification result, not as the end of the review.',
      'Do not rerun the same failing command.',
      'Continue with static repository inspection using git diff, git log, Read, Glob, Grep, and narrowly scoped Bash commands that are safe and available.',
      'Clearly state which validation failed or could not run, then provide the best review findings you can support from static inspection.',
    ].join('\n'),
  },
  {
    id: 'codex.edit.instructions',
    label: 'Codex edit instructions',
    description: 'Instruction block used by Codex ordinary edit tasks.',
    provider: 'codex',
    scope: 'edit',
    body:
      'You are working in an automated webhook environment. Make code changes directly and provide a clear summary of what was modified. Focus on implementing requested changes efficiently. Do not perform broad searches or extensive exploration unless absolutely necessary.',
  },
  {
    id: 'codex.review.instructions',
    label: 'Codex review instructions',
    description: 'Instruction block used by Codex read-only review tasks.',
    provider: 'codex',
    scope: 'review',
    body:
      'You are working in an automated webhook environment in read-only review mode. Do not modify files or git state. Focus on identifying real issues in the merge request and return a structured review result.',
  },
  {
    id: 'codex.context.wrapper',
    label: 'Codex request wrapper',
    description: 'Prompt wrapper that combines context, MR hints, mode instructions, and request text for Codex.',
    provider: 'codex',
    scope: 'context',
    body: '{{contextBlock}}{{mrAnalysisBlock}}{{instructionsBlock}}\n**Request:** {{command}}',
  },
  {
    id: 'review.pass.template',
    label: 'Review pass shell',
    description: 'Prompt shell wrapped around each published multipass review prompt.',
    provider: 'review',
    scope: 'pass',
    body: [
      'Provide a GitLab merge request code review.',
      '',
      'Review pass: {{reviewPassLabel}}',
      '{{reviewPassFocus}}',
      '{{adminPromptInstructionsBlock}}{{adminSkillInstructionsBlock}}Do not modify files, commit, or change git state.',
      'Do not use Task, Agent, WebFetch, or WebSearch.',
      'Use only local repository inspection tools and keep exploration narrow.',
      'Review only issues introduced or made worse by this merge request.',
      'Ignore formatting, lint, type errors, missing imports, tests, or other CI/build output.',
      'Prefer fewer, high-signal issues instead of broad feedback.',
      '',
      'Merge request: {{mergeRequestUrl}}',
      'Title: {{mergeRequestTitle}}',
      'Source branch: {{sourceBranch}}',
      'Target branch: {{targetBranch}}',
      '',
      'Changed files:',
      '{{changedFiles}}',
      '',
      'Relevant CLAUDE.md files:',
      '{{guidelineFiles}}',
      '{{userFocusBlock}}',
      '',
      "Use local git commands like 'git diff origin/{{targetBranch}}...HEAD -- <file>', 'git blame', and 'git log' when needed.",
      '',
      'Return ONLY a JSON code block in this exact shape:',
      '```json',
      '{',
      '  "summary": "Short pass summary",',
      '  "findings": [',
      '    {',
      '      "title": "Brief issue title",',
      '      "body": "Why this issue is real and how the merge request causes it.",',
      '      "confidence": 0,',
      '      "path": "src/file.ts",',
      '      "line": 42,',
      '      "line_type": "new",',
      '      "category": "bug",',
      '      "old_path": "src/file.ts",',
      '      "new_path": "src/file.ts"',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      'Rules for findings:',
      '- Maximum 5 findings.',
      '- Score confidence from 0-100 based on how likely the issue is real.',
      '- Include only issues on lines modified by this merge request.',
      '- If there are no worthwhile issues, return an empty findings array.',
    ].join('\n'),
  },
  {
    id: 'review.scoring.template',
    label: 'Review scoring shell',
    description: 'Prompt shell used to score candidate review findings.',
    provider: 'review',
    scope: 'scoring',
    body: [
      'Score whether this GitLab merge request review finding is real.',
      '',
      'You are performing the confidence-scoring stage of a multi-pass code review.',
      'Verify the finding against the merge request diff, relevant CLAUDE.md files, and git history as needed.',
      'Do not use Task, Agent, WebFetch, or WebSearch. Use only local repository inspection tools.',
      'Only score issues introduced or made worse by this merge request.',
      'If this is a CLAUDE.md-related issue, confirm that an applicable CLAUDE.md explicitly calls it out.',
      'Ignore lint, formatting, type errors, imports, and test failures that CI would catch separately.',
      '',
      'Merge request: {{mergeRequestUrl}}',
      'Source branch: {{sourceBranch}}',
      'Target branch: {{targetBranch}}',
      'Candidate issue title: {{candidateTitle}}',
      'Candidate path: {{candidatePath}}',
      'Candidate line: {{candidateLine}} ({{candidateLineType}})',
      'Candidate category: {{candidateCategory}}',
      'Candidate reviewers: {{candidateSources}}',
      '{{userFocusBlock}}',
      '',
      'Candidate rationale:',
      '{{candidateBody}}',
      '',
      'Use this rubric verbatim:',
      '0: Not confident at all. This is a false positive that does not stand up to light scrutiny, or is a pre-existing issue.',
      '25: Somewhat confident. This might be a real issue, but may also be a false positive. The issue was not verified.',
      '50: Moderately confident. This is a real issue, but it may be minor, infrequent, or not very important.',
      '75: Highly confident. This is very likely a real and important issue, or is directly required by the relevant CLAUDE.md.',
      '100: Absolutely certain. The evidence directly confirms the issue and it is definitely real.',
      '',
      'Return ONLY a JSON code block in this exact shape:',
      '```json',
      '{',
      '  "title": "Brief issue title",',
      '  "body": "Concise explanation of the verified issue.",',
      '  "confidence": 0,',
      '  "path": "src/file.ts",',
      '  "line": 42,',
      '  "line_type": "new",',
      '  "category": "bug",',
      '  "old_path": "src/file.ts",',
      '  "new_path": "src/file.ts",',
      '  "verdict": "Short note explaining why the score was assigned."',
      '}',
      '```',
    ].join('\n'),
  },
];

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || randomUUID();
}

function uniqueStrings(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${fieldName} must be an array of strings`);
  }

  return Array.from(new Set(value.map(item => item.trim()).filter(Boolean)));
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function optionalString(value: unknown, fieldName: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.trim();
}

function providerValue(value: unknown, fieldName: string): ReviewPromptProvider {
  const provider = value || 'any';
  if (!VALID_PROVIDERS.includes(provider as ReviewPromptProvider)) {
    throw new Error(`${fieldName} must be one of: claude, codex, coderabbit, any`);
  }

  return provider as ReviewPromptProvider;
}

function promptTemplateProviderValue(value: unknown, fieldName: string): PromptTemplateProvider {
  const provider = value || 'shared';
  if (!VALID_PROMPT_TEMPLATE_PROVIDERS.includes(provider as PromptTemplateProvider)) {
    throw new Error(`${fieldName} must be one of: claude, codex, review, shared`);
  }

  return provider as PromptTemplateProvider;
}

function promptTemplateScopeValue(value: unknown, fieldName: string): PromptTemplateScope {
  const scope = value || 'context';
  if (!VALID_PROMPT_TEMPLATE_SCOPES.includes(scope as PromptTemplateScope)) {
    throw new Error(`${fieldName} must be one of: edit, review, context, fallback, pass, scoring`);
  }

  return scope as PromptTemplateScope;
}

function createDefaultPrompt(definition: (typeof DEFAULT_REVIEW_PROMPTS)[number]): ReviewPrompt {
  const createdAt = now();
  const draft: ReviewPromptDraft = {
    focus: [...definition.focus],
    systemInstructions: '',
  };
  const version: ReviewPromptVersion = {
    ...draft,
    version: 1,
    createdAt,
    createdBy: 'system',
    changelog: 'Initial default prompt',
  };

  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    enabled: true,
    provider: 'any',
    currentVersion: 1,
    draft,
    versions: [version],
    createdAt,
    updatedAt: createdAt,
  };
}

function createDefaultPromptTemplate(
  definition: (typeof DEFAULT_PROMPT_TEMPLATES)[number]
): PromptTemplate {
  const createdAt = now();
  const draft: PromptTemplateDraft = {
    body: definition.body,
  };
  const version: PromptTemplateVersion = {
    ...draft,
    version: 1,
    createdAt,
    createdBy: 'system',
    changelog: 'Initial default prompt template',
  };

  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    enabled: true,
    provider: definition.provider,
    scope: definition.scope,
    currentVersion: 1,
    draft,
    versions: [version],
    defaultBody: definition.body,
    createdAt,
    updatedAt: createdAt,
  };
}

export class ReviewCustomizationService {
  private readonly promptTemplateStore: JsonStore<PromptTemplate[]>;
  private readonly promptStore: JsonStore<ReviewPrompt[]>;
  private readonly skillStore: JsonStore<ReviewSkill[]>;
  private readonly feedbackStore: JsonStore<ReviewFeedback[]>;
  private readonly proposalStore: JsonStore<PromptOptimizationProposal[]>;
  private promptTemplates: PromptTemplate[] = [];
  private prompts: ReviewPrompt[] = [];
  private skills: ReviewSkill[] = [];
  private feedback: ReviewFeedback[] = [];
  private proposals: PromptOptimizationProposal[] = [];
  private loaded = false;

  constructor(options: ReviewCustomizationServiceOptions = {}) {
    const dataDir = options.dataDir || process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
    this.promptTemplateStore = new JsonStore<PromptTemplate[]>(
      path.join(dataDir, 'prompt-templates.json')
    );
    this.promptStore = new JsonStore<ReviewPrompt[]>(path.join(dataDir, 'review-prompts.json'));
    this.skillStore = new JsonStore<ReviewSkill[]>(path.join(dataDir, 'review-skills.json'));
    this.feedbackStore = new JsonStore<ReviewFeedback[]>(path.join(dataDir, 'review-feedback.json'));
    this.proposalStore = new JsonStore<PromptOptimizationProposal[]>(
      path.join(dataDir, 'prompt-proposals.json')
    );
  }

  public async initialize(): Promise<void> {
    const defaultPrompts = DEFAULT_REVIEW_PROMPTS.map(createDefaultPrompt);
    const defaultPromptTemplates = DEFAULT_PROMPT_TEMPLATES.map(createDefaultPromptTemplate);
    this.promptTemplates = this.ensureDefaultPromptTemplates(
      await this.promptTemplateStore.read(defaultPromptTemplates)
    );
    this.prompts = this.ensureDefaultPrompts(await this.promptStore.read(defaultPrompts));
    this.skills = await this.skillStore.read([]);
    this.feedback = await this.feedbackStore.read([]);
    this.proposals = await this.proposalStore.read([]);
    await this.persistAll();
    this.loaded = true;
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  public listPrompts(): ReviewPrompt[] {
    return clone(this.prompts);
  }

  public getPrompt(id: string): ReviewPrompt {
    return clone(this.findPrompt(id));
  }

  public listPromptTemplates(): PromptTemplate[] {
    return clone(this.promptTemplates);
  }

  public getPromptTemplate(id: string): PromptTemplate {
    return clone(this.findPromptTemplate(id));
  }

  public async updatePromptTemplate(
    id: string,
    patch: PromptTemplatePatch
  ): Promise<PromptTemplate> {
    const template = this.findPromptTemplate(id);
    if ('label' in patch) {
      template.label = requiredString(patch.label, 'promptTemplate.label');
    }
    if ('description' in patch) {
      template.description = optionalString(patch.description, 'promptTemplate.description');
    }
    if ('enabled' in patch) {
      template.enabled = this.booleanValue(patch.enabled, 'promptTemplate.enabled');
    }
    if ('provider' in patch) {
      template.provider = promptTemplateProviderValue(patch.provider, 'promptTemplate.provider');
    }
    if ('scope' in patch) {
      template.scope = promptTemplateScopeValue(patch.scope, 'promptTemplate.scope');
    }
    if (patch.draft) {
      template.draft = this.mergePromptTemplateDraft(template.draft, patch.draft);
    }
    template.updatedAt = now();
    await this.promptTemplateStore.write(this.promptTemplates);
    return clone(template);
  }

  public async publishPromptTemplate(
    id: string,
    changelog = 'Published from admin draft'
  ): Promise<PromptTemplate> {
    const template = this.findPromptTemplate(id);
    const nextVersion = Math.max(...template.versions.map(version => version.version), 0) + 1;
    template.versions.push({
      ...clone(template.draft),
      version: nextVersion,
      createdAt: now(),
      createdBy: 'admin',
      changelog: changelog.trim() || 'Published from admin draft',
    });
    template.currentVersion = nextVersion;
    template.updatedAt = now();
    await this.promptTemplateStore.write(this.promptTemplates);
    return clone(template);
  }

  public async rollbackPromptTemplate(
    id: string,
    version: number,
    changelog = `Rollback to version ${version}`
  ): Promise<PromptTemplate> {
    const template = this.findPromptTemplate(id);
    const target = template.versions.find(item => item.version === version);
    if (!target) {
      throw new Error('prompt template version not found');
    }

    template.draft = {
      body: target.body,
    };
    return this.publishPromptTemplate(
      id,
      changelog.trim() || `Rollback to version ${version}`
    );
  }

  public renderPromptTemplate(
    id: string,
    variables: Record<string, unknown>,
    fallback: string
  ): string {
    const template = this.findPromptTemplateSafe(id);
    const version = template
      ? template.versions.find(item => item.version === template.currentVersion) ||
        template.versions[template.versions.length - 1]
      : undefined;
    const body = template?.enabled !== false && version?.body ? version.body : fallback;

    return this.renderTemplateBody(body, variables);
  }

  public async createPrompt(input: CreateReviewPromptInput): Promise<ReviewPrompt> {
    const label = requiredString(input.label, 'prompt.label');
    const id = input.id ? slugify(input.id) : slugify(label);
    if (this.prompts.some(prompt => prompt.id === id)) {
      throw new Error('prompt id already exists');
    }

    const createdAt = now();
    const draft = this.sanitizeDraft(input.draft, 'prompt.draft');
    const prompt: ReviewPrompt = {
      id,
      label,
      description: optionalString(input.description, 'prompt.description'),
      enabled: true,
      provider: providerValue(input.provider, 'prompt.provider'),
      currentVersion: 1,
      draft,
      versions: [
        {
          ...draft,
          version: 1,
          createdAt,
          createdBy: 'admin',
          changelog: 'Initial prompt',
        },
      ],
      createdAt,
      updatedAt: createdAt,
    };

    this.prompts.push(prompt);
    await this.promptStore.write(this.prompts);
    return clone(prompt);
  }

  public async updatePrompt(id: string, patch: ReviewPromptPatch): Promise<ReviewPrompt> {
    const prompt = this.findPrompt(id);
    if ('label' in patch) {
      prompt.label = requiredString(patch.label, 'prompt.label');
    }
    if ('description' in patch) {
      prompt.description = optionalString(patch.description, 'prompt.description');
    }
    if ('enabled' in patch) {
      prompt.enabled = this.booleanValue(patch.enabled, 'prompt.enabled');
    }
    if ('provider' in patch) {
      prompt.provider = providerValue(patch.provider, 'prompt.provider');
    }
    if (patch.draft) {
      prompt.draft = this.mergeDraft(prompt.draft, patch.draft);
    }
    prompt.updatedAt = now();
    await this.promptStore.write(this.prompts);
    return clone(prompt);
  }

  public async publishPrompt(id: string, changelog = 'Published from admin draft'): Promise<ReviewPrompt> {
    const prompt = this.findPrompt(id);
    const nextVersion = Math.max(...prompt.versions.map(version => version.version), 0) + 1;
    prompt.versions.push({
      ...clone(prompt.draft),
      version: nextVersion,
      createdAt: now(),
      createdBy: 'admin',
      changelog: changelog.trim() || 'Published from admin draft',
    });
    prompt.currentVersion = nextVersion;
    prompt.updatedAt = now();
    await this.promptStore.write(this.prompts);
    return clone(prompt);
  }

  public async rollbackPrompt(
    id: string,
    version: number,
    changelog = `Rollback to version ${version}`
  ): Promise<ReviewPrompt> {
    const prompt = this.findPrompt(id);
    const target = prompt.versions.find(item => item.version === version);
    if (!target) {
      throw new Error('prompt version not found');
    }

    prompt.draft = {
      focus: [...target.focus],
      systemInstructions: target.systemInstructions,
    };
    return this.publishPrompt(id, changelog.trim() || `Rollback to version ${version}`);
  }

  public getPublishedReviewPasses(): PublishedReviewPassTemplate[] {
    return this.prompts
      .filter(prompt => prompt.enabled)
      .map(prompt => {
        const version =
          prompt.versions.find(item => item.version === prompt.currentVersion) ||
          prompt.versions[prompt.versions.length - 1];
        return {
          id: prompt.id,
          label: prompt.label,
          version: version?.version || prompt.currentVersion,
          focus: [...(version?.focus || prompt.draft.focus)],
          systemInstructions: version?.systemInstructions || prompt.draft.systemInstructions,
        };
      });
  }

  public listSkills(): ReviewSkill[] {
    return clone(this.skills);
  }

  public async createSkill(input: ReviewSkillInput): Promise<ReviewSkill> {
    const name = requiredString(input.name, 'skill.name');
    const createdAt = now();
    const skill: ReviewSkill = {
      id: this.uniqueSkillId(slugify(name)),
      name,
      description: optionalString(input.description, 'skill.description'),
      enabled: input.enabled !== false,
      provider: providerValue(input.provider, 'skill.provider'),
      fileGlobs: uniqueStrings(input.fileGlobs || [], 'skill.fileGlobs'),
      languageHints: uniqueStrings(input.languageHints || [], 'skill.languageHints'),
      promptIds: uniqueStrings(input.promptIds || [], 'skill.promptIds'),
      systemInstructions: requiredString(input.systemInstructions, 'skill.systemInstructions'),
      priority: this.integerValue(input.priority ?? 0, 'skill.priority'),
      createdAt,
      updatedAt: createdAt,
    };

    this.skills.push(skill);
    await this.skillStore.write(this.skills);
    return clone(skill);
  }

  public async updateSkill(id: string, patch: Partial<ReviewSkillInput>): Promise<ReviewSkill> {
    const skill = this.findSkill(id);
    if ('name' in patch) {
      skill.name = requiredString(patch.name, 'skill.name');
    }
    if ('description' in patch) {
      skill.description = optionalString(patch.description, 'skill.description');
    }
    if ('enabled' in patch) {
      skill.enabled = this.booleanValue(patch.enabled, 'skill.enabled');
    }
    if ('provider' in patch) {
      skill.provider = providerValue(patch.provider, 'skill.provider');
    }
    if ('fileGlobs' in patch) {
      skill.fileGlobs = uniqueStrings(patch.fileGlobs || [], 'skill.fileGlobs');
    }
    if ('languageHints' in patch) {
      skill.languageHints = uniqueStrings(patch.languageHints || [], 'skill.languageHints');
    }
    if ('promptIds' in patch) {
      skill.promptIds = uniqueStrings(patch.promptIds || [], 'skill.promptIds');
    }
    if ('systemInstructions' in patch) {
      skill.systemInstructions = requiredString(
        patch.systemInstructions,
        'skill.systemInstructions'
      );
    }
    if ('priority' in patch) {
      skill.priority = this.integerValue(patch.priority ?? 0, 'skill.priority');
    }
    skill.updatedAt = now();
    await this.skillStore.write(this.skills);
    return clone(skill);
  }

  public async setSkillEnabled(id: string, enabled: boolean): Promise<ReviewSkill> {
    return this.updateSkill(id, { enabled });
  }

  public getMatchingSkills(
    context: ReviewSkillMatchContext,
    promptId: string,
    provider: Exclude<ReviewPromptProvider, 'any'> | 'claude' = 'claude'
  ): ReviewSkill[] {
    const changedFiles = context.diffs
      .flatMap(diff => [diff.new_path, diff.old_path])
      .filter((file): file is string => Boolean(file));

    return clone(
      this.skills
        .filter(skill => skill.enabled)
        .filter(skill => skill.provider === 'any' || skill.provider === provider)
        .filter(skill => skill.promptIds.length === 0 || skill.promptIds.includes(promptId))
        .filter(skill => this.matchesFiles(skill.fileGlobs, changedFiles))
        .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    );
  }

  public listFeedback(): ReviewFeedback[] {
    return clone(this.feedback);
  }

  public async createFeedback(input: ReviewFeedbackInput): Promise<ReviewFeedback> {
    const label = input.label;
    if (!VALID_FEEDBACK_LABELS.includes(label)) {
      throw new Error('feedback.label is invalid');
    }
    const source = input.source || 'admin';
    if (!VALID_FEEDBACK_SOURCES.includes(source)) {
      throw new Error('feedback.source is invalid');
    }
    if (input.promptId) {
      this.findPrompt(input.promptId);
    }

    const feedback: ReviewFeedback = {
      id: randomUUID(),
      reviewRunId: input.reviewRunId?.trim() || undefined,
      findingKey: input.findingKey?.trim() || undefined,
      promptId: input.promptId?.trim() || undefined,
      label,
      note: input.note?.trim() || '',
      source,
      createdAt: now(),
    };

    this.feedback.push(feedback);
    await this.feedbackStore.write(this.feedback);
    return clone(feedback);
  }

  public listProposals(): PromptOptimizationProposal[] {
    return clone(this.proposals);
  }

  public async analyzeFeedback(): Promise<PromptOptimizationProposal[]> {
    const grouped = new Map<string, ReviewFeedback[]>();
    for (const item of this.feedback) {
      if (!item.promptId || !item.note.trim()) {
        continue;
      }
      if (!['false_positive', 'missed_issue', 'unclear', 'accepted', 'rejected'].includes(item.label)) {
        continue;
      }
      const group = grouped.get(item.promptId) || [];
      group.push(item);
      grouped.set(item.promptId, group);
    }

    const created: PromptOptimizationProposal[] = [];
    for (const [promptId, feedback] of grouped.entries()) {
      const prompt = this.findPrompt(promptId);
      const additions = this.feedbackToFocusLines(feedback);
      if (additions.length === 0) {
        continue;
      }

      const proposal: PromptOptimizationProposal = {
        id: randomUUID(),
        promptId,
        baseVersion: prompt.currentVersion,
        title: `Tune ${prompt.label} from ${feedback.length} feedback item(s)`,
        rationale: this.buildProposalRationale(feedback),
        suggestedDraft: {
          focus: Array.from(new Set([...prompt.draft.focus, ...additions])),
          systemInstructions: prompt.draft.systemInstructions,
        },
        feedbackIds: feedback.map(item => item.id),
        status: 'open',
        createdAt: now(),
      };
      this.proposals.push(proposal);
      created.push(proposal);
    }

    await this.proposalStore.write(this.proposals);
    return clone(created);
  }

  public async applyProposal(id: string): Promise<PromptOptimizationProposal> {
    const proposal = this.findProposal(id);
    if (proposal.status !== 'open') {
      throw new Error('proposal is not open');
    }
    const prompt = this.findPrompt(proposal.promptId);
    prompt.draft = clone(proposal.suggestedDraft);
    prompt.updatedAt = now();
    proposal.status = 'applied';
    proposal.appliedAt = now();
    await this.promptStore.write(this.prompts);
    await this.proposalStore.write(this.proposals);
    return clone(proposal);
  }

  private ensureDefaultPrompts(prompts: ReviewPrompt[]): ReviewPrompt[] {
    const next = [...prompts];
    for (const defaultPrompt of DEFAULT_REVIEW_PROMPTS.map(createDefaultPrompt)) {
      if (!next.some(prompt => prompt.id === defaultPrompt.id)) {
        next.push(defaultPrompt);
      }
    }
    return next;
  }

  private ensureDefaultPromptTemplates(templates: PromptTemplate[]): PromptTemplate[] {
    const next = [...templates];
    for (const defaultTemplate of DEFAULT_PROMPT_TEMPLATES.map(createDefaultPromptTemplate)) {
      const existing = next.find(template => template.id === defaultTemplate.id);
      if (!existing) {
        next.push(defaultTemplate);
        continue;
      }

      existing.defaultBody = existing.defaultBody || defaultTemplate.defaultBody;
      existing.provider = existing.provider || defaultTemplate.provider;
      existing.scope = existing.scope || defaultTemplate.scope;
      existing.versions = Array.isArray(existing.versions) ? existing.versions : [];
      if (existing.versions.length === 0) {
        existing.versions.push(defaultTemplate.versions[0]!);
        existing.currentVersion = 1;
      }
      existing.draft = this.sanitizePromptTemplateDraft(
        existing.draft || defaultTemplate.draft,
        'promptTemplate.draft'
      );
    }
    return next;
  }

  private async persistAll(): Promise<void> {
    await this.promptTemplateStore.write(this.promptTemplates);
    await this.promptStore.write(this.prompts);
    await this.skillStore.write(this.skills);
    await this.feedbackStore.write(this.feedback);
    await this.proposalStore.write(this.proposals);
  }

  private findPromptTemplate(id: string): PromptTemplate {
    const template = this.findPromptTemplateSafe(id);
    if (!template) {
      throw new Error('prompt template not found');
    }
    return template;
  }

  private findPromptTemplateSafe(id: string): PromptTemplate | undefined {
    return this.promptTemplates.find(item => item.id === id);
  }

  private findPrompt(id: string): ReviewPrompt {
    const prompt = this.prompts.find(item => item.id === id);
    if (!prompt) {
      throw new Error('prompt not found');
    }
    return prompt;
  }

  private findSkill(id: string): ReviewSkill {
    const skill = this.skills.find(item => item.id === id);
    if (!skill) {
      throw new Error('skill not found');
    }
    return skill;
  }

  private findProposal(id: string): PromptOptimizationProposal {
    const proposal = this.proposals.find(item => item.id === id);
    if (!proposal) {
      throw new Error('proposal not found');
    }
    return proposal;
  }

  private sanitizeDraft(value: ReviewPromptDraft, fieldName: string): ReviewPromptDraft {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${fieldName} must be an object`);
    }
    return {
      focus: uniqueStrings(value.focus, `${fieldName}.focus`),
      systemInstructions:
        typeof value.systemInstructions === 'string' ? value.systemInstructions.trim() : '',
    };
  }

  private mergeDraft(
    current: ReviewPromptDraft,
    patch: Partial<ReviewPromptDraft>
  ): ReviewPromptDraft {
    return {
      focus: 'focus' in patch ? uniqueStrings(patch.focus, 'prompt.draft.focus') : [...current.focus],
      systemInstructions:
        'systemInstructions' in patch
          ? optionalString(patch.systemInstructions, 'prompt.draft.systemInstructions')
          : current.systemInstructions,
    };
  }

  private sanitizePromptTemplateDraft(
    value: PromptTemplateDraft,
    fieldName: string
  ): PromptTemplateDraft {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${fieldName} must be an object`);
    }
    return {
      body: this.promptTemplateBody(value.body, `${fieldName}.body`),
    };
  }

  private mergePromptTemplateDraft(
    current: PromptTemplateDraft,
    patch: Partial<PromptTemplateDraft>
  ): PromptTemplateDraft {
    return {
      body:
        'body' in patch
          ? this.promptTemplateBody(patch.body, 'promptTemplate.draft.body')
          : current.body,
    };
  }

  private promptTemplateBody(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }
    return value;
  }

  private renderTemplateBody(body: string, variables: Record<string, unknown>): string {
    return body.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) {
        return match;
      }

      const value = variables[key];
      if (value === undefined || value === null) {
        return '';
      }
      return String(value);
    });
  }

  private booleanValue(value: unknown, fieldName: string): boolean {
    if (typeof value !== 'boolean') {
      throw new Error(`${fieldName} must be a boolean`);
    }
    return value;
  }

  private integerValue(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`${fieldName} must be an integer`);
    }
    return value;
  }

  private uniqueSkillId(baseId: string): string {
    let candidate = baseId;
    let suffix = 2;
    while (this.skills.some(skill => skill.id === candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private matchesFiles(globs: string[], changedFiles: string[]): boolean {
    if (globs.length === 0 || changedFiles.length === 0) {
      return true;
    }
    return changedFiles.some(file => globs.some(glob => this.matchesGlob(glob, file)));
  }

  private matchesGlob(glob: string, file: string): boolean {
    if (glob === file || glob === '**') {
      return true;
    }
    if (glob.endsWith('/**')) {
      return file.startsWith(glob.slice(0, -3));
    }
    if (glob.startsWith('**/*.')) {
      return file.endsWith(glob.slice(4));
    }
    if (glob.startsWith('*.')) {
      return file.endsWith(glob.slice(1));
    }

    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(file);
  }

  private feedbackToFocusLines(feedback: ReviewFeedback[]): string[] {
    return feedback.map(item => {
      const note = item.note.replace(/\s+/g, ' ').trim();
      switch (item.label) {
        case 'false_positive':
        case 'rejected':
          return `Avoid false positives like recent feedback: ${note}`;
        case 'missed_issue':
          return `Check for missed issues like recent feedback: ${note}`;
        case 'unclear':
          return `Make findings clearer when recent feedback says: ${note}`;
        case 'accepted':
        case 'useful':
          return `Keep prioritizing patterns confirmed by feedback: ${note}`;
        default:
          return '';
      }
    }).filter(Boolean);
  }

  private buildProposalRationale(feedback: ReviewFeedback[]): string {
    const counts = feedback.reduce<Record<string, number>>((accumulator, item) => {
      accumulator[item.label] = (accumulator[item.label] || 0) + 1;
      return accumulator;
    }, {});

    return Object.entries(counts)
      .map(([label, count]) => `${count} ${label} feedback item(s)`)
      .join(', ');
  }
}

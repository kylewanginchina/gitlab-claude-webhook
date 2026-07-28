import fs from 'fs/promises';
import path from 'path';
import { simpleGit } from 'simple-git';
import { GitLabWebhookEvent } from '../types/gitlab';
import logger from '../utils/logger';
import { runtimeConfigService } from '../utils/runtimeConfig';
import { GitLabService } from './gitlabService';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';
import { ReviewSkill } from '../admin/reviewCustomizationTypes';
import { reviewCustomizationService as defaultReviewCustomizationService } from '../utils/reviewCustomization';
import { TimeBudget, createTimeBudget } from '../utils/timeBudget';

interface MergeRequestDiff {
  old_path?: string;
  new_path?: string;
  deleted_file?: boolean;
  new_file?: boolean;
  renamed_file?: boolean;
}

export interface PreparedReviewContext {
  projectId: number;
  mergeRequestIid: number;
  mergeRequestTitle: string;
  mergeRequestDescription: string;
  mergeRequestUrl: string;
  mergeRequestState: string;
  draft: boolean;
  workInProgress: boolean;
  sourceBranch: string;
  targetBranch: string;
  baseSha: string;
  startSha: string;
  headSha: string;
  diffs: MergeRequestDiff[];
  claudeGuidelineFiles: string[];
}

export interface ReviewFinding {
  title: string;
  body: string;
  confidence: number;
  path: string;
  line?: number;
  lineType: 'new' | 'old';
  category?: string;
  oldPath?: string;
  newPath?: string;
  verdict?: string;
  sources?: string[];
}

export interface ParsedReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewPassDefinition {
  id: string;
  label: string;
  prompt: string;
}

export interface ReviewPassResult extends ParsedReviewResult {
  passId: string;
  label: string;
}

interface ReviewPassTemplate {
  id: string;
  label: string;
  focus: string[];
  systemInstructions?: string;
  version?: number;
}

export class GitLabReviewService {
  private readonly reviewMarkerPrefix = 'gitlab-claude-code-review';
  private readonly reviewPassTemplates: ReviewPassTemplate[] = [
    {
      id: 'claude-guidelines',
      label: 'CLAUDE.md compliance',
      focus: [
        'Audit the merge request against relevant CLAUDE.md guidance.',
        'Only flag issues that are explicitly required by an applicable CLAUDE.md file.',
        'Ignore guidance that is clearly only for code generation and not relevant to review.',
      ],
    },
    {
      id: 'bug-scan',
      label: 'Shallow bug scan',
      focus: [
        'Read only the merge request changes and do a shallow scan for obvious bugs.',
        'Focus on high-impact correctness issues introduced by the changes.',
        'Do not expand into broad architecture feedback or speculative risks.',
      ],
    },
    {
      id: 'history-context',
      label: 'History and blame context',
      focus: [
        'Use git blame, git log, and nearby history to validate whether the change introduces a real regression.',
        'Prefer issues where historical context makes the bug more likely or confirms an existing contract.',
        'Ignore pre-existing issues unless this merge request makes them worse.',
      ],
    },
    {
      id: 'comments-and-contracts',
      label: 'Comments and local contracts',
      focus: [
        'Check comments, docblocks, nearby assertions, and naming/contracts in the touched files.',
        'Flag cases where the merge request violates a documented local invariant or explicit comment.',
        'Ignore generic style nits that are not tied to a concrete contract.',
      ],
    },
  ];

  constructor(
    private gitlabService: GitLabService = new GitLabService(),
    private reviewCustomizationService: ReviewCustomizationService = defaultReviewCustomizationService
  ) {}

  private getReviewConfig() {
    return runtimeConfigService.getConfig().review;
  }

  public async prepareReviewContext(
    projectPath: string,
    event: GitLabWebhookEvent
  ): Promise<PreparedReviewContext> {
    if (!event.merge_request) {
      throw new Error('GitLab code review is only supported for merge requests');
    }

    const mergeRequest = await this.gitlabService.getMergeRequest(
      event.project.id,
      event.merge_request.iid
    );

    await this.fetchTargetBranch(projectPath, mergeRequest.target_branch);

    const versions = await this.gitlabService.getMergeRequestDiffVersions(
      event.project.id,
      event.merge_request.iid
    );
    const latestVersion = versions[0];

    if (!latestVersion?.id) {
      throw new Error('Could not determine the latest merge request diff version');
    }

    const diffVersion = await this.gitlabService.getMergeRequestDiffVersion(
      event.project.id,
      event.merge_request.iid,
      latestVersion.id
    );

    const diffs: MergeRequestDiff[] = Array.isArray(diffVersion?.diffs) ? diffVersion.diffs : [];
    const claudeGuidelineFiles = await this.findRelevantClaudeFiles(projectPath, diffs);

    return {
      projectId: event.project.id,
      mergeRequestIid: event.merge_request.iid,
      mergeRequestTitle: mergeRequest.title || event.merge_request.title,
      mergeRequestDescription: mergeRequest.description || '',
      mergeRequestUrl: mergeRequest.web_url || event.merge_request.web_url,
      mergeRequestState: mergeRequest.state || event.merge_request.state,
      draft: Boolean(mergeRequest.draft),
      workInProgress: Boolean(mergeRequest.work_in_progress),
      sourceBranch: mergeRequest.source_branch || event.merge_request.source_branch,
      targetBranch: mergeRequest.target_branch || event.merge_request.target_branch,
      baseSha: diffVersion?.base_commit_sha || latestVersion.base_commit_sha,
      startSha: diffVersion?.start_commit_sha || latestVersion.start_commit_sha,
      headSha: diffVersion?.head_commit_sha || latestVersion.head_commit_sha,
      diffs,
      claudeGuidelineFiles,
    };
  }

  public async hasExistingReview(
    projectId: number,
    mergeRequestIid: number,
    headSha: string
  ): Promise<boolean> {
    const marker = this.buildReviewMarker(headSha);
    const discussions = await this.gitlabService.getMergeRequestDiscussions(projectId, mergeRequestIid);

    return discussions.some(discussion =>
      Array.isArray(discussion.notes) &&
      discussion.notes.some((note: any) => typeof note.body === 'string' && note.body.includes(marker))
    );
  }

  public buildReviewPasses(
    context: PreparedReviewContext,
    userFocus?: string,
    timeBudget: TimeBudget = this.getDefaultReviewTimeBudget(),
    provider: 'claude' | 'codex' = 'claude'
  ): ReviewPassDefinition[] {
    return this.getReviewPassTemplates().map(template => ({
      id: template.id,
      label: template.label,
      prompt: this.buildReviewPassPrompt(
        context,
        template,
        userFocus,
        this.getMatchingSkills(context, template.id, provider),
        timeBudget
      ),
    }));
  }

  public buildScoringPrompt(
    context: PreparedReviewContext,
    finding: ReviewFinding,
    userFocus?: string,
    timeBudget: TimeBudget = this.getDefaultReviewTimeBudget()
  ): string {
    const lines = [
      'Score whether this GitLab merge request review finding is real.',
      '',
      `Time budget: hard timeout ${timeBudget.timeoutMinutes} minutes; finish verification by ${timeBudget.softDeadlineMinutes} minutes; reserve ${timeBudget.wrapUpMinutes} minutes to return JSON.`,
      '',
      'You are performing the confidence-scoring stage of a multi-pass code review.',
      'Verify the finding against the merge request diff, relevant CLAUDE.md files, and git history as needed.',
      'Do not use Task, Agent, WebFetch, or WebSearch. Use only local repository inspection tools.',
      'Only score issues introduced or made worse by this merge request.',
      'If this is a CLAUDE.md-related issue, confirm that an applicable CLAUDE.md explicitly calls it out.',
      'Ignore lint, formatting, type errors, imports, and test failures that CI would catch separately.',
      '',
      `Merge request: ${context.mergeRequestUrl}`,
      `Source branch: ${context.sourceBranch}`,
      `Target branch: ${context.targetBranch}`,
      `Candidate issue title: ${finding.title}`,
      `Candidate path: ${finding.path}`,
      `Candidate line: ${finding.line ?? 'unknown'} (${finding.lineType})`,
      `Candidate category: ${finding.category || 'unknown'}`,
      `Candidate reviewers: ${finding.sources?.join(', ') || 'single pass'}`,
    ];

    if (userFocus) {
      lines.push(`Requested review focus: ${userFocus}`);
    }

    lines.push('');
    lines.push('Candidate rationale:');
    lines.push(finding.body);
    lines.push('');
    lines.push('Use this rubric verbatim:');
    lines.push('0: Not confident at all. This is a false positive that does not stand up to light scrutiny, or is a pre-existing issue.');
    lines.push('25: Somewhat confident. This might be a real issue, but may also be a false positive. The issue was not verified.');
    lines.push('50: Moderately confident. This is a real issue, but it may be minor, infrequent, or not very important.');
    lines.push('75: Highly confident. This is very likely a real and important issue, or is directly required by the relevant CLAUDE.md.');
    lines.push('100: Absolutely certain. The evidence directly confirms the issue and it is definitely real.');
    lines.push('');
    lines.push('Return ONLY a JSON code block in this exact shape:');
    lines.push('```json');
    lines.push('{');
    lines.push('  "title": "Brief issue title",');
    lines.push('  "body": "Concise explanation of the verified issue.",');
    lines.push('  "confidence": 0,');
    lines.push('  "path": "src/file.ts",');
    lines.push('  "line": 42,');
    lines.push('  "line_type": "new",');
    lines.push('  "category": "bug",');
    lines.push('  "old_path": "src/file.ts",');
    lines.push('  "new_path": "src/file.ts",');
    lines.push('  "verdict": "Short note explaining why the score was assigned."');
    lines.push('}');
    lines.push('```');

    const defaultPrompt = lines.join('\n');
    return this.renderPromptTemplate(
      'review.scoring.template',
      {
        reviewScoringPrompt: defaultPrompt,
        mergeRequestUrl: context.mergeRequestUrl,
        sourceBranch: context.sourceBranch,
        targetBranch: context.targetBranch,
        candidateTitle: finding.title,
        candidateBody: finding.body,
        candidatePath: finding.path,
        candidateLine: finding.line ?? 'unknown',
        candidateLineType: finding.lineType,
        candidateCategory: finding.category || 'unknown',
        candidateSources: finding.sources?.join(', ') || 'single pass',
        userFocus: userFocus || '',
        userFocusBlock: userFocus ? `Requested review focus: ${userFocus}` : '',
        ...timeBudget,
      },
      defaultPrompt
    );
  }

  public parseReviewOutput(output: string, minConfidence = 80): ParsedReviewResult {
    const parsed = this.parseJsonPayload(output);
    const findings = Array.isArray(parsed?.findings)
      ? parsed.findings
          .map((finding: unknown) => this.normalizeFinding(finding))
          .filter((finding: ReviewFinding | null): finding is ReviewFinding => Boolean(finding))
          .filter((finding: ReviewFinding) => finding.confidence >= minConfidence)
      : [];

    return {
      summary:
        typeof parsed?.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : 'Review completed.',
      findings,
    };
  }

  public parseScoredFinding(output: string, fallbackFinding: ReviewFinding): ReviewFinding | null {
    const parsed = this.parseJsonPayload(output);
    const normalized = this.normalizeFinding(parsed);

    if (!normalized) {
      return null;
    }

    return {
      ...fallbackFinding,
      ...normalized,
      confidence: normalized.confidence,
      title: normalized.title || fallbackFinding.title,
      body: normalized.body || fallbackFinding.body,
      path: normalized.path || fallbackFinding.path,
      line: normalized.line ?? fallbackFinding.line,
      lineType: normalized.lineType || fallbackFinding.lineType,
      category: normalized.category || fallbackFinding.category,
      oldPath: normalized.oldPath || fallbackFinding.oldPath,
      newPath: normalized.newPath || fallbackFinding.newPath,
      verdict: normalized.verdict || fallbackFinding.verdict,
      sources: fallbackFinding.sources,
    };
  }

  public mergeCandidateFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const deduped = new Map<string, ReviewFinding>();

    for (const finding of findings) {
      const key = this.buildFindingKey(finding);
      const existing = deduped.get(key);

      if (!existing) {
        deduped.set(key, {
          ...finding,
          sources: [...(finding.sources || [])],
        });
        continue;
      }

      const mergedSources = Array.from(
        new Set([...(existing.sources || []), ...(finding.sources || [])])
      );

      const mergedBody =
        existing.body === finding.body
          ? existing.body
          : `${existing.body}\n\nAdditional corroboration: ${finding.body}`;

      deduped.set(key, {
        ...existing,
        confidence: Math.max(existing.confidence, finding.confidence),
        body: mergedBody,
        category:
          existing.confidence >= finding.confidence
            ? existing.category || finding.category
            : finding.category || existing.category,
        oldPath: existing.oldPath || finding.oldPath,
        newPath: existing.newPath || finding.newPath,
        sources: mergedSources,
      });
    }

    return Array.from(deduped.values())
      .sort((a, b) => {
        const sourceDelta = (b.sources?.length || 0) - (a.sources?.length || 0);
        if (sourceDelta !== 0) {
          return sourceDelta;
        }

        return b.confidence - a.confidence;
      })
      .slice(0, this.getReviewConfig().maxCandidateFindings);
  }

  public buildFinalReview(
    passResults: ReviewPassResult[],
    findings: ReviewFinding[],
    candidateCount: number
  ): ParsedReviewResult {
    const keptFindings = [...findings]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.getReviewConfig().maxFinalFindings);

    const summary =
      keptFindings.length === 0
        ? `Multi-pass review completed across ${passResults.length} review passes. ${candidateCount} candidate issue(s) were rescored and none remained above the confidence threshold.`
        : `Multi-pass review completed across ${passResults.length} review passes. ${candidateCount} candidate issue(s) were rescored and ${keptFindings.length} high-confidence finding(s) remained.`;

    return {
      summary,
      findings: keptFindings,
    };
  }

  public async postReview(
    event: GitLabWebhookEvent,
    context: PreparedReviewContext,
    review: ParsedReviewResult
  ): Promise<void> {
    if (!event.merge_request) {
      throw new Error('GitLab code review is only supported for merge requests');
    }

    const summaryComment = this.buildSummaryComment(event, context, review);
    await this.gitlabService.addMergeRequestComment(
      event.project.id,
      event.merge_request.iid,
      summaryComment
    );

    for (const finding of review.findings) {
      try {
        const position = this.buildDiscussionPosition(context, finding);
        if (!position) {
          continue;
        }

        await this.gitlabService.createMergeRequestDiscussion(
          event.project.id,
          event.merge_request.iid,
          this.buildInlineDiscussionBody(finding),
          { position }
        );
      } catch (error) {
        logger.warn('Failed to create inline GitLab review discussion', {
          mergeRequestIid: event.merge_request.iid,
          path: finding.path,
          line: finding.line,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public buildNoIssuesMessage(
    headSha: string,
    options?: {
      context?: PreparedReviewContext;
      completedPasses?: ReviewPassResult[];
      note?: string;
    }
  ): string {
    const lines = [this.buildReviewMarker(headSha), '### Code review', ''];

    if (options?.context) {
      lines.push(...this.buildCoverageDetails(options.context, options.completedPasses));
      lines.push('');
    }

    lines.push(
      options?.note ||
        'No high-confidence issues found. Checked for bugs, history/context, local contracts, and CLAUDE.md compliance.'
    );
    lines.push('');
    lines.push('Generated with Claude Code');

    return lines.join('\n');
  }

  private renderPromptTemplate(
    id: string,
    variables: Record<string, unknown>,
    fallback: string
  ): string {
    try {
      return this.reviewCustomizationService.renderPromptTemplate(id, variables, fallback);
    } catch (error) {
      logger.warn('Falling back to built-in review prompt template', {
        templateId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  public buildIncompleteReviewMessage(
    headSha: string,
    options: {
      context?: PreparedReviewContext;
      completedPasses?: ReviewPassResult[];
      completedStages?: string[];
      failedStages?: string[];
      note: string;
    }
  ): string {
    const lines = [this.buildReviewMarker(headSha), '### Code review', '', 'Review completed with partial coverage.', ''];

    if (options.context) {
      lines.push(...this.buildCoverageDetails(options.context, options.completedPasses));
      lines.push('');
    }

    if (options.completedStages && options.completedStages.length > 0) {
      lines.push('Completed stages:');
      options.completedStages.forEach(stage => {
        lines.push(`- ${stage}`);
      });
      lines.push('');
    }

    if (options.failedStages && options.failedStages.length > 0) {
      lines.push('Timed out or failed stages:');
      options.failedStages.forEach(stage => {
        lines.push(`- ${stage}`);
      });
      lines.push('');
    }

    lines.push(options.note);
    lines.push('');
    lines.push('Generated with Claude Code');

    return lines.join('\n');
  }

  private buildCoverageDetails(
    context: PreparedReviewContext,
    completedPasses?: ReviewPassResult[]
  ): string[] {
    const lines = [
      `Merge request: ${context.mergeRequestTitle}`,
      `Files reviewed: ${context.diffs.length}`,
    ];

    const files = context.diffs
      .map(diff => diff.new_path || diff.old_path)
      .filter((file): file is string => Boolean(file))
      .slice(0, 8);

    if (files.length > 0) {
      lines.push('');
      lines.push('Touched files reviewed:');
      files.forEach(file => {
        lines.push(`- ${file}`);
      });

      if (context.diffs.length > files.length) {
        lines.push(`- ...and ${context.diffs.length - files.length} more file(s)`);
      }
    }

    if (completedPasses && completedPasses.length > 0) {
      lines.push('');
      lines.push('Completed stage summaries:');
      completedPasses.forEach(pass => {
        lines.push(`- ${pass.label}: ${pass.summary}`);
      });
    }

    return lines;
  }

  private buildReviewPassPrompt(
    context: PreparedReviewContext,
    template: ReviewPassTemplate,
    userFocus?: string,
    skills: ReviewSkill[] = [],
    timeBudget: TimeBudget = this.getDefaultReviewTimeBudget()
  ): string {
    const lines = [
      'Provide a GitLab merge request code review.',
      '',
      `Time budget: hard timeout ${timeBudget.timeoutMinutes} minutes; finish substantive review by ${timeBudget.softDeadlineMinutes} minutes; reserve ${timeBudget.wrapUpMinutes} minutes to return JSON.`,
      '',
      `Review pass: ${template.label}`,
      ...template.focus.map((line, index) => `${index + 1}. ${line}`),
    ];

    if (template.systemInstructions) {
      lines.push('', 'Admin prompt instructions:', template.systemInstructions);
    }

    if (skills.length > 0) {
      lines.push('', 'Admin skill instructions:');
      skills.forEach(skill => {
        lines.push(`- ${skill.name}: ${skill.systemInstructions}`);
      });
    }

    lines.push(
      'Do not modify files, commit, or change git state.',
      'Do not use Task, Agent, WebFetch, or WebSearch.',
      'Use only local repository inspection tools and keep exploration narrow.',
      'Review only issues introduced or made worse by this merge request.',
      'Ignore formatting, lint, type errors, missing imports, tests, or other CI/build output.',
      'Prefer fewer, high-signal issues instead of broad feedback.',
      '',
      `Merge request: ${context.mergeRequestUrl}`,
      `Title: ${context.mergeRequestTitle}`,
      `Source branch: ${context.sourceBranch}`,
      `Target branch: ${context.targetBranch}`,
      '',
      'Changed files:',
      this.formatChangedFiles(context.diffs),
      '',
      'Relevant CLAUDE.md files:',
      this.formatGuidelineFiles(context.claudeGuidelineFiles),
    );

    if (userFocus) {
      lines.push('');
      lines.push(`Requested review focus: ${userFocus}`);
    }

    lines.push('');
    lines.push(
      `Use local git commands like 'git diff origin/${context.targetBranch}...HEAD -- <file>', 'git blame', and 'git log' when needed.`
    );
    lines.push('');
    lines.push('Return ONLY a JSON code block in this exact shape:');
    lines.push('```json');
    lines.push('{');
    lines.push('  "summary": "Short pass summary",');
    lines.push('  "findings": [');
    lines.push('    {');
    lines.push('      "title": "Brief issue title",');
    lines.push('      "body": "Why this issue is real and how the merge request causes it.",');
    lines.push('      "confidence": 0,');
    lines.push('      "path": "src/file.ts",');
    lines.push('      "line": 42,');
    lines.push('      "line_type": "new",');
    lines.push('      "category": "bug",');
    lines.push('      "old_path": "src/file.ts",');
    lines.push('      "new_path": "src/file.ts"');
    lines.push('    }');
    lines.push('  ]');
    lines.push('}');
    lines.push('```');
    lines.push('');
    lines.push('Rules for findings:');
    lines.push('- Maximum 5 findings.');
    lines.push('- Score confidence from 0-100 based on how likely the issue is real.');
    lines.push('- Include only issues on lines modified by this merge request.');
    lines.push('- If there are no worthwhile issues, return an empty findings array.');

    const defaultPrompt = lines.join('\n');
    return this.renderPromptTemplate(
      'review.pass.template',
      {
        reviewPassPrompt: defaultPrompt,
        reviewPassLabel: template.label,
        reviewPassFocus: template.focus.map((line, index) => `${index + 1}. ${line}`).join('\n'),
        adminPromptInstructions: template.systemInstructions || '',
        adminPromptInstructionsBlock: template.systemInstructions
          ? `\nAdmin prompt instructions:\n${template.systemInstructions}\n\n`
          : '',
        adminSkillInstructions: skills
          .map(skill => `- ${skill.name}: ${skill.systemInstructions}`)
          .join('\n'),
        adminSkillInstructionsBlock:
          skills.length > 0
            ? `\nAdmin skill instructions:\n${skills
                .map(skill => `- ${skill.name}: ${skill.systemInstructions}`)
                .join('\n')}\n\n`
            : '',
        mergeRequestUrl: context.mergeRequestUrl,
        mergeRequestTitle: context.mergeRequestTitle,
        sourceBranch: context.sourceBranch,
        targetBranch: context.targetBranch,
        changedFiles: this.formatChangedFiles(context.diffs),
        guidelineFiles: this.formatGuidelineFiles(context.claudeGuidelineFiles),
        userFocus: userFocus || '',
        userFocusBlock: userFocus ? `\nRequested review focus: ${userFocus}` : '',
        ...timeBudget,
      },
      defaultPrompt
    );
  }

  private getDefaultReviewTimeBudget(): TimeBudget {
    const runtimeConfig = runtimeConfigService.getConfig();
    return createTimeBudget(runtimeConfig.claude.defaultTimeoutMinutes * 60 * 1000);
  }

  private getReviewPassTemplates(): ReviewPassTemplate[] {
    if (!this.reviewCustomizationService.isLoaded()) {
      return this.reviewPassTemplates;
    }

    return this.reviewCustomizationService.getPublishedReviewPasses().map(prompt => ({
      id: prompt.id,
      label: prompt.label,
      focus: prompt.focus,
      systemInstructions: prompt.systemInstructions,
      version: prompt.version,
    }));
  }

  private getMatchingSkills(
    context: PreparedReviewContext,
    passId: string,
    provider: 'claude' | 'codex'
  ): ReviewSkill[] {
    if (!this.reviewCustomizationService.isLoaded()) {
      return [];
    }

    return this.reviewCustomizationService.getMatchingSkills(context, passId, provider);
  }

  private async fetchTargetBranch(projectPath: string, targetBranch: string): Promise<void> {
    const git = simpleGit(projectPath);

    try {
      await git.fetch('origin', `${targetBranch}:refs/remotes/origin/${targetBranch}`);
    } catch (error) {
      logger.warn('Failed to fetch target branch for review context', {
        projectPath,
        targetBranch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async findRelevantClaudeFiles(
    projectPath: string,
    diffs: MergeRequestDiff[]
  ): Promise<string[]> {
    const candidates = new Set<string>(['CLAUDE.md']);

    for (const diff of diffs) {
      for (const candidatePath of [diff.new_path, diff.old_path]) {
        if (!candidatePath) {
          continue;
        }

        let currentDir = path.dirname(candidatePath);
        while (currentDir && currentDir !== '.' && currentDir !== path.dirname(currentDir)) {
          candidates.add(path.posix.join(currentDir, 'CLAUDE.md'));
          currentDir = path.posix.dirname(currentDir);
        }
      }
    }

    const existingFiles: string[] = [];

    for (const candidate of candidates) {
      try {
        await fs.access(path.join(projectPath, candidate));
        existingFiles.push(candidate);
      } catch {
        // Ignore missing guideline files.
      }
    }

    return existingFiles.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }

  private buildSummaryComment(
    event: GitLabWebhookEvent,
    context: PreparedReviewContext,
    review: ParsedReviewResult
  ): string {
    const marker = this.buildReviewMarker(context.headSha);

    if (review.findings.length === 0) {
      return this.buildNoIssuesMessage(context.headSha);
    }

    const lines = [
      marker,
      '### Code review',
      '',
      review.summary,
      '',
      `Found ${review.findings.length} issue${review.findings.length === 1 ? '' : 's'}:`,
      '',
    ];

    review.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.title}`);

      const link = this.buildFindingLink(event, context, finding);
      if (link) {
        lines.push('');
        lines.push(`[${this.buildFindingLinkLabel(finding)}](${link})`);
      }

      lines.push('');
      lines.push(finding.body);
      lines.push('');
      lines.push(`Confidence: ${finding.confidence}`);

      if (finding.sources?.length) {
        lines.push(`Review passes: ${finding.sources.join(', ')}`);
      }

      if (finding.verdict) {
        lines.push(`Verdict: ${finding.verdict}`);
      }

      lines.push('');
    });

    lines.push('Generated with Claude Code');

    return lines.join('\n');
  }

  private buildInlineDiscussionBody(finding: ReviewFinding): string {
    const lines = [`Code review: ${finding.title}`, '', finding.body, '', `Confidence: ${finding.confidence}`];

    if (finding.category) {
      lines.push(`Category: ${finding.category}`);
    }

    if (finding.sources?.length) {
      lines.push(`Review passes: ${finding.sources.join(', ')}`);
    }

    if (finding.verdict) {
      lines.push(`Verdict: ${finding.verdict}`);
    }

    return lines.join('\n');
  }

  private buildFindingLink(
    event: GitLabWebhookEvent,
    context: PreparedReviewContext,
    finding: ReviewFinding
  ): string | null {
    if (!finding.line) {
      return null;
    }

    const filePath =
      finding.lineType === 'old'
        ? finding.oldPath || finding.path
        : finding.newPath || finding.path;
    const sha = finding.lineType === 'old' ? context.startSha : context.headSha;

    if (!filePath) {
      return null;
    }

    const encodedFilePath = filePath.split('/').map(encodeURIComponent).join('/');
    return `${event.project.web_url}/-/blob/${sha}/${encodedFilePath}#L${finding.line}`;
  }

  private buildFindingLinkLabel(finding: ReviewFinding): string {
    const filePath =
      finding.lineType === 'old'
        ? finding.oldPath || finding.path
        : finding.newPath || finding.path;

    return `${filePath}:${finding.line}`;
  }

  private buildDiscussionPosition(
    context: PreparedReviewContext,
    finding: ReviewFinding
  ):
    | {
        base_sha: string;
        start_sha: string;
        head_sha: string;
        position_type: 'text';
        old_path: string;
        new_path: string;
        old_line?: string;
        new_line?: string;
      }
    | null {
    if (!finding.line) {
      return null;
    }

    const diff = this.findMatchingDiff(context.diffs, finding);
    if (!diff?.old_path || !diff?.new_path) {
      return null;
    }

    return {
      base_sha: context.baseSha,
      start_sha: context.startSha,
      head_sha: context.headSha,
      position_type: 'text',
      old_path: finding.oldPath || diff.old_path,
      new_path: finding.newPath || diff.new_path,
      ...(finding.lineType === 'old'
        ? { old_line: String(finding.line) }
        : { new_line: String(finding.line) }),
    };
  }

  private findMatchingDiff(diffs: MergeRequestDiff[], finding: ReviewFinding): MergeRequestDiff | null {
    const normalizedPath = this.normalizePath(finding.path);
    const normalizedOldPath = this.normalizePath(finding.oldPath);
    const normalizedNewPath = this.normalizePath(finding.newPath);

    return (
      diffs.find(diff => {
        const diffOldPath = this.normalizePath(diff.old_path);
        const diffNewPath = this.normalizePath(diff.new_path);

        return [normalizedPath, normalizedOldPath, normalizedNewPath].some(
          candidate =>
            Boolean(candidate) && (candidate === diffOldPath || candidate === diffNewPath)
        );
      }) || null
    );
  }

  private buildFindingKey(finding: ReviewFinding): string {
    const path = this.normalizePath(finding.newPath || finding.oldPath || finding.path) || 'unknown';
    const line = finding.line ?? 0;
    const lineType = finding.lineType;
    const title = (this.normalizeText(finding.title) || 'untitled').toLowerCase();

    return [path, lineType, line, title].join('|');
  }

  private normalizeFinding(finding: unknown): ReviewFinding | null {
    const record = this.asRecord(finding);
    if (!record) {
      return null;
    }

    const title = this.normalizeText(record.title);
    const body = this.normalizeText(record.body);
    const pathValue = this.normalizePath(record.path);
    const confidence = Number(record.confidence);
    const lineValue = record.line;
    const line = lineValue === undefined || lineValue === null ? undefined : Number(lineValue);

    if (!title || !body || !pathValue || !Number.isFinite(confidence)) {
      return null;
    }

    return {
      title,
      body,
      confidence,
      path: pathValue,
      line: Number.isFinite(line) ? line : undefined,
      lineType: record.line_type === 'old' ? 'old' : 'new',
      category: this.normalizeText(record.category),
      oldPath: this.normalizePath(record.old_path),
      newPath: this.normalizePath(record.new_path),
      verdict: this.normalizeText(record.verdict),
      sources: Array.isArray(record.sources)
        ? record.sources
            .map(source => this.normalizeText(source))
            .filter((source): source is string => Boolean(source))
        : undefined,
    };
  }

  private parseJsonPayload(output: string): Record<string, any> | null {
    const jsonText = this.extractJsonBlock(output);
    if (!jsonText) {
      return null;
    }

    try {
      return JSON.parse(jsonText);
    } catch (error) {
      logger.warn('Failed to parse review JSON payload', {
        error: error instanceof Error ? error.message : String(error),
        outputPreview: output.slice(0, 300),
      });
      return null;
    }
  }

  private extractJsonBlock(output: string): string {
    const fencedMatch = output.match(/```json\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    const genericFenceMatch = output.match(/```\s*([\s\S]*?)```/);
    if (genericFenceMatch?.[1]) {
      return genericFenceMatch[1].trim();
    }

    return output.trim();
  }

  private buildReviewMarker(headSha: string): string {
    return `<!-- ${this.reviewMarkerPrefix}:${headSha} -->`;
  }

  private formatChangedFiles(diffs: MergeRequestDiff[]): string {
    const lines = diffs.map(diff => {
      const oldPath = diff.old_path || diff.new_path || 'unknown';
      const newPath = diff.new_path || diff.old_path || 'unknown';

      if (oldPath === newPath) {
        return `- ${newPath}`;
      }

      return `- ${oldPath} -> ${newPath}`;
    });

    return lines.length > 0 ? lines.join('\n') : '- None';
  }

  private formatGuidelineFiles(files: string[]): string {
    if (files.length === 0) {
      return '- None found';
    }

    return files.map(file => `- ${file}`).join('\n');
  }

  private normalizePath(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized || undefined;
  }

  private normalizeText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized || undefined;
  }

  private asRecord(value: unknown): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, any>;
  }
}

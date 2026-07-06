import { GitLabWebhookEvent, AIInstruction } from '../types/gitlab';
import {
  extractAIInstructions,
  isCodeReviewCommand,
  extractCodeReviewFocus,
} from '../utils/webhook';
import logger from '../utils/logger';
import { ProjectManager } from './projectManager';
import { StreamingClaudeExecutor } from './streamingClaudeExecutor';
import { AIExecutionContext, StreamingProgressCallback } from '../types/common';
import { CodexExecutor } from './codexExecutor';
import { GitLabService } from './gitlabService';
import { MRGenerator } from '../utils/mrGenerator';
import { RuntimeConfig } from '../admin/adminTypes';
import {
  GitLabReviewService,
  PreparedReviewContext,
  ReviewFinding,
  ReviewPassResult,
} from './gitlabReviewService';
import { runtimeConfigService } from '../utils/runtimeConfig';
import {
  formatProgressComment,
  inferProgressStatus,
  linkifyReviewReferences,
  sanitizeProgressMessage,
  type ProgressEntry,
} from '../utils/gitlabMarkdown';

export class EventProcessor {
  private projectManager: ProjectManager;
  private claudeExecutor: StreamingClaudeExecutor;
  private codexExecutor: CodexExecutor;
  private gitlabService: GitLabService;
  private gitlabReviewService: GitLabReviewService;
  private currentCommentId: number | null = null;
  private currentDiscussionId: string | null = null;

  constructor() {
    this.projectManager = new ProjectManager();
    this.claudeExecutor = new StreamingClaudeExecutor();
    this.codexExecutor = new CodexExecutor();
    this.gitlabService = new GitLabService();
    this.gitlabReviewService = new GitLabReviewService(this.gitlabService);
  }

  public async processEvent(event: GitLabWebhookEvent): Promise<void> {
    try {
      const instruction = await this.extractInstruction(event);

      if (!instruction) {
        logger.debug('No Claude instruction found in event', {
          eventType: event.object_kind,
          projectId: event.project.id,
        });
        return;
      }

      logger.info('Processing AI instruction', {
        eventType: event.object_kind,
        projectId: event.project.id,
        provider: instruction.provider,
        instruction: instruction.command.substring(0, 100),
      });

      await this.executeInstruction(event, instruction);
    } catch (error) {
      logger.error('Error processing event:', error);
      await this.reportError(event, error);
    } finally {
      // Reset state after processing
      this.currentDiscussionId = null;
    }
  }

  private async extractInstruction(event: GitLabWebhookEvent): Promise<AIInstruction | null> {
    let content = '';
    let branch = '';
    let context = '';

    switch (event.object_kind) {
      case 'issue':
        if (event.issue) {
          content = event.issue.description || '';
          context = `Issue #${event.issue.iid}: ${event.issue.title}`;
          branch = event.project.default_branch;
        }
        break;

      case 'merge_request':
        if (event.merge_request) {
          content = event.merge_request.description || '';
          context = await this.buildMergeRequestContext(event.merge_request, event.project.id);
          branch = event.merge_request.source_branch;
        }
        break;

      case 'note':
        if (event.object_attributes) {
          content = (event.object_attributes as { note?: string }).note || '';
          const noteId = (event.object_attributes as { id?: number }).id;

          if (event.issue) {
            // Build enhanced context for issue comments
            context = `Issue #${event.issue.iid}: ${event.issue.title}\n\n**Issue Description:** ${event.issue.description ? (event.issue.description.length > 200 ? event.issue.description.substring(0, 200) + '...' : event.issue.description) : 'No description provided'}`;
            branch = event.project.default_branch;

            // Check if this is a reply in a discussion thread
            if (noteId) {
              const threadInfo = await this.getThreadContext(
                'issue',
                event.project.id,
                event.issue.iid,
                noteId
              );
              if (threadInfo && this.isActualReply(threadInfo)) {
                context = `${context}\n\n${threadInfo}`;
              }
            }
          } else if (event.merge_request) {
            // Build enhanced context for merge request comments including code changes
            context = await this.buildMergeRequestContext(event.merge_request, event.project.id);
            branch = event.merge_request.source_branch;

            // Check if this is a reply in a discussion thread
            if (noteId) {
              const threadInfo = await this.getThreadContext(
                'merge_request',
                event.project.id,
                event.merge_request.iid,
                noteId
              );
              if (threadInfo && this.isActualReply(threadInfo)) {
                context = `${context}\n\n${threadInfo}`;
              }
            }
          }
        }
        break;

      default:
        return null;
    }

    // Extract AI instruction with provider and model information
    const aiInstruction = extractAIInstructions(content);

    if (!aiInstruction) {
      return null;
    }

    return {
      command: aiInstruction.command,
      context,
      branch,
      provider: aiInstruction.provider,
      model: aiInstruction.model,
      timeoutMs: aiInstruction.timeout ? aiInstruction.timeout * 60 * 1000 : undefined,
    };
  }

  private async getThreadContext(
    type: 'issue' | 'merge_request',
    projectId: number,
    itemIid: number,
    noteId: number
  ): Promise<string | null> {
    try {
      let discussions: any[];

      if (type === 'issue') {
        discussions = await this.gitlabService.getIssueDiscussions(projectId, itemIid);
      } else {
        discussions = await this.gitlabService.getMergeRequestDiscussions(projectId, itemIid);
      }

      const result = await this.gitlabService.findNoteInDiscussions(discussions, noteId);

      if (result) {
        // Store discussion ID for later use in replies
        this.currentDiscussionId = result.discussionId;

        logger.info('Found thread context for note', {
          projectId,
          itemIid,
          noteId,
          discussionId: result.discussionId,
          contextLength: result.threadContext.length,
        });
        return result.threadContext;
      }

      return null;
    } catch (error) {
      logger.error('Failed to get thread context:', error);
      return null;
    }
  }

  private isActualReply(threadContext: string | null): boolean {
    if (!threadContext || !threadContext.trim()) {
      return false;
    }

    // Check if there's meaningful thread context content
    // Thread context should contain previous comments in the discussion
    const hasThreadContext = threadContext.includes('**Thread Context:**');

    if (!hasThreadContext) {
      return false;
    }

    // Extract the content after "**Thread Context:**"
    const contextContent = threadContext.split('**Thread Context:**')[1]?.trim();

    // If there's actual previous conversation content, this is a reply
    // If it's empty or just whitespace, this is the first comment in a new thread
    return Boolean(contextContent && contextContent.length > 0);
  }

  private async buildMergeRequestContext(mergeRequest: any, projectId: number): Promise<string> {
    try {
      let context = `MR #${mergeRequest.iid}: ${mergeRequest.title}\n\n`;

      // Add MR description if available and not too long
      if (mergeRequest.description && mergeRequest.description.trim()) {
        const description =
          mergeRequest.description.length > 200
            ? mergeRequest.description.substring(0, 200) + '...'
            : mergeRequest.description;
        context += `**Description:** ${description}\n\n`;
      }

      // Add branch information
      context += `**Source Branch:** ${mergeRequest.source_branch}\n`;
      context += `**Target Branch:** ${mergeRequest.target_branch}\n`;

      // Use webhook data first, fall back to API if needed
      if (mergeRequest.changes_count !== undefined) {
        context += `**Changes:** ${mergeRequest.changes_count} files modified\n`;
      }

      if (mergeRequest.additions !== undefined && mergeRequest.deletions !== undefined) {
        context += `**Additions:** +${mergeRequest.additions}, **Deletions:** -${mergeRequest.deletions}\n`;
      } else if (!mergeRequest.changes_count) {
        // Only call API if webhook doesn't have the info we need
        try {
          const mrDetails = await this.gitlabService.getMergeRequest(projectId, mergeRequest.iid);

          if (mrDetails.changes_count) {
            context += `**Changes:** ${mrDetails.changes_count} files modified\n`;
          }

          if (mrDetails.additions && mrDetails.deletions) {
            context += `**Additions:** +${mrDetails.additions}, **Deletions:** -${mrDetails.deletions}\n`;
          }
        } catch (error) {
          logger.debug('Could not fetch additional MR details:', error);
        }
      }

      return context.trim();
    } catch (error) {
      logger.error('Error building merge request context:', error);
      return `MR #${mergeRequest.iid}: ${mergeRequest.title}`;
    }
  }

  private async executeInstruction(
    event: GitLabWebhookEvent,
    instruction: AIInstruction
  ): Promise<void> {
    // Clear previous progress messages for this new instruction
    this.progressMessages = [];

    const reviewSettings = runtimeConfigService.getConfig().review;
    const isReviewCommand = isCodeReviewCommand(
      instruction.command,
      reviewSettings.allowedCommands
    );

    // Determine provider name for messages
    const providerName = (
      isReviewCommand
        ? this.resolveReviewExecutionProvider(reviewSettings.defaultProvider)
        : instruction.provider
    ) === 'codex'
      ? 'Codex'
      : 'Claude';

    // Create initial progress comment
    const initialMessage = this.buildInitialProgressComment(providerName, instruction.command);

    this.currentCommentId = await this.createProgressComment(event, initialMessage);

    const baseBranch = instruction.branch || event.project.default_branch;

    if (isReviewCommand && !reviewSettings.enabled) {
      const message =
        'Skipped code review: review commands are currently disabled in runtime settings.';
      logger.info(message, {
        projectId: event.project.id,
        command: instruction.command,
      });
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    const projectPath = await this.projectManager.prepareProject(event.project, baseBranch);

    try {
      // Create streaming callback for real-time updates
      const callback: StreamingProgressCallback = {
        onProgress: async (message: string, isComplete?: boolean) => {
          await this.updateProgressComment(event, message, isComplete);
        },
        onError: async (error: string) => {
          await this.updateProgressComment(event, error, true, true);
        },
      };

      if (isReviewCommand) {
        await this.executeCodeReview(
          event,
          instruction,
          baseBranch,
          projectPath,
          callback,
          reviewSettings,
          extractCodeReviewFocus(instruction.command, reviewSettings.allowedCommands)
        );
        return;
      }

      const result = await this.executeWithProvider(
        instruction,
        instruction.command,
        projectPath,
        {
          context: instruction.context,
          projectUrl: event.project.web_url,
          branch: baseBranch,
          event,
          instruction: instruction.command,
          model: instruction.model,
          timeoutMs: instruction.timeoutMs,
        },
        callback
      );

      if (result.success) {
        await this.handleSuccess(event, instruction, result, baseBranch, projectPath);
      } else {
        await this.handleFailure(event, instruction, result);
      }
    } finally {
      await this.projectManager.cleanup(projectPath);
    }
  }

  private async executeCodeReview(
    event: GitLabWebhookEvent,
    instruction: AIInstruction,
    baseBranch: string,
    projectPath: string,
    callback: StreamingProgressCallback,
    reviewSettings: RuntimeConfig['review'] = runtimeConfigService.getConfig().review,
    userFocus: string | undefined = extractCodeReviewFocus(
      instruction.command,
      reviewSettings.allowedCommands
    )
  ): Promise<void> {
    if (!event.merge_request) {
      await this.postComment(
        event,
        'Code review is only supported on merge requests or merge request comments.'
      );
      await this.updateProgressComment(event, 'Skipped code review: unsupported event type.', true);
      return;
    }

    await this.updateProgressComment(event, 'Preparing GitLab merge request review context...');

    const reviewContext = await this.gitlabReviewService.prepareReviewContext(projectPath, event);
    const reviewInstruction: AIInstruction = {
      ...instruction,
      provider: this.resolveReviewExecutionProvider(reviewSettings.defaultProvider),
    };

    if (reviewContext.mergeRequestState !== 'opened') {
      const message = `Skipped code review: merge request is ${reviewContext.mergeRequestState}.`;
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    if (reviewSettings.skipDraft && (reviewContext.draft || reviewContext.workInProgress)) {
      const message = 'Skipped code review: merge request is draft/WIP.';
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    if (reviewContext.diffs.length === 0) {
      const message = 'Skipped code review: merge request has no diff content to review.';
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    const alreadyReviewed = await this.gitlabReviewService.hasExistingReview(
      reviewContext.projectId,
      reviewContext.mergeRequestIid,
      reviewContext.headSha
    );

    if (reviewSettings.skipExistingSha && alreadyReviewed) {
      const message =
        'Skipped code review: this merge request SHA already has a recorded review.';
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    const executionContext: AIExecutionContext = {
      context: instruction.context,
      projectUrl: event.project.web_url,
      branch: baseBranch,
      event,
      instruction: instruction.command,
      model: instruction.model,
      timeoutMs: instruction.timeoutMs,
      mode: 'review' as const,
    };

    const reviewPasses = this.gitlabReviewService.buildReviewPasses(reviewContext, userFocus);
    await this.updateProgressComment(
      event,
      `Launching ${reviewPasses.length} GitLab review pass(es)...`
    );

    const passResults = await this.runWithConcurrency(
      reviewPasses,
      reviewSettings.passConcurrency,
      pass =>
        this.executeReviewPass(
          reviewInstruction,
          pass.id,
          pass.label,
          pass.prompt,
          projectPath,
          executionContext,
          callback
        )
    );

    const successfulPasses: ReviewPassResult[] = [];
    const passErrors: string[] = [];
    const passErrorLabels: string[] = [];

    for (const result of passResults) {
      if (result.status === 'fulfilled') {
        if (result.value) {
          successfulPasses.push(result.value);
        }
      } else {
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        passErrors.push(message);
        passErrorLabels.push(this.summarizeStageFailure(message));
      }
    }

    if (successfulPasses.length === 0) {
      await this.handleFailure(event, reviewInstruction, {
        error:
          passErrors.length > 0
            ? `All code review passes failed: ${passErrors.join('; ')}`
            : 'All code review passes failed.',
      });
      return;
    }

    const candidateFindings = this.gitlabReviewService.mergeCandidateFindings(
      successfulPasses.flatMap(pass =>
        pass.findings.map((finding: ReviewFinding) => ({
          ...finding,
          sources: [pass.label],
        }))
      )
    );

    if (candidateFindings.length === 0) {
      if (passErrors.length > 0) {
        await this.postComment(
          event,
          this.gitlabReviewService.buildIncompleteReviewMessage(reviewContext.headSha, {
            context: reviewContext,
            completedPasses: successfulPasses,
            completedStages: successfulPasses.map(pass => pass.label),
            failedStages: passErrorLabels,
            note:
              'No candidate issues were found in the completed review passes. This should not be interpreted as a full clean review because some review passes did not finish.',
          })
        );
        await this.updateProgressComment(
          event,
          'Code review completed with partial coverage; some review passes timed out or failed.',
          true
        );
        return;
      }

      await this.postComment(
        event,
        this.gitlabReviewService.buildNoIssuesMessage(reviewContext.headSha, {
          context: reviewContext,
          completedPasses: successfulPasses,
        })
      );
      await this.updateProgressComment(
        event,
        'Code review completed. No candidate issues were found across review passes.',
        true
      );
      return;
    }

    await this.updateProgressComment(
      event,
      `Scoring ${candidateFindings.length} candidate finding(s)...`
    );

    const scoredResults = await this.runWithConcurrency(
      candidateFindings,
      reviewSettings.scoringConcurrency,
      (finding, index) =>
        this.executeReviewScore(
          reviewInstruction,
          finding,
          index + 1,
          projectPath,
          executionContext,
          reviewContext,
          userFocus,
          callback
        )
    );

    const scoringErrors: string[] = [];
    const scoringErrorLabels: string[] = [];
    const minConfidence = reviewSettings.minConfidence;
    const scoredFindings = scoredResults
      .filter(result => {
        if (result.status === 'fulfilled') {
          return true;
        }

        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        scoringErrors.push(message);
        scoringErrorLabels.push(this.summarizeStageFailure(message));
        return false;
      })
      .map(result => (result as PromiseFulfilledResult<ReviewFinding | null>).value)
      .filter((finding: ReviewFinding | null): finding is ReviewFinding => Boolean(finding))
      .filter((finding: ReviewFinding) => finding.confidence >= minConfidence);

    if (scoredFindings.length === 0) {
      if (passErrors.length > 0 || scoringErrors.length > 0) {
        await this.postComment(
          event,
          this.gitlabReviewService.buildIncompleteReviewMessage(reviewContext.headSha, {
            context: reviewContext,
            completedPasses: successfulPasses,
            completedStages: successfulPasses.map(pass => pass.label),
            failedStages: [...passErrorLabels, ...scoringErrorLabels],
            note:
              'No high-confidence issues were confirmed from the completed stages. This should not be interpreted as a full clean review because part of the review timed out or failed.',
          })
        );
        await this.updateProgressComment(
          event,
          'Code review completed with partial coverage; some review or scoring stages timed out or failed.',
          true
        );
        return;
      }

      await this.postComment(
        event,
        this.gitlabReviewService.buildNoIssuesMessage(reviewContext.headSha, {
          context: reviewContext,
          completedPasses: successfulPasses,
          note:
            'No high-confidence issues remained after rescoring the candidate findings from the completed review stages.',
        })
      );
      await this.updateProgressComment(
        event,
        'Code review completed. Candidate issues were rescored below the confidence threshold.',
        true
      );
      return;
    }

    const latestMergeRequest = await this.gitlabService.getMergeRequest(
      reviewContext.projectId,
      reviewContext.mergeRequestIid
    );

    if (
      latestMergeRequest.state !== 'opened' ||
      (reviewSettings.skipDraft &&
        (latestMergeRequest.draft || latestMergeRequest.work_in_progress))
    ) {
      const message = 'Skipped posting code review: merge request is no longer eligible.';
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    if (latestMergeRequest.sha && latestMergeRequest.sha !== reviewContext.headSha) {
      const message = 'Skipped posting code review: merge request head changed while review was running.';
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    const alreadyReviewedLatest = await this.gitlabReviewService.hasExistingReview(
      reviewContext.projectId,
      reviewContext.mergeRequestIid,
      reviewContext.headSha
    );

    if (reviewSettings.skipExistingSha && alreadyReviewedLatest) {
      const message = 'Skipped posting code review: another review was already posted.';
      await this.postComment(event, message);
      await this.updateProgressComment(event, message, true);
      return;
    }

    const finalReview = this.gitlabReviewService.buildFinalReview(
      successfulPasses,
      scoredFindings,
      candidateFindings.length
    );

    if (passErrors.length > 0 || scoringErrors.length > 0) {
      const partialCoverageSummary = [
        `Partial coverage: ${passErrors.length} review pass(es) and ${scoringErrors.length} scoring stage(s) timed out or failed.`,
        `Affected stages: ${[...passErrorLabels, ...scoringErrorLabels].join(', ')}.`,
        finalReview.summary,
      ].join('\n\n');

      finalReview.summary = partialCoverageSummary;
    }

    await this.gitlabReviewService.postReview(event, reviewContext, finalReview);
    await this.updateProgressComment(
      event,
      `Code review completed with ${finalReview.findings.length} high-confidence finding(s).`,
      true
    );
  }

  private async executeReviewPass(
    instruction: AIInstruction,
    passId: string,
    passLabel: string,
    prompt: string,
    projectPath: string,
    executionContext: AIExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<ReviewPassResult | null> {
    const result = await this.executeWithProvider(
      instruction,
      prompt,
      projectPath,
      executionContext,
      this.buildReviewStageCallback(passLabel, callback)
    );

    if (!result.success) {
      throw new Error(`${passLabel} failed: ${result.error || 'Unknown error'}`);
    }

    const parsed = this.gitlabReviewService.parseReviewOutput(result.output || '', 0);
    return {
      passId,
      label: passLabel,
      summary: parsed.summary,
      findings: parsed.findings,
    };
  }

  private async executeReviewScore(
    instruction: AIInstruction,
    finding: ReviewFinding,
    index: number,
    projectPath: string,
    executionContext: AIExecutionContext,
    reviewContext: PreparedReviewContext,
    userFocus: string | undefined,
    callback: StreamingProgressCallback
  ): Promise<ReviewFinding | null> {
    const stageLabel = `Scorer ${index}`;
    const prompt = this.gitlabReviewService.buildScoringPrompt(reviewContext, finding, userFocus);

    const result = await this.executeWithProvider(
      instruction,
      prompt,
      projectPath,
      executionContext,
      this.buildReviewStageCallback(stageLabel, callback)
    );

    if (!result.success) {
      throw new Error(`${stageLabel} failed: ${result.error || 'Unknown error'}`);
    }

    return this.gitlabReviewService.parseScoredFinding(result.output || '', finding);
  }

  private async executeWithProvider(
    instruction: AIInstruction,
    command: string,
    projectPath: string,
    context: AIExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<any> {
    if (instruction.provider === 'codex') {
      return this.codexExecutor.executeWithStreaming(command, projectPath, context, callback);
    }

    return this.claudeExecutor.executeWithStreaming(command, projectPath, context, callback);
  }

  private buildReviewStageCallback(
    label: string,
    callback: StreamingProgressCallback
  ): StreamingProgressCallback {
    return {
      onProgress: async (message: string) => {
        await callback.onProgress(`[${label}] ${message}`, false);
      },
      onError: async (error: string) => {
        await callback.onProgress(`[${label}] ${error}`, false);
      },
    };
  }

  private summarizeStageFailure(message: string): string {
    const match = message.match(/^(.*?) failed:/);
    if (match?.[1]) {
      return match[1];
    }

    return message.length > 120 ? `${message.slice(0, 117)}...` : message;
  }

  private resolveReviewExecutionProvider(
    provider: RuntimeConfig['review']['defaultProvider']
  ): AIInstruction['provider'] {
    return provider === 'codex-multipass' ? 'codex' : 'claude';
  }

  private async runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
  ): Promise<Array<PromiseSettledResult<R>>> {
    if (items.length === 0) {
      return [];
    }

    const results: Array<PromiseSettledResult<R>> = new Array(items.length);
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    let nextIndex = 0;

    const runners = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        try {
          results[currentIndex] = {
            status: 'fulfilled',
            value: await worker(items[currentIndex] as T, currentIndex),
          };
        } catch (error) {
          results[currentIndex] = {
            status: 'rejected',
            reason: error,
          };
        }
      }
    });

    await Promise.all(runners);
    return results;
  }

  private async handleSuccess(
    event: GitLabWebhookEvent,
    instruction: AIInstruction,
    result: any,
    baseBranch: string,
    projectPath: string
  ): Promise<void> {
    const providerName = instruction.provider === 'codex' ? 'Codex' : 'Claude';

    logger.info(`${providerName} instruction executed successfully`, {
      projectId: event.project.id,
      hasChanges: result.changes?.length > 0,
      provider: instruction.provider,
    });

    let responseMessage = `**${providerName} processed your request successfully.**\n\n`;

    if (result.output) {
      const linkedOutput = await this.linkReviewOutputReferences(
        result.output,
        event,
        baseBranch,
        projectPath
      );
      responseMessage += `${linkedOutput}\n\n`;
    }

    if (result.changes?.length > 0) {
      responseMessage += `**Changes made:**\n`;
      for (const change of result.changes) {
        responseMessage += `- ${change.type}: \`${change.path}\`\n`;
      }
      responseMessage += '\n';

      // Only create branch and MR if there are actual changes
      try {
        // Generate timestamp-based branch name for Claude changes
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const claudeBranch = `claude-${timestamp}-${randomSuffix}`;

        // Create new branch for Claude changes
        await this.gitlabService.createBranch(event.project.id, claudeBranch, baseBranch);

        await this.updateProgressComment(event, `Created branch: ${claudeBranch}`);

        // Generate MR info first to get the commit message
        const mrInfo = MRGenerator.generateMR({
          instruction: instruction.command,
          context: instruction.context,
          changes: result.changes,
          projectUrl: event.project.web_url,
        });

        // Switch to the new branch and push changes with generated commit message
        await this.commitAndPushToNewBranch(event, projectPath, claudeBranch, mrInfo.commitMessage);

        const mergeRequest = await this.gitlabService.createMergeRequest(event.project.id, {
          sourceBranch: claudeBranch,
          targetBranch: baseBranch,
          title: mrInfo.title,
          description: mrInfo.description,
        });

        // Generate MR URL
        const mrUrl = `${event.project.web_url}/-/merge_requests/${mergeRequest.iid}`;

        responseMessage += `**Merge request created**\n`;
        responseMessage += `[Click here to review and merge the changes →](${mrUrl})\n\n`;
        responseMessage += `**Branch:** \`${claudeBranch}\` → \`${baseBranch}\`\n`;

        await this.updateProgressComment(event, `Created merge request: ${mrUrl}`);
      } catch (error) {
        logger.error('Failed to create branch or merge request:', error);
        responseMessage += `**Note:** Changes were made but could not create merge request: ${error instanceof Error ? error.message : String(error)}\n\n`;
      }
    } else {
      // No changes, just post the result
      responseMessage += 'No file changes were made.\n';
    }

    await this.postComment(event, responseMessage);
  }

  private async commitAndPushToNewBranch(
    event: GitLabWebhookEvent,
    projectPath: string,
    claudeBranch: string,
    commitMessage: string
  ): Promise<void> {
    try {
      // Switch to the new branch in local git
      await this.projectManager.switchToAndPushBranch(projectPath, claudeBranch, commitMessage);
    } catch (error) {
      logger.error('Failed to commit and push to new branch:', error);
      throw error;
    }
  }

  private async handleFailure(
    event: GitLabWebhookEvent,
    instruction: AIInstruction,
    result: any
  ): Promise<void> {
    const providerName = instruction.provider === 'codex' ? 'Codex' : 'Claude';

    logger.warn(`${providerName} instruction failed`, {
      projectId: event.project.id,
      error: result.error,
      provider: instruction.provider,
    });

    const responseMessage = `❌ ${providerName} encountered an error while processing your request:\n\n\`\`\`\n${result.error}\n\`\`\``;
    await this.postComment(event, responseMessage);
  }

  private async reportError(event: GitLabWebhookEvent, error: any): Promise<void> {
    const responseMessage = `🚨 Internal error occurred while processing your AI request:\n\n\`\`\`\n${error.message}\n\`\`\``;

    try {
      await this.postComment(event, responseMessage);
    } catch (commentError) {
      logger.error('Failed to post error comment:', commentError);
    }
  }

  private async postComment(event: GitLabWebhookEvent, message: string): Promise<void> {
    // If we have a discussion ID, try to post as a reply to that discussion
    if (this.currentDiscussionId) {
      try {
        switch (event.object_kind) {
          case 'issue':
          case 'note':
            if (event.issue) {
              await this.gitlabService.addIssueDiscussionReply(
                event.project.id,
                event.issue.iid,
                this.currentDiscussionId,
                message
              );
              return;
            }
            break;

          case 'merge_request':
            if (event.merge_request) {
              await this.gitlabService.addMergeRequestDiscussionReply(
                event.project.id,
                event.merge_request.iid,
                this.currentDiscussionId,
                message
              );
              return;
            }
            break;
        }
      } catch (error) {
        // Silently fallback for known unimplemented features
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('Discussion reply not implemented')) {
          logger.warn('Failed to post discussion reply, falling back to regular comment:', error);
        }
        // Continue to fallback posting method
      }
    }

    // Fallback to regular comment posting
    switch (event.object_kind) {
      case 'issue':
        if (event.issue) {
          await this.gitlabService.addIssueComment(event.project.id, event.issue.iid, message);
        }
        break;

      case 'merge_request':
        if (event.merge_request) {
          await this.gitlabService.addMergeRequestComment(
            event.project.id,
            event.merge_request.iid,
            message
          );
        }
        break;

      case 'note':
        if (event.issue) {
          await this.gitlabService.addIssueComment(event.project.id, event.issue.iid, message);
        } else if (event.merge_request) {
          await this.gitlabService.addMergeRequestComment(
            event.project.id,
            event.merge_request.iid,
            message
          );
        }
        break;
    }
  }

  private async createProgressComment(
    event: GitLabWebhookEvent,
    message: string
  ): Promise<number | null> {
    try {
      let commentId: number | null = null;

      // If we have a discussion ID, try to create progress comment as a reply to that discussion
      if (this.currentDiscussionId) {
        try {
          switch (event.object_kind) {
            case 'issue':
            case 'note':
              if (event.issue) {
                const comment = await this.gitlabService.addIssueDiscussionReply(
                  event.project.id,
                  event.issue.iid,
                  this.currentDiscussionId,
                  message
                );
                commentId = comment?.id || null;
                return commentId;
              }
              break;

            case 'merge_request':
              if (event.merge_request) {
                const comment = await this.gitlabService.addMergeRequestDiscussionReply(
                  event.project.id,
                  event.merge_request.iid,
                  this.currentDiscussionId,
                  message
                );
                commentId = comment?.id || null;
                return commentId;
              }
              break;
          }
        } catch (error) {
          // Silently fallback for known unimplemented features
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!errorMessage.includes('Discussion reply not implemented')) {
            logger.warn(
              'Failed to create discussion reply progress comment, falling back to regular comment:',
              error
            );
          }
          // Continue to fallback comment creation method
        }
      }

      // Fallback to regular comment creation
      switch (event.object_kind) {
        case 'issue':
          if (event.issue) {
            const comment = await this.gitlabService.createIssueComment(
              event.project.id,
              event.issue.iid,
              message
            );
            commentId = comment?.id || null;
          }
          break;

        case 'merge_request':
          if (event.merge_request) {
            const comment = await this.gitlabService.createMergeRequestComment(
              event.project.id,
              event.merge_request.iid,
              message
            );
            commentId = comment?.id || null;
          }
          break;

        case 'note':
          if (event.issue) {
            const comment = await this.gitlabService.createIssueComment(
              event.project.id,
              event.issue.iid,
              message
            );
            commentId = comment?.id || null;
          } else if (event.merge_request) {
            const comment = await this.gitlabService.createMergeRequestComment(
              event.project.id,
              event.merge_request.iid,
              message
            );
            commentId = comment?.id || null;
          }
          break;
      }

      return commentId;
    } catch (error) {
      logger.error('Failed to create progress comment:', error);
      return null;
    }
  }

  private progressMessages: ProgressEntry[] = [];

  private buildInitialProgressComment(providerName: string, command: string): string {
    const now = new Date();
    const task = command.length > 100 ? `${command.substring(0, 100)}...` : command;

    return formatProgressComment({
      entries: [
        {
          timestamp: now,
          status: 'queued',
          message: `${providerName} is starting to work on your request. Task: ${task}`,
        },
      ],
      updatedAt: now,
    });
  }

  private async updateProgressComment(
    event: GitLabWebhookEvent,
    message: string,
    isComplete?: boolean,
    isError?: boolean
  ): Promise<void> {
    if (!this.currentCommentId) {
      return;
    }

    try {
      // Add new message to the progress log
      const timestamp = new Date();
      const status = inferProgressStatus(message, isComplete, isError);

      // Check for duplicate messages (ignore timestamp, only check the message content)
      const isDuplicate = this.progressMessages.some(existingMsg => {
        return sanitizeProgressMessage(existingMsg.message) === sanitizeProgressMessage(message);
      });

      // Only add if not duplicate
      if (!isDuplicate) {
        this.progressMessages.push({ timestamp, status, message });
      }

      // Add the latest messages (keep last 10 to avoid too long comments)
      const recentMessages = this.progressMessages.slice(-10);
      const commentBody = formatProgressComment({
        entries: recentMessages,
        isComplete,
        isError,
        updatedAt: timestamp,
      });

      // Update the comment
      await this.updateComment(event, this.currentCommentId, commentBody);
    } catch (error) {
      logger.error('Failed to update progress comment:', error);
    }
  }

  private async linkReviewOutputReferences(
    output: string,
    event: GitLabWebhookEvent,
    baseBranch: string,
    projectPath: string
  ): Promise<string> {
    if (event.object_kind !== 'merge_request' && !event.merge_request) {
      return output;
    }

    try {
      return await linkifyReviewReferences(output, {
        projectPath,
        projectUrl: event.project.web_url,
        ref: event.merge_request?.source_branch || baseBranch,
      });
    } catch (error) {
      logger.warn('Failed to linkify review output references', {
        error: error instanceof Error ? error.message : String(error),
      });
      return output;
    }
  }

  private async updateComment(
    event: GitLabWebhookEvent,
    commentId: number,
    body: string
  ): Promise<void> {
    try {
      switch (event.object_kind) {
        case 'issue':
          if (event.issue) {
            await this.gitlabService.updateIssueComment(
              event.project.id,
              event.issue.iid,
              commentId,
              body
            );
          }
          break;

        case 'merge_request':
          if (event.merge_request) {
            await this.gitlabService.updateMergeRequestComment(
              event.project.id,
              event.merge_request.iid,
              commentId,
              body
            );
          }
          break;

        case 'note':
          if (event.issue) {
            await this.gitlabService.updateIssueComment(
              event.project.id,
              event.issue.iid,
              commentId,
              body
            );
          } else if (event.merge_request) {
            await this.gitlabService.updateMergeRequestComment(
              event.project.id,
              event.merge_request.iid,
              commentId,
              body
            );
          }
          break;
      }

      logger.info('Progress comment updated successfully', {
        commentId,
        messageLength: body.length,
      });
    } catch (error) {
      logger.error('Failed to update progress comment:', error);
      // Fallback: create a new comment if update fails
      await this.postComment(event, `**Updated Progress:**\n\n${body}`);
    }
  }
}

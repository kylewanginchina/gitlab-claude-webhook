import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
// Use dynamic import for ESM-only packages in a CommonJS project
// This bypasses the 'require' limitation for packages that don't export a CJS main
let CodexSDK: any;
const loadCodexSDK = async () => {
  if (!CodexSDK) {
    CodexSDK = await import('@openai/codex-sdk');
  }
  return CodexSDK;
};

import logger from '../utils/logger';
import {
  ProcessResult,
  FileChange,
  AIExecutionContext,
  StreamingProgressCallback,
} from '../types/common';
import { ProjectManager } from './projectManager';
import { runtimeConfigService } from '../utils/runtimeConfig';
import { ReviewCustomizationService } from '../admin/reviewCustomizationService';
import { reviewCustomizationService as defaultReviewCustomizationService } from '../utils/reviewCustomization';
import { TimeBudget, createTimeBudget } from '../utils/timeBudget';

const CODEX_EDIT_INSTRUCTIONS =
  'You are working in an automated webhook environment. This request has a hard timeout of {{timeoutMinutes}} minutes. Plan to finish substantive work within {{softDeadlineMinutes}} minutes and reserve the final {{wrapUpMinutes}} minutes to stop exploration and summarize the best supported result. Make code changes directly and provide a clear summary of what was modified. Focus on implementing requested changes efficiently. Do not perform broad searches or extensive exploration unless absolutely necessary.';

const CODEX_REVIEW_INSTRUCTIONS =
  'You are working in an automated webhook environment in read-only review mode. This request has a hard timeout of {{timeoutMinutes}} minutes. Plan to finish substantive analysis within {{softDeadlineMinutes}} minutes and reserve the final {{wrapUpMinutes}} minutes to stop exploration and produce the best supported review result. Do not modify files or git state. Prefer diff-first review, avoid broad repository exploration, focus on identifying real issues in the merge request, and return a structured review result.';

const CODEX_CONTEXT_WRAPPER =
  '{{contextBlock}}{{mrAnalysisBlock}}{{instructionsBlock}}\n**Time Budget:** Hard timeout {{timeoutMinutes}} minutes. Finish substantive work by {{softDeadlineMinutes}} minutes and reserve {{wrapUpMinutes}} minutes to summarize.\n\n**Request:** {{command}}';

export class CodexExecutor {
  private projectManager: ProjectManager;

  constructor(
    private readonly reviewCustomizationService: ReviewCustomizationService = defaultReviewCustomizationService
  ) {
    this.projectManager = new ProjectManager();
  }

  public async executeWithStreaming(
    command: string,
    projectPath: string,
    context: AIExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<ProcessResult> {
    try {
      logger.info('Starting streaming Codex execution via SDK', {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
        model: context.model,
      });

      // Post initial progress message
      await callback.onProgress('🚀 Codex is analyzing your request...', false);

      // Execute codex command with streaming via SDK
      const result = await this.runCodexWithSDK(command, projectPath, context, callback);

      // Check for file changes
      const changes = context.mode === 'review' ? [] : await this.getFileChanges(projectPath);

      if (changes.length > 0) {
        await callback.onProgress(`📝 Codex made changes to ${changes.length} file(s)`, false);
      }

      await callback.onProgress('✅ Codex execution completed successfully!', true);

      return {
        success: true,
        output: result.output,
        changes,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Streaming Codex execution failed:', error);

      // Avoid duplicate error reporting if timeout already sent an error callback
      const isAbortError = error instanceof Error && error.name === 'AbortError';
      if (!isAbortError) {
        await callback.onError(`❌ Codex execution failed: ${errorMessage}`).catch(err => {
          logger.error('Failed to send error callback:', err);
        });
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async runCodexWithSDK(
    command: string,
    projectPath: string,
    context: AIExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<{ output: string; error?: string }> {
    const runtimeConfig = runtimeConfigService.getConfig();
    const model = context.model || runtimeConfig.codex.defaultModel;
    const timeoutMs =
      context.timeoutMs || runtimeConfig.codex.defaultTimeoutMinutes * 60 * 1000;
    const timeBudget = createTimeBudget(timeoutMs);
    const fullPrompt = this.buildPromptWithContext(command, context, timeBudget);
    const reasoningEffort = runtimeConfig.codex.reasoningEffort;

    logger.info('Executing Codex via SDK', {
      model,
      cwd: projectPath,
      promptLength: fullPrompt.length,
      reasoningEffort,
    });

    // Create Codex SDK instance
    const sdk = await loadCodexSDK();
    const codex = new (sdk.Codex || sdk.default?.Codex || sdk.default || sdk)({
      apiKey: runtimeConfig.codex.apiKey,
      baseUrl: runtimeConfig.codex.baseUrl,
    });

    // Start a thread with full-auto equivalent settings
    const thread = codex.startThread({
      model,
      workingDirectory: projectPath,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      modelReasoningEffort: reasoningEffort,
    });

    // Set up abort handling
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
      callback.onError('⏰ Codex execution timed out').catch(err => {
        logger.error('Failed to send timeout error callback:', err);
      });
    }, timeoutMs);

    let lastProgressTime = Date.now();
    let lastAgentMessage = '';

    try {
      const { events } = await thread.runStreamed(fullPrompt, {
        signal: abortController.signal,
      });

      for await (const event of events) {
        const progressMessage = this.extractProgressFromEvent(event);
        if (progressMessage) {
          const now = Date.now();
          // Throttle progress updates to every 2 seconds, except for turn completion
          if (now - lastProgressTime > 2000 || event.type === 'turn.completed') {
            await callback.onProgress(progressMessage, false);
            lastProgressTime = now;
          }
        }

        // Capture the final agent message
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          lastAgentMessage = event.item.text;
        }

        // Handle errors
        if (event.type === 'turn.failed') {
          throw new Error(`Codex execution failed: ${event.error?.message || 'Unknown error'}`);
        }

        if (event.type === 'error') {
          throw new Error(`Codex stream error: ${event.message}`);
        }
      }

      return { output: lastAgentMessage || 'Codex completed execution.' };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private buildPromptWithContext(
    command: string,
    context: AIExecutionContext,
    timeBudget: TimeBudget
  ): string {
    const contextBlock =
      context.context && context.context.trim() ? `**Context:** ${context.context}\n\n` : '';

    // Special handling for MR contexts
    const isMRContext = context.context && context.context.includes('MR #');
    const mrAnalysisBlock = isMRContext
      ? `**MR Analysis:** This is a merge request context. You can use git commands to examine the changes if needed. Use 'git log', 'git diff', and 'git show' to understand what files have been modified.\n\n`
      : '';

    // Add automation context
    const instructionTemplateId =
      context.mode === 'review' ? 'codex.review.instructions' : 'codex.edit.instructions';
    const instructions = this.renderPromptTemplate(
      instructionTemplateId,
      { ...timeBudget },
      context.mode === 'review' ? CODEX_REVIEW_INSTRUCTIONS : CODEX_EDIT_INSTRUCTIONS
    );
    const instructionsBlock = `${instructions}\n\n`;

    const fullPrompt = this.renderPromptTemplate(
      'codex.context.wrapper',
      {
        context: context.context || '',
        contextBlock,
        mrAnalysisBlock,
        mode: context.mode || 'edit',
        instructions,
        instructionsBlock,
        command,
        projectUrl: context.projectUrl,
        branch: context.branch,
        ...timeBudget,
      },
      CODEX_CONTEXT_WRAPPER
    );

    logger.debug('Built Codex prompt with context', {
      hasContext: !!context.context,
      contextLength: context.context?.length || 0,
      commandLength: command.length,
      fullPromptLength: fullPrompt.length,
    });

    return fullPrompt;
  }

  private renderPromptTemplate(
    id: string,
    variables: Record<string, unknown>,
    fallback: string
  ): string {
    try {
      return this.reviewCustomizationService.renderPromptTemplate(id, variables, fallback);
    } catch (error) {
      logger.warn('Falling back to built-in Codex prompt template', {
        templateId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  private extractProgressFromEvent(event: ThreadEvent): string {
    switch (event.type) {
      case 'thread.started':
        return '🔄 Started processing...';

      case 'turn.started':
        return '🤔 Analyzing request...';

      case 'item.started':
      case 'item.completed':
        return this.extractProgressFromItem(event.item, event.type === 'item.completed');

      case 'turn.completed':
        if (event.usage) {
          return `📊 Tokens used: ${event.usage.input_tokens || 0} in, ${event.usage.output_tokens || 0} out`;
        }
        break;

      case 'turn.failed':
        return `❌ Error: ${event.error?.message || 'Unknown error'}`;

      case 'error':
        return `❌ Error: ${event.message || 'Unknown error'}`;
    }

    return '';
  }

  private extractProgressFromItem(item: ThreadItem, isCompleted: boolean): string {
    switch (item.type) {
      case 'reasoning':
        return item.text ? `💭 ${item.text}` : '';

      case 'command_execution':
        if (!isCompleted && item.status === 'in_progress') {
          return `⚙️ Running: ${item.command}`;
        } else if (isCompleted) {
          return `✓ Completed: ${item.command}`;
        }
        break;

      case 'file_change':
        if (isCompleted && item.changes) {
          const paths = (item.changes as any[]).map((c: any) => c.path).join(', ');
          return `📝 Files changed: ${paths}`;
        }
        return '📝 File changed';

      case 'agent_message':
        return ''; // Final message, don't show as progress

      case 'error':
        return `❌ ${item.message}`;
    }

    return '';
  }

  private async getFileChanges(projectPath: string): Promise<FileChange[]> {
    try {
      const changedFiles = await this.projectManager.getChangedFiles(projectPath);

      return changedFiles.map(file => ({
        path: file.path,
        type: file.type as 'modified' | 'created' | 'deleted',
      }));
    } catch (error) {
      logger.error('Error getting file changes:', error);
      return [];
    }
  }
}

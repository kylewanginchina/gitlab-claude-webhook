import { Codex, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import { config } from '../utils/config';
import logger from '../utils/logger';
import {
  ProcessResult,
  FileChange,
  AIExecutionContext,
  StreamingProgressCallback,
} from '../types/common';
import { ProjectManager } from './projectManager';

export class CodexExecutor {
  private projectManager: ProjectManager;
  private defaultTimeoutMs = 900000; // 15 minutes

  constructor() {
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
      const changes = await this.getFileChanges(projectPath);

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
    const fullPrompt = this.buildPromptWithContext(command, context);
    const model = context.model || config.openai.defaultModel;
    const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;
    const reasoningEffort = config.openai.reasoningEffort;

    logger.info('Executing Codex via SDK', {
      model,
      cwd: projectPath,
      promptLength: fullPrompt.length,
      reasoningEffort,
    });

    // Create Codex SDK instance
    const codex = new Codex({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
    });

    // Start a thread with full-auto equivalent settings
    const thread = codex.startThread({
      model,
      workingDirectory: projectPath,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      modelReasoningEffort: reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
    });

    // Set up abort handling
    const abortController = new AbortController();
    // let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      // timedOut = true;
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

  private buildPromptWithContext(command: string, context: AIExecutionContext): string {
    let fullPrompt = '';

    // Add context information if available
    if (context.context && context.context.trim()) {
      fullPrompt += `**Context:** ${context.context}\n\n`;
    }

    // Special handling for MR contexts
    const isMRContext = context.context && context.context.includes('MR #');

    if (isMRContext) {
      fullPrompt += `**MR Analysis:** This is a merge request context. You can use git commands to examine the changes if needed. Use 'git log', 'git diff', and 'git show' to understand what files have been modified.\n\n`;
    }

    // Add automation context
    fullPrompt += `You are working in an automated webhook environment. Make code changes directly and provide a clear summary of what was modified. Focus on implementing requested changes efficiently. Do not perform broad searches or extensive exploration unless absolutely necessary.\n\n`;

    // Add the main command/instruction
    fullPrompt += `**Request:** ${command}`;

    logger.debug('Built Codex prompt with context', {
      hasContext: !!context.context,
      contextLength: context.context?.length || 0,
      commandLength: command.length,
      fullPromptLength: fullPrompt.length,
    });

    return fullPrompt;
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
          const paths = item.changes.map(c => c.path).join(', ');
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

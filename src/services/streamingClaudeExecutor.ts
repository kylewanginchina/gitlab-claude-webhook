import { query, type SDKMessage, type SDKResultMessage, type SDKAssistantMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { ProcessResult, FileChange } from '../types/common';
import { ProjectManager } from './projectManager';
import { GitLabService } from './gitlabService';
import { GitLabWebhookEvent } from '../types/gitlab';

export interface ClaudeExecutionContext {
  context: string;
  projectUrl: string;
  branch: string;
  timeoutMs?: number;
  event: GitLabWebhookEvent;
  instruction: string;
  model?: string;
}

export interface StreamingProgressCallback {
  onProgress: (message: string, isComplete?: boolean) => Promise<void>;
  onError: (error: string) => Promise<void>;
}

export class StreamingClaudeExecutor {
  private projectManager: ProjectManager;
  private gitlabService: GitLabService;
  private defaultTimeoutMs = 600000; // 10 minutes

  constructor() {
    this.projectManager = new ProjectManager();
    this.gitlabService = new GitLabService();
  }

  public async executeWithStreaming(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<ProcessResult> {
    try {
      logger.info('Starting streaming Claude execution via SDK', {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
      });

      // Post initial progress message
      await callback.onProgress('🚀 Claude is analyzing your request...', false);

      // Execute claude command with streaming via SDK
      const result = await this.runClaudeWithSDK(command, projectPath, context, callback);

      // Check for file changes
      const changes = await this.getFileChanges(projectPath);

      if (changes.length > 0) {
        await callback.onProgress(`📝 Claude made changes to ${changes.length} file(s)`, false);
      }

      await callback.onProgress('✅ Claude execution completed successfully!', true);

      return {
        success: true,
        output: result.output,
        changes,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Streaming Claude execution failed:', error);

      await callback.onError(`❌ Claude execution failed: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async runClaudeWithSDK(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<{ output: string; error?: string }> {
    const fullPrompt = this.buildPromptWithContext(command, context);
    const model = context.model || config.anthropic.defaultModel;
    const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;

    const env: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_BASE_URL: config.anthropic.baseUrl,
      ANTHROPIC_API_KEY: config.anthropic.authToken,
    };

    logger.info('Executing Claude via Agent SDK', {
      model,
      cwd: projectPath,
      promptLength: fullPrompt.length,
    });

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
      callback.onError('⏰ Claude execution timed out');
    }, timeoutMs);

    let output = '';
    let lastProgressTime = Date.now();
    let queryHandle: Query | undefined;

    try {
      queryHandle = query({
        prompt: fullPrompt,
        options: {
          cwd: projectPath,
          model,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'MultiEdit', 'NotebookEdit'],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: 'You are working in an automated webhook environment. Make code changes directly without asking for permissions. For merge request contexts, use git commands to examine code changes when needed. Focus on implementing requested changes efficiently and provide a clear summary of what was modified.',
          },
          env,
          abortController,
          persistSession: false,
        },
      });

      for await (const message of queryHandle) {
        const progressMessage = this.extractProgressFromMessage(message);
        if (progressMessage) {
          const now = Date.now();
          if (now - lastProgressTime > 2000) {
            await callback.onProgress(progressMessage, false);
            lastProgressTime = now;
          }
        }

        // Capture output from assistant messages
        if (message.type === 'assistant') {
          const assistantMsg = message as SDKAssistantMessage;
          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if ('text' in block && typeof block.text === 'string') {
                output += block.text + '\n';
              }
            }
          }
        }

        // Handle result messages
        if (message.type === 'result') {
          const resultMsg = message as SDKResultMessage;
          if (resultMsg.subtype === 'success') {
            if ('result' in resultMsg && resultMsg.result) {
              output = resultMsg.result;
            }
            logger.info('Claude SDK execution completed successfully', {
              cost: resultMsg.total_cost_usd,
              turns: resultMsg.num_turns,
              durationMs: resultMsg.duration_ms,
            });
          } else {
            const errors = 'errors' in resultMsg ? resultMsg.errors : [];
            const errorStr = errors?.join('; ') || `Execution ended with status: ${resultMsg.subtype}`;
            logger.warn('Claude SDK execution ended with non-success', {
              subtype: resultMsg.subtype,
              errors,
            });
            throw new Error(`Claude execution failed: ${errorStr}`);
          }
        }
      }

      return { output: output.trim() };
    } finally {
      clearTimeout(timeoutHandle);
      if (queryHandle) {
        try {
          queryHandle.close();
        } catch {
          // Query may already be closed
        }
      }
    }
  }

  private buildPromptWithContext(command: string, context: ClaudeExecutionContext): string {
    let fullPrompt = '';

    // Add context information if available
    if (context.context && context.context.trim()) {
      fullPrompt += `**Context:** ${context.context}\n\n`;
    }

    // Special handling for MR contexts - always explore when it's MR-related
    const isMRContext = context.context && context.context.includes('MR #');

    if (isMRContext) {
      fullPrompt += `**MR Analysis:** This is a merge request context. You can use git commands to examine the changes if needed. Use 'git log', 'git diff', and 'git show' to understand what files have been modified.\n\n`;
    }

    // Add the main command/instruction
    fullPrompt += `**Request:** ${command}`;

    logger.debug('Built prompt with context', {
      hasContext: !!context.context,
      contextLength: context.context?.length || 0,
      commandLength: command.length,
      fullPromptLength: fullPrompt.length,
    });

    return fullPrompt;
  }

  private extractProgressFromMessage(message: SDKMessage): string {
    switch (message.type) {
      case 'system':
        if ('subtype' in message) {
          if (message.subtype === 'init') {
            return '🔧 Claude session initialized';
          }
        }
        break;

      case 'assistant': {
        const assistantMsg = message as SDKAssistantMessage;
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if ('type' in block && block.type === 'tool_use' && 'name' in block) {
              return `⚙️ Using tool: ${block.name}`;
            }
          }
          // Check for text content
          for (const block of assistantMsg.message.content) {
            if ('text' in block && typeof block.text === 'string') {
              const text = block.text.trim();
              if (text.length > 10 && text.length < 200) {
                return `🤖 ${text}`;
              }
            }
          }
        }
        break;
      }

      case 'tool_progress':
        if ('tool_name' in message) {
          return `⚙️ Running: ${message.tool_name}`;
        }
        break;
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

  private async commitAndPushChanges(
    projectPath: string,
    context: ClaudeExecutionContext,
    changes: FileChange[],
    callback: StreamingProgressCallback
  ): Promise<void> {
    try {
      await callback.onProgress('📤 Committing and pushing changes...', false);

      const commitMessage = `Claude: ${context.instruction.substring(0, 50)}${context.instruction.length > 50 ? '...' : ''}\n\n🤖 Generated with Claude Code Webhook`;

      // Use switchToAndPushBranch for Claude branches, commitAndPush for existing branches
      if (context.branch.startsWith('claude-')) {
        await this.projectManager.switchToAndPushBranch(projectPath, context.branch, commitMessage);
      } else {
        await this.projectManager.commitAndPush(projectPath, commitMessage, context.branch);
      }

      await callback.onProgress(
        `✅ Successfully pushed ${changes.length} file changes to ${context.branch}`,
        false
      );

      logger.info('Changes committed and pushed', {
        changesCount: changes.length,
        branch: context.branch,
      });
    } catch (error) {
      logger.error('Failed to commit and push changes:', error);
      const errorMessage = `Failed to push changes: ${error instanceof Error ? error.message : String(error)}`;
      await callback.onError(errorMessage);
      throw error;
    }
  }
}

// Compatibility wrapper for non-streaming execution
export class ClaudeExecutor {
  private streamingExecutor: StreamingClaudeExecutor;

  constructor() {
    this.streamingExecutor = new StreamingClaudeExecutor();
  }

  public async execute(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext
  ): Promise<ProcessResult> {
    // Create a simple callback that collects all messages
    let finalOutput = '';

    const callback: StreamingProgressCallback = {
      onProgress: async (message: string) => {
        finalOutput += message + '\n';
        logger.info('Claude progress:', message);
      },
      onError: async (error: string) => {
        finalOutput += `ERROR: ${error}\n`;
        logger.error('Claude error:', error);
      },
    };

    const result = await this.streamingExecutor.executeWithStreaming(
      command,
      projectPath,
      context,
      callback
    );

    // Include progress messages in output
    if (finalOutput && result.success) {
      result.output = `${finalOutput}\n${result.output || ''}`;
    }

    return result;
  }

  public async executeWithCommit(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext
  ): Promise<ProcessResult> {
    // For backward compatibility, use the streaming version
    return this.execute(command, projectPath, context);
  }
}

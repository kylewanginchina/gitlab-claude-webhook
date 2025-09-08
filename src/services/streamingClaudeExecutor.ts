import { spawn } from 'child_process';
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
      logger.info('Starting streaming Claude execution', {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
      });

      // Check if claude CLI is available
      await this.checkClaudeCliAvailability();

      // Post initial progress message
      await callback.onProgress('🚀 Claude is analyzing your request...', false);

      // Execute claude command with streaming
      const result = await this.runClaudeCommandStreaming(command, projectPath, context, callback);

      // Check for file changes
      const changes = await this.getFileChanges(projectPath);

      if (changes.length > 0) {
        await callback.onProgress(`📝 Claude made changes to ${changes.length} file(s)`, false);
        // Don't commit here - let EventProcessor handle branch creation and commit
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

  private async checkClaudeCliAvailability(): Promise<void> {
    return new Promise((resolve, reject) => {
      const childProcess = spawn('claude', ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let error = '';

      childProcess.stdout?.on('data', data => {
        output += data.toString();
      });

      childProcess.stderr?.on('data', data => {
        error += data.toString();
      });

      childProcess.on('close', code => {
        logger.info('Claude CLI availability check', {
          code,
          output: output.trim(),
          error: error.trim(),
          userId: process.getuid?.(),
          userName: process.env.USER || 'unknown',
        });

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude CLI not found or not working: ${error || 'Unknown error'}`));
        }
      });

      childProcess.on('error', err => {
        reject(new Error(`Failed to check Claude CLI: ${err.message}`));
      });
    });
  }

  private async runClaudeCommandStreaming(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<{ output: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: config.anthropic.baseUrl,
        ANTHROPIC_AUTH_TOKEN: config.anthropic.authToken,
      };

      // Build the complete prompt with context
      const fullPrompt = this.buildPromptWithContext(command, context);

      // Use proper Claude Code CLI arguments with correct parameter names
      const claudeArgs = [
        '--print', // Non-interactive mode, print response and exit
        '--output-format',
        'text', // Text output format
        '--dangerously-skip-permissions', // Required for automated execution without user prompts
        '--allowed-tools', // Correct parameter name (with hyphen)
        'Bash,Read,Write,Edit,Glob,Grep,LS,MultiEdit,NotebookEdit', // Specify allowed tools
        '--model',
        'claude-sonnet-4-20250514', // Specify the model to use
        '--append-system-prompt',
        'You are working in an automated webhook environment. Make code changes ' +
          'directly without asking for permissions. For merge request contexts, use git ' +
          'commands to examine code changes when needed. Focus on implementing requested ' +
          'changes efficiently and provide a clear summary of what was modified.', // Additional system prompt
        fullPrompt, // The complete prompt including context
      ];

      // Log the exact command being executed for debugging
      const fullCommand = `claude ${claudeArgs
        .map(arg => (arg.includes(' ') ? `"${arg}"` : arg))
        .join(' ')}`;
      logger.debug(`[FULL CLAUDE COMMAND] ${fullCommand}`);
      logger.info('Executing Claude Code CLI', {
        command: 'claude',
        args: claudeArgs,
        fullCommand,
        cwd: projectPath,
        userId: process.getuid?.(),
        userName: process.env.USER || 'unknown',
      });

      const claudeProcess = spawn('claude', claudeArgs, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';
      let lastProgressTime = Date.now();
      let progressBuffer = '';
      // eslint-disable-next-line prefer-const
      let timeoutHandle: NodeJS.Timeout;

      // Set timeout
      const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;
      // eslint-disable-next-line prefer-const
      timeoutHandle = setTimeout(() => {
        claudeProcess.kill('SIGTERM');
        callback.onError('⏰ Claude execution timed out');
        reject(new Error(`Claude execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Handle streaming stdout
      claudeProcess.stdout?.on('data', async data => {
        const chunk = data.toString();
        output += chunk;
        progressBuffer += chunk;

        // Log raw output for debugging intermittent issues
        console.log(`[CLAUDE STDOUT] ${chunk.trim()}`); // Force console output
        logger.debug('Claude stdout chunk', {
          chunk: chunk.trim(),
          chunkLength: chunk.length
        });

        // Send progress updates every 2 seconds or when we have substantial output
        const now = Date.now();
        if (now - lastProgressTime > 2000 || progressBuffer.length > 500) {
          const progressMessage = this.extractProgressMessage(progressBuffer);
          if (progressMessage) {
            await callback.onProgress(progressMessage, false);
          }

          progressBuffer = '';
          lastProgressTime = now;
        }
      });

      claudeProcess.stderr?.on('data', async data => {
        const errorChunk = data.toString();
        errorOutput += errorChunk;
        console.log(`[CLAUDE STDERR] ${errorChunk.trim()}`); // Force console output
        logger.debug('Claude stderr:', errorChunk);

        // Stream error output to user immediately with more context
        if (errorChunk.trim()) {
          await callback.onProgress(`⚠️ Error: ${errorChunk.trim()}`, false);
        }
      });

      claudeProcess.on('close', async code => {
        clearTimeout(timeoutHandle);

        // Send final progress if any remaining
        if (progressBuffer.trim()) {
          const finalMessage = this.extractProgressMessage(progressBuffer);
          if (finalMessage) {
            await callback.onProgress(finalMessage, false);
          }
        }

        if (code === 0) {
          logger.info('Claude command executed successfully', {
            outputLength: output.length,
            projectPath,
          });
          resolve({ output: output.trim() });
        } else {
          // Enhanced error message handling - check entire output for error information
          let errorMessage = errorOutput.trim();
          if (!errorMessage) {
            // Check entire stdout for error information, not just last few lines
            const outputLower = output.toLowerCase();
            if (
              outputLower.includes('error') ||
              outputLower.includes('failed') ||
              outputLower.includes('exception')
            ) {
              // Find error-related lines in the output
              const lines = output.split('\n');
              const errorLines = lines.filter(line => {
                const lineLower = line.toLowerCase();
                return (
                  lineLower.includes('error') ||
                  lineLower.includes('failed') ||
                  lineLower.includes('exception')
                );
              });

              if (errorLines.length > 0) {
                errorMessage = errorLines.join('\n');
              } else {
                // Fallback to last portion of output
                errorMessage = output.slice(-500).trim() || `Command exited with code ${code}`;
              }
            } else {
              errorMessage =
                `Command exited with code ${code}. Output: ${
                  output.slice(-200).trim() || 'No output'
                }`;
            }
          }

          logger.warn('Claude command failed', {
            code,
            error: errorMessage,
            stdout: output.slice(-500), // Last 500 chars of stdout for debugging
            fullOutput: output, // Include full output for debugging intermittent issues
            projectPath,
          });

          reject(new Error(`Claude execution failed (code ${code}): ${errorMessage}`));
        }
      });

      claudeProcess.on('error', err => {
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to execute Claude: ${err.message}`));
      });

      claudeProcess.stdin?.end();
    });
  }

  private buildPromptWithContext(command: string, context: ClaudeExecutionContext): string {
    let fullPrompt = '';

    // Add context information if available
    if (context.context && context.context.trim()) {
      fullPrompt += `**Context:** ${context.context}\n\n`;
    }

    // Detect if the request involves code analysis or exploration
    const analysisKeywords = [
      'introduce',
      'explain',
      'analyze',
      'understand',
      'review',
      'describe',
      'show',
      'list',
      'find',
      'search',
      'what',
      'how',
      'overview',
      'structure',
      '介绍',
      '解释',
      '分析',
      '理解',
      '审查',
      '描述',
      '显示',
      '列出',
      '查找',
      '搜索',
      '概述',
      '结构',
    ];

    const needsExploration = analysisKeywords.some(keyword =>
      command.toLowerCase().includes(keyword)
    );

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
      needsExploration,
      fullPromptLength: fullPrompt.length,
    });

    return fullPrompt;
  }

  private extractProgressMessage(buffer: string): string {
    // Extract meaningful progress messages from Claude output
    const lines = buffer.split('\n').filter(line => line.trim());
    const lastLine = lines[lines.length - 1];

    // Filter out common debug/verbose messages and extract meaningful ones
    if (
      lastLine &&
      !lastLine.includes('DEBUG') &&
      !lastLine.includes('INFO') &&
      lastLine.length > 10 &&
      lastLine.length < 200
    ) {
      // Filter out generic/unhelpful error messages that don't provide useful information
      const lastLineLower = lastLine.toLowerCase().trim();
      if (
        lastLineLower === 'execution error' ||
        lastLineLower === 'error' ||
        lastLineLower === 'failed'
      ) {
        return ''; // Skip generic error messages without context
      }

      // Include specific error messages that provide useful context
      const isError =
        lastLineLower.includes('error') ||
        lastLineLower.includes('failed') ||
        lastLineLower.includes('exception');

      if (isError) {
        return `❌ ${lastLine.trim()}`;
      } else {
        return `🤖 ${lastLine.trim()}`;
      }
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

      const commitMessage = `Claude: ${context.instruction.substring(0, 50)}${
        context.instruction.length > 50 ? '...' : ''
      }\n\n🤖 Generated with Claude Code Webhook`;

      // Use switchToAndPushBranch for Claude branches, commitAndPush for existing branches
      if (context.branch.startsWith('claude-')) {
        await this.projectManager.switchToAndPushBranch(
          projectPath,
          context.branch,
          commitMessage
        );
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
      const errorMessage = `Failed to push changes: ${
        error instanceof Error ? error.message : String(error)
      }`;
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

import { spawn } from 'child_process';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { ProcessResult, FileChange } from '../types/common';
import { ProjectManager } from './projectManager';
import { GitLabWebhookEvent } from '../types/gitlab';

export interface CodexExecutionContext {
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

interface CodexJSONEvent {
  type: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    status?: string;
    exit_code?: number;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: string;
}

export class CodexExecutor {
  private projectManager: ProjectManager;
  private defaultTimeoutMs = 900000; // 15 minutes

  constructor() {
    this.projectManager = new ProjectManager();
  }

  public async executeWithStreaming(
    command: string,
    projectPath: string,
    context: CodexExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<ProcessResult> {
    try {
      logger.info('Starting streaming Codex execution', {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
        model: context.model,
      });

      // Check if codex CLI is available
      await this.checkCodexCliAvailability();

      // Post initial progress message
      await callback.onProgress('🚀 Codex is analyzing your request...', false);

      // Execute codex command with streaming
      const result = await this.runCodexCommandStreaming(command, projectPath, context, callback);

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

      await callback.onError(`❌ Codex execution failed: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async checkCodexCliAvailability(): Promise<void> {
    return new Promise((resolve, reject) => {
      const childProcess = spawn('codex', ['--version'], {
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
        logger.info('Codex CLI availability check', {
          code,
          output: output.trim(),
          error: error.trim(),
          userId: process.getuid?.(),
          userName: process.env.USER || 'unknown',
        });

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Codex CLI not found or not working: ${error || 'Unknown error'}`));
        }
      });

      childProcess.on('error', err => {
        reject(new Error(`Failed to check Codex CLI: ${err.message}`));
      });
    });
  }

  private async runCodexCommandStreaming(
    command: string,
    projectPath: string,
    context: CodexExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<{ output: string; error?: string }> {
    return new Promise((resolve, reject) => {
      // Set up environment with API key
      const env: NodeJS.ProcessEnv = {
        ...process.env,
      };

      // Use CODEX_API_KEY or OPENAI_API_KEY for authentication
      const apiKey = config.openai.apiKey;
      if (apiKey) {
        env.CODEX_API_KEY = apiKey;
      }

      // Build the complete prompt with context
      const fullPrompt = this.buildPromptWithContext(command, context);

      // Determine the model to use
      const model = context.model || config.openai.defaultModel;

      // Build Codex CLI arguments for non-interactive execution
      // --dangerously-bypass-approvals-and-sandbox includes full-auto behavior
      const codexArgs = [
        'exec',
        '--json', // JSONL output for streaming
        '--dangerously-bypass-approvals-and-sandbox', // Bypass sandbox and approvals (includes full-auto)
        '--model',
        model,
        '--skip-git-repo-check', // Allow running outside git repos if needed
        fullPrompt,
      ];

      // Log the exact command being executed for debugging
      const fullCommand = `codex ${codexArgs.map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
      logger.debug(`[FULL CODEX COMMAND] ${fullCommand}`);
      logger.info('Executing Codex CLI', {
        command: 'codex',
        args: codexArgs,
        model,
        cwd: projectPath,
        userId: process.getuid?.(),
        userName: process.env.USER || 'unknown',
      });

      const codexProcess = spawn('codex', codexArgs, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';
      let lastProgressTime = Date.now();
      let lastAgentMessage = '';
      // eslint-disable-next-line prefer-const
      let timeoutHandle: NodeJS.Timeout;

      // Set timeout
      const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;
      // eslint-disable-next-line prefer-const
      timeoutHandle = setTimeout(() => {
        codexProcess.kill('SIGTERM');
        callback.onError('⏰ Codex execution timed out');
        reject(new Error(`Codex execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Handle streaming stdout (JSONL format)
      codexProcess.stdout?.on('data', async data => {
        const chunk = data.toString();
        output += chunk;

        // Log raw output for debugging
        logger.debug('Codex stdout chunk', {
          chunk: chunk.trim(),
          chunkLength: chunk.length,
        });

        // Parse JSONL events
        const lines = chunk.split('\n').filter((line: string) => line.trim());
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as CodexJSONEvent;
            const progressMessage = this.extractProgressFromEvent(event);

            if (progressMessage) {
              const now = Date.now();
              // Throttle progress updates to every 2 seconds
              if (now - lastProgressTime > 2000 || event.type === 'turn.completed') {
                await callback.onProgress(progressMessage, false);
                lastProgressTime = now;
              }
            }

            // Capture the final agent message
            if (event.item?.type === 'agent_message' && event.item?.text) {
              lastAgentMessage = event.item.text;
            }
          } catch {
            // Not valid JSON, might be partial line
            logger.debug('Could not parse Codex JSONL line:', line);
          }
        }
      });

      codexProcess.stderr?.on('data', async data => {
        const errorChunk = data.toString();
        errorOutput += errorChunk;
        logger.debug('Codex stderr:', errorChunk);

        // Stream error output to user immediately
        if (errorChunk.trim()) {
          await callback.onProgress(`⚠️ ${errorChunk.trim()}`, false);
        }
      });

      codexProcess.on('close', async code => {
        clearTimeout(timeoutHandle);

        if (code === 0) {
          logger.info('Codex command executed successfully', {
            outputLength: output.length,
            projectPath,
          });
          resolve({ output: lastAgentMessage || output.trim() });
        } else {
          // Enhanced error message handling
          let errorMessage = errorOutput.trim();
          if (!errorMessage) {
            errorMessage = `Command exited with code ${code}. Output: ${output.slice(-200).trim() || 'No output'}`;
          }

          logger.warn('Codex command failed', {
            code,
            error: errorMessage,
            stdout: output.slice(-500),
            projectPath,
          });

          reject(new Error(`Codex execution failed (code ${code}): ${errorMessage}`));
        }
      });

      codexProcess.on('error', err => {
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to execute Codex: ${err.message}`));
      });

      codexProcess.stdin?.end();
    });
  }

  private buildPromptWithContext(command: string, context: CodexExecutionContext): string {
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

  private extractProgressFromEvent(event: CodexJSONEvent): string {
    switch (event.type) {
      case 'thread.started':
        return '🔄 Started processing...';

      case 'turn.started':
        return '🤔 Analyzing request...';

      case 'item.started':
      case 'item.completed':
        if (event.item) {
          switch (event.item.type) {
            case 'reasoning':
              return event.item.text ? `💭 ${event.item.text}` : '';
            case 'command_execution':
              if (event.item.status === 'in_progress') {
                return `⚙️ Running: ${event.item.command}`;
              } else if (event.item.status === 'completed') {
                return `✓ Completed: ${event.item.command}`;
              }
              break;
            case 'file_change':
              return `📝 File changed`;
            case 'agent_message':
              return ''; // Final message, don't show as progress
          }
        }
        break;

      case 'turn.completed':
        if (event.usage) {
          return `📊 Tokens used: ${event.usage.input_tokens || 0} in, ${event.usage.output_tokens || 0} out`;
        }
        break;

      case 'error':
        return `❌ Error: ${event.error || 'Unknown error'}`;
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

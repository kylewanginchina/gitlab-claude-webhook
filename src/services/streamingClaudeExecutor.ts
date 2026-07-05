import {
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKAssistantMessage,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';
import logger from '../utils/logger';
import {
  ProcessResult,
  FileChange,
  AIExecutionContext,
  StreamingProgressCallback,
} from '../types/common';
import { ProjectManager } from './projectManager';
import { runtimeConfigService } from '../utils/runtimeConfig';

export class StreamingClaudeExecutor {
  private projectManager: ProjectManager;

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
      const changes = context.mode === 'review' ? [] : await this.getFileChanges(projectPath);

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

      // Avoid duplicate error reporting if timeout already sent an error callback
      const isAbortError = error instanceof Error && error.name === 'AbortError';
      if (!isAbortError) {
        await callback.onError(`❌ Claude execution failed: ${errorMessage}`).catch(err => {
          logger.error('Failed to send error callback:', err);
        });
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async runClaudeWithSDK(
    command: string,
    projectPath: string,
    context: AIExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<{ output: string; error?: string }> {
    const fullPrompt = this.buildPromptWithContext(command, context);
    const runtimeConfig = runtimeConfigService.getConfig();
    const model = context.model || runtimeConfig.claude.defaultModel;
    const timeoutMs =
      context.timeoutMs || runtimeConfig.claude.defaultTimeoutMinutes * 60 * 1000;
    const isReviewMode = context.mode === 'review';

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      ANTHROPIC_BASE_URL: runtimeConfig.claude.baseUrl,
      ANTHROPIC_API_KEY: runtimeConfig.claude.authToken,
    };

    logger.info('Executing Claude via Agent SDK', {
      model,
      cwd: projectPath,
      promptLength: fullPrompt.length,
    });

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
      callback.onError('⏰ Claude execution timed out').catch(err => {
        logger.error('Failed to send timeout error callback:', err);
      });
    }, timeoutMs);

    let output = '';
    const startedAt = Date.now();
    let lastProgressTime = Date.now();
    let lastActivityDescription = 'Claude is analyzing the request';
    const heartbeatHandle = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressTime < 120000) {
        return;
      }

      const heartbeat = `⏳ Still working: ${this.normalizeProgressForHeartbeat(
        lastActivityDescription
      )} (${this.formatElapsed((now - startedAt) / 1000)} elapsed)`;

      callback.onProgress(heartbeat, false).catch(err => {
        logger.error('Failed to send Claude heartbeat callback:', err);
      });
      lastProgressTime = now;
    }, 30000);
    let queryHandle: Query | undefined;

    try {
      queryHandle = query({
        prompt: fullPrompt,
        options: {
          cwd: projectPath,
          model,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: isReviewMode
            ? ['Bash', 'Read', 'Glob', 'Grep']
            : { type: 'preset', preset: 'claude_code' },
          ...(isReviewMode
            ? {
                disallowedTools: [
                  'Task',
                  'Agent',
                  'WebFetch',
                  'WebSearch',
                  'Write',
                  'Edit',
                  'MultiEdit',
                  'NotebookEdit',
                  'TodoWrite',
                ],
              }
            : {}),
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append:
              isReviewMode
                ? 'You are working in an automated webhook environment in read-only review mode. Do not modify files or git state. Do not use Task, Agent, WebFetch, or WebSearch. Use only local repository inspection tools such as Bash, Read, Glob, and Grep. For merge request contexts, use git commands to inspect changes, history, and blame when needed. Return a concise, structured review result.'
                : 'You are working in an automated webhook environment. Make code changes directly without asking for permissions. For merge request contexts, use git commands to examine code changes when needed. Focus on implementing requested changes efficiently and provide a clear summary of what was modified.',
          },
          env,
          abortController,
        },
      });

      for await (const message of queryHandle) {
        const progressMessage = this.extractProgressFromMessage(message);
        if (progressMessage) {
          const now = Date.now();
          lastActivityDescription = progressMessage;
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
            if ('result' in resultMsg && resultMsg.result && String(resultMsg.result).trim()) {
              output = String(resultMsg.result);
            }
            logger.info('Claude SDK execution completed successfully', {
              cost: resultMsg.total_cost_usd,
              turns: resultMsg.num_turns,
              durationMs: resultMsg.duration_ms,
            });
          } else {
            const errors = 'errors' in resultMsg ? resultMsg.errors : [];
            const errorStr =
              errors?.join('; ') || `Execution ended with status: ${resultMsg.subtype}`;
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
      clearInterval(heartbeatHandle);
      if (queryHandle) {
        try {
          await queryHandle.return(undefined);
        } catch {
          // Query may already be closed
        }
      }
    }
  }

  private buildPromptWithContext(command: string, context: AIExecutionContext): string {
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

    if (context.mode === 'review') {
      fullPrompt +=
        '**Execution Mode:** Review only. Do not edit files, do not create commits, and do not change repository state.\n\n';
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
          if (message.subtype === 'task_started') {
            const description = 'description' in message ? String(message.description || '') : '';
            return description ? `🧩 Started subtask: ${description}` : '🧩 Started subtask';
          }
          if (message.subtype === 'task_notification') {
            const summary = 'summary' in message ? String(message.summary || '') : '';
            const status = 'status' in message ? String(message.status || '') : 'completed';
            return summary ? `🧩 Subtask ${status}: ${summary}` : `🧩 Subtask ${status}`;
          }
        }
        break;

      case 'assistant': {
        const assistantMsg = message as SDKAssistantMessage;
        if (assistantMsg.message?.content) {
          let textProgress = '';
          for (const block of assistantMsg.message.content) {
            if ('type' in block && block.type === 'tool_use' && 'name' in block) {
              const input = 'input' in block ? block.input : undefined;
              return this.formatToolProgress(String(block.name), input);
            }
            if (!textProgress && 'text' in block && typeof block.text === 'string') {
              const text = block.text.trim();
              if (text.length > 10 && text.length < 200) {
                textProgress = `🤖 ${text}`;
              }
            }
          }
          if (textProgress) {
            return textProgress;
          }
        }
        break;
      }

      case 'tool_progress':
        if ('tool_name' in message) {
          const elapsedSeconds =
            'elapsed_time_seconds' in message ? Number(message.elapsed_time_seconds) : 0;
          if (elapsedSeconds >= 60) {
            return `⏳ ${message.tool_name} still running (${this.formatElapsed(elapsedSeconds)})`;
          }
          return `⚙️ Running: ${message.tool_name}`;
        }
        break;

      case 'tool_use_summary':
        if ('summary' in message && typeof message.summary === 'string') {
          return `📝 ${message.summary.trim()}`;
        }
        break;
    }

    return '';
  }

  private formatToolProgress(name: string, input: unknown): string {
    const record = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

    switch (name) {
      case 'Read': {
        const filePath = this.truncateValue(record.file_path);
        return filePath ? `📖 Read ${filePath}` : '📖 Read file';
      }

      case 'Glob': {
        const pattern = this.truncateValue(record.pattern);
        const basePath = this.truncateValue(record.path);
        if (pattern && basePath) {
          return `🗂️ Glob ${pattern} in ${basePath}`;
        }
        return pattern ? `🗂️ Glob ${pattern}` : '🗂️ Glob files';
      }

      case 'Grep': {
        const pattern = this.truncateValue(record.pattern);
        const basePath = this.truncateValue(record.path);
        if (pattern && basePath) {
          return `🔎 Grep ${pattern} in ${basePath}`;
        }
        return pattern ? `🔎 Grep ${pattern}` : '🔎 Grep files';
      }

      case 'Bash': {
        const command = this.truncateValue(record.command, 100);
        return command ? `💻 Bash ${command}` : '💻 Bash command';
      }

      case 'WebFetch': {
        const url = this.truncateValue(record.url, 100);
        return url ? `🌐 WebFetch ${url}` : '🌐 WebFetch';
      }

      case 'Task':
      case 'Agent': {
        const description = this.truncateValue(record.description);
        return description ? `🧩 ${name} ${description}` : `🧩 ${name}`;
      }

      default:
        return `⚙️ Using tool: ${name}`;
    }
  }

  private truncateValue(value: unknown, maxLength = 80): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
  }

  private formatElapsed(elapsedSeconds: number): string {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = Math.floor(elapsedSeconds % 60);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  private normalizeProgressForHeartbeat(message: string): string {
    return message
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/^Still working:\s*/i, '')
      .trim();
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

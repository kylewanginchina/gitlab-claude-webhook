import {
  query,
  type SDKResultMessage,
  type SDKAssistantMessage,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { ProcessResult, FileChange } from '../types/common';
import { ProjectManager } from './projectManager';

export interface ClaudeExecutionContext {
  context: string;
  projectUrl: string;
  branch: string;
  timeoutMs?: number;
}

export class ClaudeExecutor {
  private projectManager: ProjectManager;
  private defaultTimeoutMs = 300000; // 5 minutes

  constructor() {
    this.projectManager = new ProjectManager();
  }

  public async execute(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext
  ): Promise<ProcessResult> {
    try {
      logger.info('Executing Claude command via SDK', {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
      });

      // Execute claude command via SDK
      const result = await this.runClaudeWithSDK(command, projectPath, context);

      // Check for file changes
      const changes = await this.getFileChanges(projectPath);

      return {
        success: true,
        output: result.output,
        changes,
      };
    } catch (error) {
      logger.error('Claude execution failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runClaudeWithSDK(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext
  ): Promise<{ output: string; error?: string }> {
    const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;

    const env: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_BASE_URL: config.anthropic.baseUrl,
      ANTHROPIC_API_KEY: config.anthropic.authToken,
    };

    // Build prompt with context
    let prompt = command;
    if (context.context) {
      prompt = `Context: ${context.context}\nProject: ${context.projectUrl}\nBranch: ${context.branch}\n\n${command}`;
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    let output = '';
    let queryHandle: Query | undefined;

    try {
      queryHandle = query({
        prompt,
        options: {
          cwd: projectPath,
          model: config.anthropic.defaultModel,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          env,
          abortController,
          persistSession: false,
        },
      });

      for await (const message of queryHandle) {
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
            logger.info('Claude command executed successfully via SDK', {
              outputLength: output.length,
              projectPath,
            });
          } else {
            const errors = 'errors' in resultMsg ? resultMsg.errors : [];
            throw new Error(
              `Claude execution failed (${resultMsg.subtype}): ${errors?.join('; ') || 'No error output'}`
            );
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

  public async executeWithCommit(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext,
    commitMessage?: string
  ): Promise<ProcessResult> {
    const result = await this.execute(command, projectPath, context);

    if (result.success && result.changes && result.changes.length > 0) {
      try {
        const message =
          commitMessage || `Claude: ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`;

        await this.projectManager.commitAndPush(projectPath, message, context.branch);

        logger.info('Changes committed and pushed', {
          changesCount: result.changes.length,
          branch: context.branch,
        });
      } catch (error) {
        logger.error('Failed to commit and push changes:', error);
        result.error = `Execution successful but failed to push changes: ${error instanceof Error ? error.message : String(error)}`;
        result.success = false;
      }
    }

    return result;
  }
}

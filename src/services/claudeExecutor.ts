import { spawn, ChildProcess } from 'child_process';
import path from 'path';
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
      logger.info('Executing Claude command', {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
      });

      // Check if claude CLI is available
      await this.checkClaudeCliAvailability();

      // Execute claude command
      const result = await this.runClaudeCommand(command, projectPath, context);

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
        error: error.message,
      };
    }
  }

  private async checkClaudeCliAvailability(): Promise<void> {
    return new Promise((resolve, reject) => {
      const process = spawn('claude', ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let error = '';

      process.stdout?.on('data', (data) => {
        output += data.toString();
      });

      process.stderr?.on('data', (data) => {
        error += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          logger.debug('Claude CLI is available', { version: output.trim() });
          resolve();
        } else {
          reject(new Error(`Claude CLI not found or not working: ${error || 'Unknown error'}`));
        }
      });

      process.on('error', (err) => {
        reject(new Error(`Failed to check Claude CLI: ${err.message}`));
      });
    });
  }

  private async runClaudeCommand(
    command: string,
    projectPath: string,
    context: ClaudeExecutionContext
  ): Promise<{ output: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: config.anthropic.baseUrl,
        ANTHROPIC_AUTH_TOKEN: config.anthropic.authToken,
      };

      // Prepare claude command with context
      const claudeArgs = [
        '--non-interactive',
        command,
      ];

      const claudeProcess = spawn('claude', claudeArgs, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';
      let timeoutHandle: NodeJS.Timeout;

      // Set timeout
      const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;
      timeoutHandle = setTimeout(() => {
        claudeProcess.kill('SIGTERM');
        reject(new Error(`Claude execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      claudeProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });

      claudeProcess.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      claudeProcess.on('close', (code) => {
        clearTimeout(timeoutHandle);
        
        if (code === 0) {
          logger.info('Claude command executed successfully', {
            outputLength: output.length,
            projectPath,
          });
          resolve({ output: output.trim() });
        } else {
          logger.warn('Claude command failed with non-zero exit code', {
            code,
            error: errorOutput,
            projectPath,
          });
          reject(new Error(`Claude execution failed (code ${code}): ${errorOutput || 'No error output'}`));
        }
      });

      claudeProcess.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to execute Claude: ${err.message}`));
      });

      // Provide context to claude if needed
      if (context.context) {
        const contextMessage = `Context: ${context.context}\\nProject: ${context.projectUrl}\\nBranch: ${context.branch}\\n\\n`;
        claudeProcess.stdin?.write(contextMessage);
      }

      claudeProcess.stdin?.end();
    });
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
        const message = commitMessage || `Claude: ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`;
        
        await this.projectManager.commitAndPush(
          projectPath,
          message,
          context.branch
        );

        logger.info('Changes committed and pushed', {
          changesCount: result.changes.length,
          branch: context.branch,
        });
      } catch (error) {
        logger.error('Failed to commit and push changes:', error);
        result.error = `Execution successful but failed to push changes: ${error.message}`;
        result.success = false;
      }
    }

    return result;
  }
}
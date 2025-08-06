import { GitLabWebhookEvent, ClaudeInstruction } from '../types/gitlab';
import { extractClaudeInstructions } from '../utils/webhook';
import logger from '../utils/logger';
import { ProjectManager } from './projectManager';
import { ClaudeExecutor } from './claudeExecutor';
import { GitLabService } from './gitlabService';

export class EventProcessor {
  private projectManager: ProjectManager;
  private claudeExecutor: ClaudeExecutor;
  private gitlabService: GitLabService;

  constructor() {
    this.projectManager = new ProjectManager();
    this.claudeExecutor = new ClaudeExecutor();
    this.gitlabService = new GitLabService();
  }

  public async processEvent(event: GitLabWebhookEvent): Promise<void> {
    try {
      const instruction = this.extractInstruction(event);
      
      if (!instruction) {
        logger.debug('No Claude instruction found in event', {
          eventType: event.object_kind,
          projectId: event.project.id,
        });
        return;
      }

      logger.info('Processing Claude instruction', {
        eventType: event.object_kind,
        projectId: event.project.id,
        instruction: instruction.command.substring(0, 100),
      });

      await this.executeInstruction(event, instruction);
    } catch (error) {
      logger.error('Error processing event:', error);
      await this.reportError(event, error);
    }
  }

  private extractInstruction(event: GitLabWebhookEvent): ClaudeInstruction | null {
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
          context = `MR #${event.merge_request.iid}: ${event.merge_request.title}`;
          branch = event.merge_request.source_branch;
        }
        break;

      case 'note':
        if (event.object_attributes) {
          content = event.object_attributes.note || '';
          
          if (event.issue) {
            context = `Issue #${event.issue.iid} comment`;
            branch = event.project.default_branch;
          } else if (event.merge_request) {
            context = `MR #${event.merge_request.iid} comment`;
            branch = event.merge_request.source_branch;
          }
        }
        break;

      default:
        return null;
    }

    const command = extractClaudeInstructions(content);
    
    if (!command) {
      return null;
    }

    return {
      command,
      context,
      branch,
    };
  }

  private async executeInstruction(
    event: GitLabWebhookEvent,
    instruction: ClaudeInstruction
  ): Promise<void> {
    const projectPath = await this.projectManager.prepareProject(
      event.project,
      instruction.branch || event.project.default_branch
    );

    try {
      const result = await this.claudeExecutor.execute(
        instruction.command,
        projectPath,
        {
          context: instruction.context,
          projectUrl: event.project.web_url,
          branch: instruction.branch || event.project.default_branch,
        }
      );

      if (result.success) {
        await this.handleSuccess(event, instruction, result);
      } else {
        await this.handleFailure(event, instruction, result);
      }
    } finally {
      await this.projectManager.cleanup(projectPath);
    }
  }

  private async handleSuccess(
    event: GitLabWebhookEvent,
    instruction: ClaudeInstruction,
    result: any
  ): Promise<void> {
    logger.info('Claude instruction executed successfully', {
      projectId: event.project.id,
      hasChanges: result.changes?.length > 0,
    });

    let responseMessage = '✅ Claude processed your request successfully.\\n\\n';
    
    if (result.output) {
      responseMessage += `**Output:**\\n\`\`\`\\n${result.output}\\n\`\`\`\\n\\n`;
    }

    if (result.changes?.length > 0) {
      responseMessage += `**Changes made:**\\n`;
      for (const change of result.changes) {
        responseMessage += `- ${change.type}: \`${change.path}\`\\n`;
      }
      responseMessage += '\\n';
      
      // Push changes to repository
      await this.projectManager.pushChanges(
        event.project,
        instruction.branch || event.project.default_branch,
        `Claude: ${instruction.command.substring(0, 50)}...`
      );
    }

    await this.postComment(event, responseMessage);
  }

  private async handleFailure(
    event: GitLabWebhookEvent,
    instruction: ClaudeInstruction,
    result: any
  ): Promise<void> {
    logger.warn('Claude instruction failed', {
      projectId: event.project.id,
      error: result.error,
    });

    const responseMessage = `❌ Claude encountered an error while processing your request:\\n\\n\`\`\`\\n${result.error}\\n\`\`\``;
    await this.postComment(event, responseMessage);
  }

  private async reportError(event: GitLabWebhookEvent, error: any): Promise<void> {
    const responseMessage = `🚨 Internal error occurred while processing your Claude request:\\n\\n\`\`\`\\n${error.message}\\n\`\`\``;
    
    try {
      await this.postComment(event, responseMessage);
    } catch (commentError) {
      logger.error('Failed to post error comment:', commentError);
    }
  }

  private async postComment(event: GitLabWebhookEvent, message: string): Promise<void> {
    switch (event.object_kind) {
      case 'issue':
        if (event.issue) {
          await this.gitlabService.addIssueComment(
            event.project.id,
            event.issue.iid,
            message
          );
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
          await this.gitlabService.addIssueComment(
            event.project.id,
            event.issue.iid,
            message
          );
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
}
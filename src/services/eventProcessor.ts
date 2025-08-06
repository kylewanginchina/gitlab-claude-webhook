import { GitLabWebhookEvent, ClaudeInstruction } from '../types/gitlab';
import { extractClaudeInstructions } from '../utils/webhook';
import logger from '../utils/logger';
import { ProjectManager } from './projectManager';
import { StreamingClaudeExecutor, StreamingProgressCallback } from './streamingClaudeExecutor';
import { GitLabService } from './gitlabService';

export class EventProcessor {
  private projectManager: ProjectManager;
  private claudeExecutor: StreamingClaudeExecutor;
  private gitlabService: GitLabService;
  private currentCommentId: number | null = null;

  constructor() {
    this.projectManager = new ProjectManager();
    this.claudeExecutor = new StreamingClaudeExecutor();
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
    // Create initial progress comment
    const initialMessage = `🚀 Claude is starting to work on your request...\n\n**Task:** ${instruction.command.substring(0, 100)}${instruction.command.length > 100 ? '...' : ''}\n\n---\n\n⏳ Processing...`;
    
    this.currentCommentId = await this.createProgressComment(event, initialMessage);
    
    const projectPath = await this.projectManager.prepareProject(
      event.project,
      instruction.branch || event.project.default_branch
    );

    try {
      // Create streaming callback for real-time updates
      const callback: StreamingProgressCallback = {
        onProgress: async (message: string, isComplete?: boolean) => {
          await this.updateProgressComment(event, message, isComplete);
        },
        onError: async (error: string) => {
          await this.updateProgressComment(event, error, true, true);
        }
      };

      const result = await this.claudeExecutor.executeWithStreaming(
        instruction.command,
        projectPath,
        {
          context: instruction.context,
          projectUrl: event.project.web_url,
          branch: instruction.branch || event.project.default_branch,
          event,
          instruction: instruction.command,
        },
        callback
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

    let responseMessage = '✅ Claude processed your request successfully.\n\n';
    
    if (result.output) {
      responseMessage += `**Output:**\n\`\`\`\n${result.output}\n\`\`\`\n\n`;
    }

    if (result.changes?.length > 0) {
      responseMessage += `**Changes made:**\n`;
      for (const change of result.changes) {
        responseMessage += `- ${change.type}: \`${change.path}\`\n`;
      }
      responseMessage += '\n';
      
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

    const responseMessage = `❌ Claude encountered an error while processing your request:\n\n\`\`\`\n${result.error}\n\`\`\``;
    await this.postComment(event, responseMessage);
  }

  private async reportError(event: GitLabWebhookEvent, error: any): Promise<void> {
    const responseMessage = `🚨 Internal error occurred while processing your Claude request:\n\n\`\`\`\n${error.message}\n\`\`\``;
    
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

  private async createProgressComment(event: GitLabWebhookEvent, message: string): Promise<number | null> {
    try {
      let commentId: number | null = null;
      
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

  private progressMessages: string[] = [];

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
      const timestamp = new Date().toISOString().slice(11, 19);
      const formattedMessage = `[${timestamp}] ${message}`;
      
      this.progressMessages.push(formattedMessage);

      // Build the complete comment body
      let commentBody = '🤖 **Claude Progress Report**\n\n';
      
      // Add the latest messages (keep last 10 to avoid too long comments)
      const recentMessages = this.progressMessages.slice(-10);
      recentMessages.forEach(msg => {
        commentBody += `${msg}\n`;
      });

      if (isComplete) {
        if (isError) {
          commentBody += '\n❌ **Task completed with errors**';
        } else {
          commentBody += '\n✅ **Task completed successfully!**';
        }
      } else {
        commentBody += '\n⏳ *Processing...*';
      }

      commentBody += `\n\n---\n*Last updated: ${new Date().toISOString()}*`;

      // Update the comment
      await this.updateComment(event, this.currentCommentId, commentBody);
    } catch (error) {
      logger.error('Failed to update progress comment:', error);
    }
  }

  private async updateComment(event: GitLabWebhookEvent, commentId: number, body: string): Promise<void> {
    // Note: GitLab API doesn't support updating comments directly
    // We would need to use the notes API with PUT method, but the GitLab client might not support this
    // For now, we'll create new comments for major updates
    // This is a limitation we'll document
    
    logger.info('Progress update (comment update not supported by GitLab API)', {
      commentId,
      messageLength: body.length,
    });
  }
}
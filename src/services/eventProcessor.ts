import { GitLabWebhookEvent, ClaudeInstruction } from '../types/gitlab';
import { extractClaudeInstructions } from '../utils/webhook';
import logger from '../utils/logger';
import { ProjectManager } from './projectManager';
import { StreamingClaudeExecutor, StreamingProgressCallback } from './streamingClaudeExecutor';
import { GitLabService } from './gitlabService';
import { MRGenerator } from '../utils/mrGenerator';

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
      const instruction = await this.extractInstruction(event);

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

  private async extractInstruction(event: GitLabWebhookEvent): Promise<ClaudeInstruction | null> {
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
          content = (event.object_attributes as { note?: string }).note || '';
          const noteId = (event.object_attributes as { id?: number }).id;

          if (event.issue) {
            context = `Issue #${event.issue.iid} comment`;
            branch = event.project.default_branch;

            // Fetch thread context for issue comment
            if (noteId) {
              const threadContext = await this.getThreadContext('issue', event.project.id, event.issue.iid, noteId);
              if (threadContext) {
                context = `Issue #${event.issue.iid} comment reply\n\n${threadContext}`;
              }
            }
          } else if (event.merge_request) {
            context = `MR #${event.merge_request.iid} comment`;
            branch = event.merge_request.source_branch;

            // Fetch thread context for MR comment
            if (noteId) {
              const threadContext = await this.getThreadContext('merge_request', event.project.id, event.merge_request.iid, noteId);
              if (threadContext) {
                context = `MR #${event.merge_request.iid} comment reply\n\n${threadContext}`;
              }
            }
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

  private async getThreadContext(
    type: 'issue' | 'merge_request',
    projectId: number,
    itemIid: number,
    noteId: number
  ): Promise<string | null> {
    try {
      let discussions: any[];

      if (type === 'issue') {
        discussions = await this.gitlabService.getIssueDiscussions(projectId, itemIid);
      } else {
        discussions = await this.gitlabService.getMergeRequestDiscussions(projectId, itemIid);
      }

      const result = await this.gitlabService.findNoteInDiscussions(discussions, noteId);

      if (result && result.threadContext) {
        logger.info('Found thread context for note', {
          projectId,
          itemIid,
          noteId,
          contextLength: result.threadContext.length,
        });
        return result.threadContext;
      }

      return null;
    } catch (error) {
      logger.error('Failed to get thread context:', error);
      return null;
    }
  }

  private async executeInstruction(
    event: GitLabWebhookEvent,
    instruction: ClaudeInstruction
  ): Promise<void> {
    // Create initial progress comment
    const initialMessage = `🚀 Claude is starting to work on your request...\n\n**Task:** ${instruction.command.substring(0, 100)}${instruction.command.length > 100 ? '...' : ''}\n\n---\n\n⏳ Processing...`;

    this.currentCommentId = await this.createProgressComment(event, initialMessage);

    const baseBranch = instruction.branch || event.project.default_branch;

    const projectPath = await this.projectManager.prepareProject(
      event.project,
      baseBranch
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

      // Execute Claude without creating branch first
      const result = await this.claudeExecutor.executeWithStreaming(
        instruction.command,
        projectPath,
        {
          context: instruction.context,
          projectUrl: event.project.web_url,
          branch: baseBranch, // Use base branch for execution
          event,
          instruction: instruction.command,
        },
        callback
      );

      if (result.success) {
        await this.handleSuccess(event, instruction, result, baseBranch, projectPath);
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
    result: any,
    baseBranch: string,
    projectPath: string
  ): Promise<void> {
    logger.info('Claude instruction executed successfully', {
      projectId: event.project.id,
      hasChanges: result.changes?.length > 0,
    });

    let responseMessage = '✅ Claude processed your request successfully.\n\n';

    if (result.output) {
      responseMessage += `${result.output}\n\n`;
    }

    if (result.changes?.length > 0) {
      responseMessage += `**Changes made:**\n`;
      for (const change of result.changes) {
        responseMessage += `- ${change.type}: \`${change.path}\`\n`;
      }
      responseMessage += '\n';

      // Only create branch and MR if there are actual changes
      try {
        // Generate timestamp-based branch name for Claude changes
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const claudeBranch = `claude-${timestamp}-${randomSuffix}`;

        // Create new branch for Claude changes
        await this.gitlabService.createBranch(
          event.project.id,
          claudeBranch,
          baseBranch
        );

        await this.updateProgressComment(event, `Created branch: ${claudeBranch}`);

        // Generate MR info first to get the commit message
        const mrInfo = MRGenerator.generateMR({
          instruction: instruction.command,
          context: instruction.context,
          changes: result.changes,
          projectUrl: event.project.web_url,
        });

        // Switch to the new branch and push changes with generated commit message
        await this.commitAndPushToNewBranch(event, projectPath, claudeBranch, mrInfo.commitMessage);

        const mergeRequest = await this.gitlabService.createMergeRequest(
          event.project.id,
          {
            sourceBranch: claudeBranch,
            targetBranch: baseBranch,
            title: mrInfo.title,
            description: mrInfo.description,
          }
        );

        // Generate MR URL
        const mrUrl = `${event.project.web_url}/-/merge_requests/${mergeRequest.iid}`;

        responseMessage += `**🔀 Merge Request Created**\n`;
        responseMessage += `[Click here to review and merge the changes →](${ mrUrl})\n\n`;
        responseMessage += `**Branch:** \`${claudeBranch}\` → \`${baseBranch}\`\n`;

        await this.updateProgressComment(event, `Created merge request: ${mrUrl}`);

      } catch (error) {
        logger.error('Failed to create branch or merge request:', error);
        responseMessage += `⚠️ **Note:** Changes were made but could not create merge request: ${error instanceof Error ? error.message : String(error)}\n\n`;
      }
    } else {
      // No changes, just post the result
      responseMessage += '📋 No file changes were made.\n';
    }

    await this.postComment(event, responseMessage);
  }

  private async commitAndPushToNewBranch(
    event: GitLabWebhookEvent,
    projectPath: string,
    claudeBranch: string,
    commitMessage: string
  ): Promise<void> {
    try {
      // Switch to the new branch in local git
      await this.projectManager.switchToAndPushBranch(projectPath, claudeBranch, commitMessage);
    } catch (error) {
      logger.error('Failed to commit and push to new branch:', error);
      throw error;
    }
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
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
  private currentDiscussionId: string | null = null;

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
    } finally {
      // Reset discussion ID after processing
      this.currentDiscussionId = null;
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
          context = await this.buildMergeRequestContext(event.merge_request, event.project.id);
          branch = event.merge_request.source_branch;
        }
        break;

      case 'note':
        if (event.object_attributes) {
          content = (event.object_attributes as { note?: string }).note || '';
          const noteId = (event.object_attributes as { id?: number }).id;

          if (event.issue) {
            // Build enhanced context for issue comments
            context = `Issue #${event.issue.iid}: ${event.issue.title}\n\n**Issue Description:** ${event.issue.description ? (event.issue.description.length > 200 ? event.issue.description.substring(0, 200) + '...' : event.issue.description) : 'No description provided'}`;
            branch = event.project.default_branch;

            // Get full conversation history for this issue
            const conversationHistory = await this.getConversationHistory(
              'issue',
              event.project.id,
              event.issue.iid,
              noteId
            );
            if (conversationHistory) {
              context = `${context}\n\n${conversationHistory}`;
            }
          } else if (event.merge_request) {
            // Build enhanced context for merge request comments including code changes
            context = await this.buildMergeRequestContext(event.merge_request, event.project.id);
            branch = event.merge_request.source_branch;

            // Get full conversation history for this merge request
            const conversationHistory = await this.getConversationHistory(
              'merge_request',
              event.project.id,
              event.merge_request.iid,
              noteId
            );
            if (conversationHistory) {
              context = `${context}\n\n${conversationHistory}`;
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

      if (result) {
        // Store discussion ID for later use in replies
        this.currentDiscussionId = result.discussionId;

        logger.info('Found thread context for note', {
          projectId,
          itemIid,
          noteId,
          discussionId: result.discussionId,
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

  private async getConversationHistory(
    type: 'issue' | 'merge_request',
    projectId: number,
    itemIid: number,
    currentNoteId?: number
  ): Promise<string | null> {
    try {
      let discussions: any[];

      if (type === 'issue') {
        discussions = await this.gitlabService.getIssueDiscussions(projectId, itemIid);
      } else {
        discussions = await this.gitlabService.getMergeRequestDiscussions(projectId, itemIid);
      }

      if (!discussions || discussions.length === 0) {
        return null;
      }

      // Build conversation history from all discussions
      let conversationHistory = '**Conversation History:**\n\n';
      let hasContent = false;

      // Sort discussions by creation time
      const sortedDiscussions = discussions.sort((a, b) => {
        const aCreatedAt = a.notes?.[0]?.created_at || '';
        const bCreatedAt = b.notes?.[0]?.created_at || '';
        return new Date(aCreatedAt).getTime() - new Date(bCreatedAt).getTime();
      });

      for (const discussion of sortedDiscussions) {
        if (discussion.notes && Array.isArray(discussion.notes)) {
          // Sort notes within each discussion by creation time
          const sortedNotes = discussion.notes.sort((a: any, b: any) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );

          for (const note of sortedNotes) {
            // Skip the current note if we have its ID
            if (currentNoteId && note.id === currentNoteId) {
              continue;
            }

            // Skip system notes
            if (note.system) {
              continue;
            }

            const author = note.author?.name || note.author?.username || 'Unknown';
            const timestamp = new Date(note.created_at).toLocaleString();

            conversationHistory += `**${author}** (${timestamp}):\n`;
            conversationHistory += `${note.body}\n\n`;
            hasContent = true;
          }
        }
      }

      return hasContent ? conversationHistory.trim() : null;
    } catch (error) {
      logger.error('Failed to get conversation history:', error);
      return null;
    }
  }

  private isActualReply(threadContext: string | null): boolean {
    if (!threadContext || !threadContext.trim()) {
      return false;
    }

    // Check if there's meaningful thread context content
    // Thread context should contain previous comments in the discussion
    const hasThreadContext = threadContext.includes('**Thread Context:**');

    if (!hasThreadContext) {
      return false;
    }

    // Extract the content after "**Thread Context:**"
    const contextContent = threadContext.split('**Thread Context:**')[1]?.trim();

    // If there's actual previous conversation content, this is a reply
    // If it's empty or just whitespace, this is the first comment in a new thread
    return Boolean(contextContent && contextContent.length > 0);
  }

  private async buildMergeRequestContext(mergeRequest: any, projectId: number): Promise<string> {
    try {
      let context = `MR #${mergeRequest.iid}: ${mergeRequest.title}\n\n`;

      // Add MR description if available and not too long
      if (mergeRequest.description && mergeRequest.description.trim()) {
        const description =
          mergeRequest.description.length > 200
            ? mergeRequest.description.substring(0, 200) + '...'
            : mergeRequest.description;
        context += `**Description:** ${description}\n\n`;
      }

      // Add branch information
      context += `**Source Branch:** ${mergeRequest.source_branch}\n`;
      context += `**Target Branch:** ${mergeRequest.target_branch}\n`;

      // Use webhook data first, fall back to API if needed
      if (mergeRequest.changes_count !== undefined) {
        context += `**Changes:** ${mergeRequest.changes_count} files modified\n`;
      }

      if (mergeRequest.additions !== undefined && mergeRequest.deletions !== undefined) {
        context += `**Additions:** +${mergeRequest.additions}, **Deletions:** -${mergeRequest.deletions}\n`;
      } else if (!mergeRequest.changes_count) {
        // Only call API if webhook doesn't have the info we need
        try {
          const mrDetails = await this.gitlabService.getMergeRequest(projectId, mergeRequest.iid);

          if (mrDetails.changes_count) {
            context += `**Changes:** ${mrDetails.changes_count} files modified\n`;
          }

          if (mrDetails.additions && mrDetails.deletions) {
            context += `**Additions:** +${mrDetails.additions}, **Deletions:** -${mrDetails.deletions}\n`;
          }
        } catch (error) {
          logger.debug('Could not fetch additional MR details:', error);
        }
      }

      return context.trim();
    } catch (error) {
      logger.error('Error building merge request context:', error);
      return `MR #${mergeRequest.iid}: ${mergeRequest.title}`;
    }
  }

  private async executeInstruction(
    event: GitLabWebhookEvent,
    instruction: ClaudeInstruction
  ): Promise<void> {
    // Clear previous progress messages for this new instruction
    this.progressMessages = [];

    // Create initial progress comment
    const initialMessage = `🚀 Claude is starting to work on your request...\n\n**Task:** ${instruction.command.substring(0, 100)}${instruction.command.length > 100 ? '...' : ''}\n\n---\n\n⏳ Processing...`;

    this.currentCommentId = await this.createProgressComment(event, initialMessage);

    const baseBranch = instruction.branch || event.project.default_branch;

    const projectPath = await this.projectManager.prepareProject(event.project, baseBranch);

    try {
      // Create streaming callback for real-time updates
      const callback: StreamingProgressCallback = {
        onProgress: async (message: string, isComplete?: boolean) => {
          await this.updateProgressComment(event, message, isComplete);
        },
        onError: async (error: string) => {
          await this.updateProgressComment(event, error, true, true);
        },
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
        await this.gitlabService.createBranch(event.project.id, claudeBranch, baseBranch);

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

        const mergeRequest = await this.gitlabService.createMergeRequest(event.project.id, {
          sourceBranch: claudeBranch,
          targetBranch: baseBranch,
          title: mrInfo.title,
          description: mrInfo.description,
        });

        // Generate MR URL
        const mrUrl = `${event.project.web_url}/-/merge_requests/${mergeRequest.iid}`;

        responseMessage += `**🔀 Merge Request Created**\n`;
        responseMessage += `[Click here to review and merge the changes →](${mrUrl})\n\n`;
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
    // If we have a discussion ID, try to post as a reply to that discussion
    if (this.currentDiscussionId) {
      try {
        switch (event.object_kind) {
          case 'issue':
          case 'note':
            if (event.issue) {
              await this.gitlabService.addIssueDiscussionReply(
                event.project.id,
                event.issue.iid,
                this.currentDiscussionId,
                message
              );
              return;
            }
            break;

          case 'merge_request':
            if (event.merge_request) {
              await this.gitlabService.addMergeRequestDiscussionReply(
                event.project.id,
                event.merge_request.iid,
                this.currentDiscussionId,
                message
              );
              return;
            }
            break;
        }
      } catch (error) {
        // Silently fallback for known unimplemented features
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('Discussion reply not implemented')) {
          logger.warn('Failed to post discussion reply, falling back to regular comment:', error);
        }
        // Continue to fallback posting method
      }
    }

    // Fallback to regular comment posting
    switch (event.object_kind) {
      case 'issue':
        if (event.issue) {
          await this.gitlabService.addIssueComment(event.project.id, event.issue.iid, message);
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
          await this.gitlabService.addIssueComment(event.project.id, event.issue.iid, message);
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

  private async createProgressComment(
    event: GitLabWebhookEvent,
    message: string
  ): Promise<number | null> {
    try {
      let commentId: number | null = null;

      // If we have a discussion ID, try to create progress comment as a reply to that discussion
      if (this.currentDiscussionId) {
        try {
          switch (event.object_kind) {
            case 'issue':
            case 'note':
              if (event.issue) {
                const comment = await this.gitlabService.addIssueDiscussionReply(
                  event.project.id,
                  event.issue.iid,
                  this.currentDiscussionId,
                  message
                );
                commentId = comment?.id || null;
                return commentId;
              }
              break;

            case 'merge_request':
              if (event.merge_request) {
                const comment = await this.gitlabService.addMergeRequestDiscussionReply(
                  event.project.id,
                  event.merge_request.iid,
                  this.currentDiscussionId,
                  message
                );
                commentId = comment?.id || null;
                return commentId;
              }
              break;
          }
        } catch (error) {
          // Silently fallback for known unimplemented features
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!errorMessage.includes('Discussion reply not implemented')) {
            logger.warn(
              'Failed to create discussion reply progress comment, falling back to regular comment:',
              error
            );
          }
          // Continue to fallback comment creation method
        }
      }

      // Fallback to regular comment creation
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

      // Check for duplicate messages (ignore timestamp, only check the message content)
      const isDuplicate = this.progressMessages.some(existingMsg => {
        // Extract the message part after the timestamp
        const existingMessageContent = existingMsg.substring(11); // Remove "[HH:MM:SS] "
        const newMessageContent = formattedMessage.substring(11);
        return existingMessageContent === newMessageContent;
      });

      // Only add if not duplicate
      if (!isDuplicate) {
        this.progressMessages.push(formattedMessage);
      }

      // Build the complete comment body
      let commentBody = '🤖 **Claude Progress Report**\n\n';

      // Add the latest messages (keep last 10 to avoid too long comments)
      const recentMessages = this.progressMessages.slice(-10);
      recentMessages.forEach(msg => {
        commentBody += `- ${msg}\n`;
      });

      if (isComplete) {
        commentBody += '\n---\n\n';
        if (isError) {
          commentBody += '❌ **Task completed with errors**';
        } else {
          commentBody += '✅ **Task completed successfully!**';
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

  private async updateComment(
    event: GitLabWebhookEvent,
    commentId: number,
    body: string
  ): Promise<void> {
    try {
      switch (event.object_kind) {
        case 'issue':
          if (event.issue) {
            await this.gitlabService.updateIssueComment(
              event.project.id,
              event.issue.iid,
              commentId,
              body
            );
          }
          break;

        case 'merge_request':
          if (event.merge_request) {
            await this.gitlabService.updateMergeRequestComment(
              event.project.id,
              event.merge_request.iid,
              commentId,
              body
            );
          }
          break;

        case 'note':
          if (event.issue) {
            await this.gitlabService.updateIssueComment(
              event.project.id,
              event.issue.iid,
              commentId,
              body
            );
          } else if (event.merge_request) {
            await this.gitlabService.updateMergeRequestComment(
              event.project.id,
              event.merge_request.iid,
              commentId,
              body
            );
          }
          break;
      }

      logger.info('Progress comment updated successfully', {
        commentId,
        messageLength: body.length,
      });
    } catch (error) {
      logger.error('Failed to update progress comment:', error);
      // Fallback: create a new comment if update fails
      await this.postComment(event, `**Updated Progress:**\n\n${body}`);
    }
  }
}

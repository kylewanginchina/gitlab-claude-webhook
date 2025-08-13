import { Gitlab } from '@gitbeaker/node';
import { config } from '../utils/config';
import logger from '../utils/logger';

export class GitLabService {
  private gitlab: InstanceType<typeof Gitlab>;

  constructor() {
    this.gitlab = new Gitlab({
      host: config.gitlab.baseUrl,
      token: config.gitlab.token,
    });
  }

  public async createIssueComment(
    projectId: number,
    issueIid: number,
    body: string
  ): Promise<any> {
    try {
      const comment = await this.gitlab.IssueNotes.create(projectId, issueIid, body);

      logger.info('Created comment on issue', {
        projectId,
        issueIid,
        bodyLength: body.length,
        commentId: comment?.id,
      });

      return comment;
    } catch (error) {
      logger.error('Failed to create issue comment:', error);
      throw new Error(`Failed to create issue comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async addIssueComment(
    projectId: number,
    issueIid: number,
    body: string
  ): Promise<void> {
    await this.createIssueComment(projectId, issueIid, body);
  }

  public async createMergeRequestComment(
    projectId: number,
    mergeRequestIid: number,
    body: string
  ): Promise<any> {
    try {
      const comment = await this.gitlab.MergeRequestNotes.create(projectId, mergeRequestIid, body);

      logger.info('Created comment on merge request', {
        projectId,
        mergeRequestIid,
        bodyLength: body.length,
        commentId: comment?.id,
      });

      return comment;
    } catch (error) {
      logger.error('Failed to create merge request comment:', error);
      throw new Error(`Failed to create merge request comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async addMergeRequestComment(
    projectId: number,
    mergeRequestIid: number,
    body: string
  ): Promise<void> {
    await this.createMergeRequestComment(projectId, mergeRequestIid, body);
  }

  public async getProject(projectId: number): Promise<any> {
    try {
      const project = await this.gitlab.Projects.show(projectId);
      return project;
    } catch (error) {
      logger.error('Failed to get project:', error);
      throw new Error(`Failed to get project: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getBranches(projectId: number): Promise<any[]> {
    try {
      const branches = await this.gitlab.Branches.all(projectId);
      return branches;
    } catch (error) {
      logger.error('Failed to get branches:', error);
      throw new Error(`Failed to get branches: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async createBranch(
    projectId: number,
    branchName: string,
    ref: string
  ): Promise<any> {
    try {
      const branch = await this.gitlab.Branches.create(projectId, branchName, ref);

      logger.info('Created branch', {
        projectId,
        branchName,
        ref,
      });

      return branch;
    } catch (error) {
      logger.error('Failed to create branch:', error);
      throw new Error(`Failed to create branch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async updateMergeRequestDescription(
    projectId: number,
    mergeRequestIid: number,
    description: string
  ): Promise<void> {
    try {
      await this.gitlab.MergeRequests.edit(projectId, mergeRequestIid, {
        description,
      });

      logger.info('Updated merge request description', {
        projectId,
        mergeRequestIid,
      });
    } catch (error) {
      logger.error('Failed to update merge request description:', error);
      throw new Error(`Failed to update merge request description: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async updateIssueDescription(
    projectId: number,
    issueIid: number,
    description: string
  ): Promise<void> {
    try {
      await this.gitlab.Issues.edit(projectId, issueIid, {
        description,
      });

      logger.info('Updated issue description', {
        projectId,
        issueIid,
      });
    } catch (error) {
      logger.error('Failed to update issue description:', error);
      throw new Error(`Failed to update issue description: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getIssue(projectId: number, issueIid: number): Promise<any> {
    try {
      const issue = await this.gitlab.Issues.show(projectId, issueIid);
      return issue;
    } catch (error) {
      logger.error('Failed to get issue:', error);
      throw new Error(`Failed to get issue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getMergeRequest(projectId: number, mergeRequestIid: number): Promise<any> {
    try {
      const mergeRequest = await this.gitlab.MergeRequests.show(projectId, mergeRequestIid);
      return mergeRequest;
    } catch (error) {
      logger.error('Failed to get merge request:', error);
      throw new Error(`Failed to get merge request: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async createMergeRequest(
    projectId: number,
    options: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description?: string;
    }
  ): Promise<any> {
    try {
      const mergeRequest = await this.gitlab.MergeRequests.create(
        projectId,
        options.sourceBranch,
        options.targetBranch,
        options.title,
        {
          ...(options.description && { description: options.description }),
        }
      );

      logger.info('Created merge request', {
        projectId,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        title: options.title,
      });

      return mergeRequest;
    } catch (error) {
      logger.error('Failed to create merge request:', error);
      throw new Error(`Failed to create merge request: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getIssueDiscussions(projectId: number, issueIid: number): Promise<any[]> {
    try {
      const discussions = await this.gitlab.IssueDiscussions.all(projectId, issueIid);
      return discussions;
    } catch (error) {
      logger.error('Failed to get issue discussions:', error);
      throw new Error(`Failed to get issue discussions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getMergeRequestDiscussions(projectId: number, mergeRequestIid: number): Promise<any[]> {
    try {
      const discussions = await this.gitlab.MergeRequestDiscussions.all(projectId, mergeRequestIid);
      return discussions;
    } catch (error) {
      logger.error('Failed to get merge request discussions:', error);
      throw new Error(`Failed to get merge request discussions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async findNoteInDiscussions(
    discussions: any[],
    noteId: number
  ): Promise<{ discussion: any; note: any; threadContext: string; discussionId: string } | null> {
    try {
      for (const discussion of discussions) {
        if (discussion.notes && Array.isArray(discussion.notes)) {
          for (const note of discussion.notes) {
            if (note.id === noteId) {
              // Found the note, now build thread context
              const threadContext = this.buildThreadContext(discussion.notes, noteId);
              return {
                discussion,
                note,
                threadContext,
                discussionId: discussion.id
              };
            }
          }
        }
      }
      return null;
    } catch (error) {
      logger.error('Failed to find note in discussions:', error);
      return null;
    }
  }

  private buildThreadContext(notes: any[], currentNoteId: number): string {
    if (!notes || notes.length <= 1) {
      return '';
    }

    // Sort notes by creation time
    const sortedNotes = notes.sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    let context = '**Thread Context:**\n\n';
    let hasNotes = false;

    for (const note of sortedNotes) {
      if (note.id === currentNoteId) {
        // Don't include the current note in context, just notes before it
        break;
      }

      const author = note.author?.name || note.author?.username || 'Unknown';
      const timestamp = new Date(note.created_at).toLocaleString();

      context += `**${author}** (${timestamp}):\n`;
      context += `${note.body}\n\n`;
      hasNotes = true;
    }

    return hasNotes ? context.trim() : '';
  }

  public async updateIssueComment(
    projectId: number,
    issueIid: number,
    noteId: number,
    body: string
  ): Promise<any> {
    try {
      const updatedComment = await this.gitlab.IssueNotes.edit(projectId, issueIid, noteId, body);

      logger.info('Updated issue comment', {
        projectId,
        issueIid,
        noteId,
        bodyLength: body.length,
      });

      return updatedComment;
    } catch (error) {
      logger.error('Failed to update issue comment:', error);
      throw new Error(`Failed to update issue comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async updateMergeRequestComment(
    projectId: number,
    mergeRequestIid: number,
    noteId: number,
    body: string
  ): Promise<any> {
    try {
      const updatedComment = await this.gitlab.MergeRequestNotes.edit(projectId, mergeRequestIid, noteId, body);

      logger.info('Updated merge request comment', {
        projectId,
        mergeRequestIid,
        noteId,
        bodyLength: body.length,
      });

      return updatedComment;
    } catch (error) {
      logger.error('Failed to update merge request comment:', error);
      throw new Error(`Failed to update merge request comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async addIssueDiscussionReply(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _projectId: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _issueIid: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _discussionId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _body: string
  ): Promise<any> {
    try {
      // TODO: Implement proper discussion reply API call
      // For now, always throw to use fallback
      throw new Error('Discussion reply not yet implemented - falling back to regular comment');
    } catch (error) {
      logger.error('Failed to add issue discussion reply:', error);
      // Fallback to regular comment if discussion reply fails
      throw new Error(`Failed to add issue discussion reply: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async addMergeRequestDiscussionReply(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _projectId: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _mergeRequestIid: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _discussionId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _body: string
  ): Promise<any> {
    try {
      // TODO: Implement proper discussion reply API call
      // For now, always throw to use fallback
      throw new Error('Discussion reply not yet implemented - falling back to regular comment');
    } catch (error) {
      logger.error('Failed to add merge request discussion reply:', error);
      // Fallback to regular comment if discussion reply fails
      throw new Error(`Failed to add merge request discussion reply: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async testConnection(): Promise<boolean> {
    try {
      await this.gitlab.Users.current();
      logger.info('GitLab API connection test successful');
      return true;
    } catch (error) {
      logger.error('GitLab API connection test failed:', error);
      return false;
    }
  }
}
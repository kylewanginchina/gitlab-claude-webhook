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

  public async addIssueComment(
    projectId: number,
    issueIid: number,
    body: string
  ): Promise<void> {
    try {
      await this.gitlab.IssueNotes.create(projectId, issueIid, body);
      
      logger.info('Added comment to issue', {
        projectId,
        issueIid,
        bodyLength: body.length,
      });
    } catch (error) {
      logger.error('Failed to add issue comment:', error);
      throw new Error(`Failed to add issue comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async addMergeRequestComment(
    projectId: number,
    mergeRequestIid: number,
    body: string
  ): Promise<void> {
    try {
      await this.gitlab.MergeRequestNotes.create(projectId, mergeRequestIid, body);
      
      logger.info('Added comment to merge request', {
        projectId,
        mergeRequestIid,
        bodyLength: body.length,
      });
    } catch (error) {
      logger.error('Failed to add merge request comment:', error);
      throw new Error(`Failed to add merge request comment: ${error instanceof Error ? error.message : String(error)}`);
    }
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
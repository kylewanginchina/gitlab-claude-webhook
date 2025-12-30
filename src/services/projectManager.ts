import { simpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { GitLabProject } from '../types/gitlab';

export class ProjectManager {
  private workDir: string;

  constructor() {
    this.workDir = config.workDir;
  }

  public async prepareProject(project: GitLabProject, branch: string): Promise<string> {
    const projectId = uuidv4();
    const projectPath = path.join(this.workDir, projectId);

    try {
      await this.ensureWorkDirExists();
      await this.cloneProject(project, projectPath, branch);

      logger.info('Project prepared successfully', {
        projectId: project.id,
        projectName: project.name,
        branch,
        path: projectPath,
      });

      return projectPath;
    } catch (error) {
      logger.error('Failed to prepare project:', error);
      await this.cleanup(projectPath);
      throw error;
    }
  }

  private async ensureWorkDirExists(): Promise<void> {
    try {
      await fs.access(this.workDir);
    } catch {
      await fs.mkdir(this.workDir, { recursive: true });
      logger.info(`Created work directory: ${this.workDir}`);
    }
  }

  private async cloneProject(
    project: GitLabProject,
    projectPath: string,
    branch: string
  ): Promise<void> {
    const git = simpleGit();

    logger.debug('Project details for cloning', {
      projectId: project.id,
      projectName: project.name,
      httpUrl: project.http_url_to_repo,
      webUrl: project.web_url,
      defaultBranch: project.default_branch,
      requestedBranch: branch,
    });

    // Use HTTP URL with token for authentication
    // GitLab webhook uses 'http_url' or 'git_http_url' instead of 'http_url_to_repo'
    const httpUrl =
      project.http_url_to_repo || (project as any).http_url || (project as any).git_http_url;
    const cloneUrl = this.getAuthenticatedUrl(httpUrl);

    logger.info('Cloning project', {
      projectId: project.id,
      branch,
      url: project.http_url_to_repo,
    });

    try {
      await git.clone(cloneUrl, projectPath, ['--branch', branch]);
    } catch (error) {
      // If specific branch doesn't exist, clone default and checkout
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Remote branch') && errorMessage.includes('not found')) {
        logger.warn(`Branch ${branch} not found, cloning default branch and checking out`);

        await git.clone(cloneUrl, projectPath);
        const projectGit = simpleGit(projectPath);

        try {
          await projectGit.checkout(branch);
        } catch (checkoutError) {
          logger.warn(`Failed to checkout branch ${branch}, using default branch`);
        }
      } else {
        throw error;
      }
    }

    // Configure git user for commits
    const projectGit = simpleGit(projectPath);
    await projectGit.addConfig('user.name', 'Claude Webhook Bot');
    await projectGit.addConfig('user.email', 'claude-webhook@example.com');
  }

  private getAuthenticatedUrl(httpUrl: string): string {
    if (!httpUrl) {
      logger.error('HTTP URL is undefined or empty', { httpUrl });
      throw new Error('HTTP URL for repository is not available');
    }

    const url = new URL(httpUrl);
    url.username = 'oauth2';
    url.password = config.gitlab.token;
    return url.toString();
  }

  public async switchToAndPushBranch(
    projectPath: string,
    branchName: string,
    commitMessage: string
  ): Promise<void> {
    const git = simpleGit(projectPath);

    try {
      // Switch to the new branch
      await git.checkout(['-b', branchName]);

      // Add all changes
      await git.add('.');

      // Check if there are changes to commit
      const status = await git.status();
      if (status.files.length === 0) {
        logger.info('No changes to commit');
        return;
      }

      // Commit changes
      await git.commit(commitMessage);

      // Push to remote with upstream tracking
      await git.push(['-u', 'origin', branchName]);

      logger.info('Changes committed and pushed to new branch', {
        branch: branchName,
        filesChanged: status.files.length,
      });
    } catch (error) {
      logger.error('Error switching to branch and pushing changes:', error);
      throw error;
    }
  }

  public async hasChanges(projectPath: string): Promise<boolean> {
    const git = simpleGit(projectPath);

    try {
      const status = await git.status();
      return status.files.length > 0;
    } catch (error) {
      logger.error('Error checking git status:', error);
      return false;
    }
  }

  public async commitAndPush(
    projectPath: string,
    commitMessage: string,
    branch: string
  ): Promise<void> {
    const git = simpleGit(projectPath);

    try {
      // Add all changes
      await git.add('.');

      // Check if there are changes to commit
      const status = await git.status();
      if (status.files.length === 0) {
        logger.info('No changes to commit');
        return;
      }

      // Commit changes
      await git.commit(commitMessage);

      // Push to remote
      await git.push('origin', branch);

      logger.info('Changes committed and pushed successfully', {
        branch,
        filesChanged: status.files.length,
      });
    } catch (error) {
      logger.error('Error committing and pushing changes:', error);
      throw error;
    }
  }

  public async cleanup(projectPath: string): Promise<void> {
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
      logger.debug(`Cleaned up project directory: ${projectPath}`);
    } catch (error) {
      logger.warn(`Failed to cleanup directory ${projectPath}:`, error);
    }
  }

  public async getChangedFiles(
    projectPath: string
  ): Promise<Array<{ path: string; type: string }>> {
    const git = simpleGit(projectPath);

    try {
      const status = await git.status();

      return status.files.map(file => ({
        path: file.path,
        type:
          file.working_dir === '?' ? 'created' : file.working_dir === 'D' ? 'deleted' : 'modified',
      }));
    } catch (error) {
      logger.error('Error getting changed files:', error);
      return [];
    }
  }
}

export interface GitLabProject {
  id: number;
  name: string;
  web_url: string;
  default_branch: string;
  ssh_url_to_repo: string;
  http_url_to_repo: string;
}

export interface GitLabUser {
  id: number;
  name: string;
  username: string;
  email: string;
}

export interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  web_url: string;
  author: GitLabUser;
}

export interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: GitLabUser;
}

export interface GitLabNote {
  id: number;
  body: string;
  author: GitLabUser;
  created_at: string;
  noteable_type: 'Issue' | 'MergeRequest';
}

export interface GitLabWebhookEvent {
  object_kind: 'issue' | 'merge_request' | 'note';
  event_type?: string;
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: any;
  issue?: GitLabIssue;
  merge_request?: GitLabMergeRequest;
  repository?: any;
}

export interface ClaudeInstruction {
  command: string;
  context: string;
  files?: string[];
  branch?: string;
  tag?: string;
}
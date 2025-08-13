export interface GitLabProject {
  id: number;
  name: string;
  web_url: string;
  default_branch: string;
  ssh_url_to_repo?: string;
  http_url_to_repo?: string;
  // Additional fields that may be present in webhook data
  http_url?: string;
  git_http_url?: string;
  git_ssh_url?: string;
  url?: string;
  ssh_url?: string;
  description?: string | null;
  avatar_url?: string | null;
  namespace?: string;
  visibility_level?: number;
  path_with_namespace?: string;
  ci_config_path?: string;
  homepage?: string;
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
  noteable_id?: number;
}

export interface GitLabWebhookEvent {
  object_kind: 'issue' | 'merge_request' | 'note';
  event_type?: string;
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: Record<string, unknown>;
  issue?: GitLabIssue;
  merge_request?: GitLabMergeRequest;
  repository?: Record<string, unknown>;
}

export interface ClaudeInstruction {
  command: string;
  context: string;
  files?: string[];
  branch?: string;
  tag?: string;
}
export type ReviewPromptProvider = 'claude' | 'codex' | 'coderabbit' | 'any';

export interface ReviewPromptDraft {
  focus: string[];
  systemInstructions: string;
}

export interface ReviewPromptVersion extends ReviewPromptDraft {
  version: number;
  createdAt: string;
  createdBy: string;
  changelog: string;
}

export interface ReviewPrompt {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  provider: ReviewPromptProvider;
  currentVersion: number;
  draft: ReviewPromptDraft;
  versions: ReviewPromptVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewPromptPatch {
  label?: string;
  description?: string;
  enabled?: boolean;
  provider?: ReviewPromptProvider;
  draft?: Partial<ReviewPromptDraft>;
}

export interface CreateReviewPromptInput {
  id?: string;
  label: string;
  description?: string;
  provider?: ReviewPromptProvider;
  draft: ReviewPromptDraft;
}

export interface PublishedReviewPassTemplate extends ReviewPromptDraft {
  id: string;
  label: string;
  version: number;
}

export interface ReviewSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  provider: ReviewPromptProvider;
  fileGlobs: string[];
  languageHints: string[];
  promptIds: string[];
  systemInstructions: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSkillInput {
  name: string;
  description?: string;
  provider?: ReviewPromptProvider;
  fileGlobs?: string[];
  languageHints?: string[];
  promptIds?: string[];
  systemInstructions: string;
  priority?: number;
  enabled?: boolean;
}

export interface ReviewFeedback {
  id: string;
  reviewRunId?: string;
  findingKey?: string;
  promptId?: string;
  label: 'useful' | 'false_positive' | 'missed_issue' | 'unclear' | 'accepted' | 'rejected';
  note: string;
  source: 'admin' | 'gitlab-comment' | 'gitlab-resolution';
  createdAt: string;
}

export interface ReviewFeedbackInput {
  reviewRunId?: string;
  findingKey?: string;
  promptId?: string;
  label: ReviewFeedback['label'];
  note?: string;
  source?: ReviewFeedback['source'];
}

export interface PromptOptimizationProposal {
  id: string;
  promptId: string;
  baseVersion: number;
  title: string;
  rationale: string;
  suggestedDraft: ReviewPromptDraft;
  feedbackIds: string[];
  status: 'open' | 'applied' | 'dismissed';
  createdAt: string;
  appliedAt?: string;
}

export interface ReviewSkillMatchContext {
  diffs: Array<{
    old_path?: string;
    new_path?: string;
  }>;
}

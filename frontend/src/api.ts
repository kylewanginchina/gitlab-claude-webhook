import type {
  AdminStatus,
  ConfigUpdateResult,
  ProviderTestResult,
  PromptOptimizationProposal,
  PublicRuntimeConfig,
  ReviewFeedback,
  ReviewFeedbackInput,
  ReviewPrompt,
  ReviewPromptPatch,
  ReviewSkill,
  ReviewSkillInput,
  RuntimeConfigPatch,
} from './types';

const BASE = '/api/admin';
const ADMIN_KEY_STORAGE = 'gitlab_claude_admin_key';

export function getAdminKey(): string {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || '';
}

export function setAdminKey(value: string): void {
  if (value) {
    localStorage.setItem(ADMIN_KEY_STORAGE, value);
  } else {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Admin-Key', getAdminKey());
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: string };
      throw new Error(parsed.error || `HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message !== text) {
        throw error;
      }
      throw new Error(text || `HTTP ${response.status}`);
    }
  }

  return response.json() as Promise<T>;
}

export const api = {
  getStatus: () => request<AdminStatus>('/status'),
  getConfig: () => request<PublicRuntimeConfig>('/config'),
  updateConfig: (patch: RuntimeConfigPatch) =>
    request<ConfigUpdateResult>('/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  testProvider: (provider: 'gitlab' | 'claude' | 'codex') =>
    request<ProviderTestResult>(`/test/${provider}`, { method: 'POST' }),
  getPrompts: () => request<{ prompts: ReviewPrompt[] }>('/prompts'),
  getPrompt: (id: string) => request<{ prompt: ReviewPrompt }>(`/prompts/${id}`),
  updatePrompt: (id: string, patch: ReviewPromptPatch) =>
    request<{ prompt: ReviewPrompt }>(`/prompts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  publishPrompt: (id: string, changelog: string) =>
    request<{ prompt: ReviewPrompt }>(`/prompts/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ changelog }),
    }),
  rollbackPrompt: (id: string, version: number, changelog: string) =>
    request<{ prompt: ReviewPrompt }>(`/prompts/${id}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version, changelog }),
    }),
  getSkills: () => request<{ skills: ReviewSkill[] }>('/skills'),
  createSkill: (skill: ReviewSkillInput) =>
    request<{ skill: ReviewSkill }>('/skills', {
      method: 'POST',
      body: JSON.stringify(skill),
    }),
  updateSkill: (id: string, patch: Partial<ReviewSkillInput>) =>
    request<{ skill: ReviewSkill }>(`/skills/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  enableSkill: (id: string) =>
    request<{ skill: ReviewSkill }>(`/skills/${id}/enable`, { method: 'POST' }),
  disableSkill: (id: string) =>
    request<{ skill: ReviewSkill }>(`/skills/${id}/disable`, { method: 'POST' }),
  getFeedback: () => request<{ feedback: ReviewFeedback[] }>('/feedback'),
  createFeedback: (feedback: ReviewFeedbackInput) =>
    request<{ feedback: ReviewFeedback }>('/feedback', {
      method: 'POST',
      body: JSON.stringify(feedback),
    }),
  getProposals: () =>
    request<{ proposals: PromptOptimizationProposal[] }>('/prompt-optimizer/proposals'),
  analyzeFeedback: () =>
    request<{ proposals: PromptOptimizationProposal[] }>('/prompt-optimizer/analyze', {
      method: 'POST',
    }),
  applyProposal: (id: string) =>
    request<{ proposal: PromptOptimizationProposal }>(
      `/prompt-optimizer/proposals/${id}/apply`,
      { method: 'POST' }
    ),
};

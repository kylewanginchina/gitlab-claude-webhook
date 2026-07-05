import type {
  AdminStatus,
  ConfigUpdateResult,
  ProviderTestResult,
  PublicRuntimeConfig,
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
};

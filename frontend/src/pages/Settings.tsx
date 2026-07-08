import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw, Save, TestTube2, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import type {
  ClaudeReasoningEffort,
  CodexReasoningEffort,
  ConfigUpdateResult,
  ProviderTestResult,
  PublicRuntimeConfig,
  RuntimeConfigPatch,
} from '../types';

type DraftConfig = {
  claude: {
    baseUrl: string;
    authToken: string;
    defaultModel: string;
    reasoningEffort: ClaudeReasoningEffort;
    defaultTimeoutMinutes: number;
  };
  codex: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    reasoningEffort: CodexReasoningEffort;
    defaultTimeoutMinutes: number;
  };
  gitlab: {
    baseUrl: string;
    token: string;
  };
  webhook: {
    secret: string;
    port: number;
    taskConcurrency: number;
  };
  ai: {
    defaultProvider: PublicRuntimeConfig['ai']['defaultProvider'];
  };
  review: PublicRuntimeConfig['review'];
  workDir: string;
  logLevel: string;
};

const CLAUDE_REASONING_OPTIONS: ClaudeReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const CODEX_REASONING_OPTIONS: CodexReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function toDraft(config: PublicRuntimeConfig): DraftConfig {
  return {
    claude: {
      baseUrl: config.claude.baseUrl,
      authToken: '',
      defaultModel: config.claude.defaultModel,
      reasoningEffort: config.claude.reasoningEffort,
      defaultTimeoutMinutes: config.claude.defaultTimeoutMinutes,
    },
    codex: {
      baseUrl: config.codex.baseUrl,
      apiKey: '',
      defaultModel: config.codex.defaultModel,
      reasoningEffort: config.codex.reasoningEffort,
      defaultTimeoutMinutes: config.codex.defaultTimeoutMinutes,
    },
    gitlab: {
      baseUrl: config.gitlab.baseUrl,
      token: '',
    },
    webhook: {
      secret: '',
      port: config.webhook.port,
      taskConcurrency: config.webhook.taskConcurrency,
    },
    ai: {
      defaultProvider: config.ai.defaultProvider,
    },
    review: {
      ...config.review,
      allowedCommands: [...config.review.allowedCommands],
    },
    workDir: config.workDir,
    logLevel: config.logLevel,
  };
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAllowedCommands(value: string): string[] {
  return value
    .split('\n')
    .map(command => command.trim())
    .filter(Boolean);
}

function buildPatch(draft: DraftConfig): RuntimeConfigPatch {
  const patch: RuntimeConfigPatch = {
    ai: {
      defaultProvider: draft.ai.defaultProvider,
    },
    claude: {
      baseUrl: draft.claude.baseUrl.trim(),
      defaultModel: draft.claude.defaultModel.trim(),
      reasoningEffort: draft.claude.reasoningEffort,
      defaultTimeoutMinutes: draft.claude.defaultTimeoutMinutes,
    },
    codex: {
      baseUrl: draft.codex.baseUrl.trim(),
      defaultModel: draft.codex.defaultModel.trim(),
      reasoningEffort: draft.codex.reasoningEffort,
      defaultTimeoutMinutes: draft.codex.defaultTimeoutMinutes,
    },
    gitlab: {
      baseUrl: draft.gitlab.baseUrl.trim(),
    },
    webhook: {
      port: draft.webhook.port,
      taskConcurrency: draft.webhook.taskConcurrency,
    },
    review: {
      enabled: draft.review.enabled,
      defaultProvider: draft.review.defaultProvider,
      minConfidence: draft.review.minConfidence,
      maxCandidateFindings: draft.review.maxCandidateFindings,
      maxFinalFindings: draft.review.maxFinalFindings,
      passConcurrency: draft.review.passConcurrency,
      scoringConcurrency: draft.review.scoringConcurrency,
      skipDraft: draft.review.skipDraft,
      skipExistingSha: draft.review.skipExistingSha,
      allowedCommands: draft.review.allowedCommands,
    },
    workDir: draft.workDir.trim(),
    logLevel: draft.logLevel,
  };

  if (draft.claude.authToken.trim()) {
    patch.claude = { ...patch.claude, authToken: draft.claude.authToken.trim() };
  }
  if (draft.codex.apiKey.trim()) {
    patch.codex = { ...patch.codex, apiKey: draft.codex.apiKey.trim() };
  }
  if (draft.gitlab.token.trim()) {
    patch.gitlab = { ...patch.gitlab, token: draft.gitlab.token.trim() };
  }
  if (draft.webhook.secret.trim()) {
    patch.webhook = { ...patch.webhook, secret: draft.webhook.secret.trim() };
  }

  return patch;
}

function restartMessage(result: ConfigUpdateResult): string {
  if (result.requiresRestart.length === 0) {
    return 'Saved. Hot-applied fields are active for new tasks immediately.';
  }

  return `Saved. Restart required for: ${result.requiresRestart.join(', ')}.`;
}

export default function Settings() {
  const [config, setConfig] = useState<PublicRuntimeConfig | null>(null);
  const [draft, setDraft] = useState<DraftConfig | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState<ProviderTestResult['provider'] | null>(null);

  useEffect(() => {
    let active = true;

    api
      .getConfig()
      .then(result => {
        if (!active) {
          return;
        }
        setConfig(result);
        setDraft(toDraft(result));
        setError('');
      })
      .catch(err => {
        if (!active) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const allowedCommandsValue = useMemo(
    () => (draft ? draft.review.allowedCommands.join('\n') : ''),
    [draft]
  );

  function updateDraft(updater: (current: DraftConfig) => DraftConfig) {
    setDraft(current => (current ? updater(current) : current));
  }

  function updateNumber(
    scope: 'claude' | 'codex' | 'webhook',
    field: string,
    fallback: number
  ) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = parseInteger(event.target.value, fallback);
      updateDraft(current => ({
        ...current,
        [scope]: {
          ...current[scope],
          [field]: nextValue,
        },
      }));
    };
  }

  function updateReviewNumber(field: keyof DraftConfig['review']) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      updateDraft(current => ({
        ...current,
        review: {
          ...current.review,
          [field]: parseInteger(event.target.value, current.review[field] as number),
        },
      }));
    };
  }

  function updateCheckbox(field: 'enabled' | 'skipDraft' | 'skipExistingSha') {
    return (event: ChangeEvent<HTMLInputElement>) => {
      updateDraft(current => ({
        ...current,
        review: {
          ...current.review,
          [field]: event.target.checked,
        },
      }));
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) {
      return;
    }

    setSaving(true);
    setMessage('');
    setError('');
    setTestResult(null);

    try {
      const result = await api.updateConfig(buildPatch(draft));
      setConfig(result.config);
      setDraft(toDraft(result.config));
      setMessage(restartMessage(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function testProvider(provider: ProviderTestResult['provider']) {
    setTestingProvider(provider);
    setError('');
    setMessage('');
    try {
      setTestResult(await api.testProvider(provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTestResult(null);
    } finally {
      setTestingProvider(null);
    }
  }

  if (loading || !draft || !config) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Runtime Settings</h1>
            <p>Loading current runtime configuration from `/api/admin/config`.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className="page" onSubmit={save}>
      <div className="page-header">
        <div>
          <h1>Runtime Settings</h1>
          <p>Update provider defaults, review controls, secrets, and restart-sensitive runtime fields.</p>
        </div>
        <div className="header-actions">
          <button className="button subtle" type="button" onClick={() => setDraft(toDraft(config))}>
            <RefreshCw size={16} />
            Reset draft
          </button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            Save
          </button>
        </div>
      </div>

      {message ? (
        <section className={`banner ${message.includes('Restart required') ? 'warn' : 'ok'}`}>
          <div>
            <strong>{message.includes('Restart required') ? 'Saved with restart notice' : 'Saved'}</strong>
            <p>{message}</p>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="banner error">
          <div>
            <strong>Request failed</strong>
            <p>{error}</p>
          </div>
        </section>
      ) : null}

      {testResult ? (
        <section className={`banner ${testResult.ok ? 'ok' : 'warn'}`}>
          <div>
            <strong>{testResult.provider} test</strong>
            <p>{testResult.message}</p>
          </div>
        </section>
      ) : null}

      <div className="grid two">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>AI defaults</h2>
              <p>Provider selection and default execution settings for new tasks.</p>
            </div>
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="default-provider">Default provider</label>
              <select
                id="default-provider"
                value={draft.ai.defaultProvider}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    ai: { defaultProvider: event.target.value as DraftConfig['ai']['defaultProvider'] },
                  }))
                }
              >
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </div>
          </div>
          <div className="field-grid two">
            <div className="field">
              <label htmlFor="claude-base-url">Claude base URL</label>
              <input
                id="claude-base-url"
                value={draft.claude.baseUrl}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    claude: { ...current.claude, baseUrl: event.target.value },
                  }))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="claude-model">Claude model</label>
              <input
                id="claude-model"
                value={draft.claude.defaultModel}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    claude: { ...current.claude, defaultModel: event.target.value },
                  }))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="claude-reasoning">Claude reasoning effort</label>
              <select
                id="claude-reasoning"
                value={draft.claude.reasoningEffort}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    claude: {
                      ...current.claude,
                      reasoningEffort: event.target.value as ClaudeReasoningEffort,
                    },
                  }))
                }
              >
                {CLAUDE_REASONING_OPTIONS.map(option => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="claude-timeout">Claude timeout (minutes)</label>
              <input
                id="claude-timeout"
                type="number"
                value={draft.claude.defaultTimeoutMinutes}
                onChange={updateNumber('claude', 'defaultTimeoutMinutes', draft.claude.defaultTimeoutMinutes)}
              />
            </div>
            <div className="field">
              <label htmlFor="claude-token">Claude token replacement</label>
              <input
                id="claude-token"
                type="password"
                value={draft.claude.authToken}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    claude: { ...current.claude, authToken: event.target.value },
                  }))
                }
              />
              <span className="field-meta mono">
                Current status: {config.claude.authToken.configured ? config.claude.authToken.masked : 'missing'}
              </span>
            </div>
          </div>
          <div className="field-grid two">
            <div className="field">
              <label htmlFor="codex-base-url">Codex base URL</label>
              <input
                id="codex-base-url"
                value={draft.codex.baseUrl}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    codex: { ...current.codex, baseUrl: event.target.value },
                  }))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="codex-model">Codex model</label>
              <input
                id="codex-model"
                value={draft.codex.defaultModel}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    codex: { ...current.codex, defaultModel: event.target.value },
                  }))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="codex-reasoning">Codex reasoning effort</label>
              <select
                id="codex-reasoning"
                value={draft.codex.reasoningEffort}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    codex: {
                      ...current.codex,
                      reasoningEffort: event.target.value as DraftConfig['codex']['reasoningEffort'],
                    },
                  }))
                }
              >
                {CODEX_REASONING_OPTIONS.map(option => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="codex-timeout">Codex timeout (minutes)</label>
              <input
                id="codex-timeout"
                type="number"
                value={draft.codex.defaultTimeoutMinutes}
                onChange={updateNumber('codex', 'defaultTimeoutMinutes', draft.codex.defaultTimeoutMinutes)}
              />
            </div>
            <div className="field">
              <label htmlFor="codex-api-key">Codex API key replacement</label>
              <input
                id="codex-api-key"
                type="password"
                value={draft.codex.apiKey}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    codex: { ...current.codex, apiKey: event.target.value },
                  }))
                }
              />
              <span className="field-meta mono">
                Current status: {config.codex.apiKey.configured ? config.codex.apiKey.masked : 'missing'}
              </span>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Provider endpoints and tests</h2>
              <p>Update endpoint defaults and check whether the backend considers each provider configured.</p>
            </div>
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="gitlab-base-url">GitLab base URL</label>
              <input
                id="gitlab-base-url"
                value={draft.gitlab.baseUrl}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    gitlab: { ...current.gitlab, baseUrl: event.target.value },
                  }))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="gitlab-token">GitLab token replacement</label>
              <input
                id="gitlab-token"
                type="password"
                value={draft.gitlab.token}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    gitlab: { ...current.gitlab, token: event.target.value },
                  }))
                }
              />
              <span className="field-meta mono">
                Current status: {config.gitlab.token.configured ? config.gitlab.token.masked : 'missing'}
              </span>
            </div>
          </div>
          <div className="button-row">
            {(['gitlab', 'claude', 'codex'] as const).map(provider => (
              <button
                key={provider}
                className="button"
                type="button"
                onClick={() => testProvider(provider)}
                disabled={testingProvider !== null}
              >
                {testingProvider === provider ? <LoaderCircle size={16} /> : <TestTube2 size={16} />}
                Test {provider}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="grid two">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Review controls</h2>
              <p>Booleans, thresholds, candidate caps, concurrency limits, and command allow-list.</p>
            </div>
          </div>
          <div className="field-grid two">
            <div className="field">
              <label htmlFor="review-provider">Review provider</label>
              <select
                id="review-provider"
                value={draft.review.defaultProvider}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    review: {
                      ...current.review,
                      defaultProvider: event.target.value as DraftConfig['review']['defaultProvider'],
                    },
                  }))
                }
              >
                <option value="claude-multipass">claude-multipass</option>
                <option value="codex-multipass">codex-multipass</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="review-enabled">Review enabled</label>
              <select
                id="review-enabled"
                value={draft.review.enabled ? 'true' : 'false'}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    review: {
                      ...current.review,
                      enabled: event.target.value === 'true',
                    },
                  }))
                }
              >
                <option value="true">enabled</option>
                <option value="false">disabled</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="min-confidence">Minimum confidence</label>
              <input
                id="min-confidence"
                type="number"
                value={draft.review.minConfidence}
                onChange={updateReviewNumber('minConfidence')}
              />
            </div>
            <div className="field">
              <label htmlFor="max-candidate-findings">Max candidate findings</label>
              <input
                id="max-candidate-findings"
                type="number"
                value={draft.review.maxCandidateFindings}
                onChange={updateReviewNumber('maxCandidateFindings')}
              />
            </div>
            <div className="field">
              <label htmlFor="max-final-findings">Max final findings</label>
              <input
                id="max-final-findings"
                type="number"
                value={draft.review.maxFinalFindings}
                onChange={updateReviewNumber('maxFinalFindings')}
              />
            </div>
            <div className="field">
              <label htmlFor="pass-concurrency">Pass concurrency</label>
              <input
                id="pass-concurrency"
                type="number"
                value={draft.review.passConcurrency}
                onChange={updateReviewNumber('passConcurrency')}
              />
            </div>
            <div className="field">
              <label htmlFor="scoring-concurrency">Scoring concurrency</label>
              <input
                id="scoring-concurrency"
                type="number"
                value={draft.review.scoringConcurrency}
                onChange={updateReviewNumber('scoringConcurrency')}
              />
            </div>
          </div>
          <div className="checkbox-grid">
            <div className="checkbox-row">
              <input
                id="skip-draft"
                type="checkbox"
                checked={draft.review.skipDraft}
                onChange={updateCheckbox('skipDraft')}
              />
              <label htmlFor="skip-draft">
                <strong>Skip draft merge requests</strong>
                <span className="field-hint">Avoid review execution for draft MRs.</span>
              </label>
            </div>
            <div className="checkbox-row">
              <input
                id="skip-existing-sha"
                type="checkbox"
                checked={draft.review.skipExistingSha}
                onChange={updateCheckbox('skipExistingSha')}
              />
              <label htmlFor="skip-existing-sha">
                <strong>Skip existing head SHA</strong>
                <span className="field-hint">Preserve the duplicate-review guard for already-processed SHAs.</span>
              </label>
            </div>
          </div>
          <div className="field">
            <label htmlFor="allowed-commands">Allowed commands</label>
            <textarea
              id="allowed-commands"
              value={allowedCommandsValue}
              onChange={event =>
                updateDraft(current => ({
                  ...current,
                  review: {
                    ...current.review,
                    allowedCommands: parseAllowedCommands(event.target.value),
                  },
                }))
              }
            />
            <span className="field-hint">One command per line. Empty lines are ignored.</span>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Runtime and restart-only fields</h2>
              <p>Operational fields outside provider/review configuration, including restart-sensitive values.</p>
            </div>
          </div>
          <div className="field-grid two">
            <div className="field">
              <label htmlFor="work-dir">Work directory</label>
              <input
                id="work-dir"
                value={draft.workDir}
                onChange={event => updateDraft(current => ({ ...current, workDir: event.target.value }))}
              />
              <span className="field-hint">Changing `workDir` is persisted but requires restart to affect the service.</span>
            </div>
            <div className="field">
              <label htmlFor="log-level">Log level</label>
              <select
                id="log-level"
                value={draft.logLevel}
                onChange={event => updateDraft(current => ({ ...current, logLevel: event.target.value }))}
              >
                {LOG_LEVELS.map(level => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="webhook-port">Webhook port</label>
              <input
                id="webhook-port"
                type="number"
                value={draft.webhook.port}
                onChange={updateNumber('webhook', 'port', draft.webhook.port)}
              />
              <span className="field-hint">Changing the port requires process restart.</span>
            </div>
            <div className="field">
              <label htmlFor="webhook-task-concurrency">Webhook task concurrency</label>
              <input
                id="webhook-task-concurrency"
                type="number"
                min={1}
                value={draft.webhook.taskConcurrency}
                onChange={updateNumber(
                  'webhook',
                  'taskConcurrency',
                  draft.webhook.taskConcurrency
                )}
              />
              <span className="field-hint">Hot-applied to queued and future webhook tasks.</span>
            </div>
            <div className="field">
              <label htmlFor="webhook-secret">Webhook secret replacement</label>
              <input
                id="webhook-secret"
                type="password"
                value={draft.webhook.secret}
                onChange={event =>
                  updateDraft(current => ({
                    ...current,
                    webhook: { ...current.webhook, secret: event.target.value },
                  }))
                }
              />
              <span className="field-meta mono">
                Current status: {config.webhook.secret.configured ? config.webhook.secret.masked : 'missing'}
              </span>
            </div>
          </div>
        </section>
      </div>

      <section className="table-card">
        <div className="panel-header">
          <div>
            <h2>Current secret and restart summary</h2>
            <p>Quick operator view of masked secrets and whether each one is configured.</p>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Status</th>
              <th>Masked value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Claude token</td>
              <td>{config.claude.authToken.configured ? <span className="status-ok">configured</span> : <span className="status-warn">missing</span>}</td>
              <td className="mono">{config.claude.authToken.masked || '--'}</td>
            </tr>
            <tr>
              <td>Codex API key</td>
              <td>{config.codex.apiKey.configured ? <span className="status-ok">configured</span> : <span className="status-warn">missing</span>}</td>
              <td className="mono">{config.codex.apiKey.masked || '--'}</td>
            </tr>
            <tr>
              <td>GitLab token</td>
              <td>{config.gitlab.token.configured ? <span className="status-ok">configured</span> : <span className="status-warn">missing</span>}</td>
              <td className="mono">{config.gitlab.token.masked || '--'}</td>
            </tr>
            <tr>
              <td>Webhook secret</td>
              <td>{config.webhook.secret.configured ? <span className="status-ok">configured</span> : <span className="status-warn">missing</span>}</td>
              <td className="mono">{config.webhook.secret.masked || '--'}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </form>
  );
}

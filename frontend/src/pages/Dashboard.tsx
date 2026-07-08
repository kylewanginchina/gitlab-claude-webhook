import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  KeyRound,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { api } from '../api';
import type { AdminStatus, PublicRuntimeConfig } from '../types';

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${remainder}s`);
  return parts.join(' ');
}

export default function Dashboard() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [config, setConfig] = useState<PublicRuntimeConfig | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    Promise.all([api.getStatus(), api.getConfig()])
      .then(([statusResult, configResult]) => {
        if (!active) {
          return;
        }
        setStatus(statusResult);
        setConfig(configResult);
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

  const secretSummary = useMemo(() => {
    if (!config) {
      return [];
    }

    return [
      { label: 'GitLab token', status: config.gitlab.token.configured, masked: config.gitlab.token.masked },
      { label: 'Claude token', status: config.claude.authToken.configured, masked: config.claude.authToken.masked },
      { label: 'Codex API key', status: config.codex.apiKey.configured, masked: config.codex.apiKey.masked },
      { label: 'Webhook secret', status: config.webhook.secret.configured, masked: config.webhook.secret.masked },
    ];
  }, [config]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Current service status, runtime defaults, and the masked configuration that new tasks will inherit.</p>
        </div>
      </div>

      {error ? (
        <section className="banner error">
          <div>
            <strong>Unable to load admin data</strong>
            <p>{error}</p>
          </div>
        </section>
      ) : null}

      <div className="metrics-grid">
        <section className="metric-card">
          <div className="metric-topline">
            <span className="metric-label">Service status</span>
            <Activity size={16} />
          </div>
          <div className="metric-value">{status?.status || (loading ? 'loading' : 'unknown')}</div>
          <div className="metric-meta">
            <span className={status?.status === 'ok' ? 'status-ok' : 'status-warn'}>
              {status?.configLoaded ? 'Runtime config loaded' : 'Runtime config unavailable'}
            </span>
          </div>
        </section>
        <section className="metric-card">
          <div className="metric-topline">
            <span className="metric-label">Uptime</span>
            <Clock3 size={16} />
          </div>
          <div className="metric-value">{status ? formatUptime(status.uptime) : '--'}</div>
          <div className="metric-meta">
            <span>Version {status?.version || '--'}</span>
          </div>
        </section>
        <section className="metric-card">
          <div className="metric-topline">
            <span className="metric-label">Default provider</span>
            <Bot size={16} />
          </div>
          <div className="metric-value">{config?.ai.defaultProvider || '--'}</div>
          <div className="metric-meta">
            <span>Review provider {config?.review.defaultProvider || '--'}</span>
          </div>
        </section>
        <section className="metric-card">
          <div className="metric-topline">
            <span className="metric-label">Review pipeline</span>
            <ShieldCheck size={16} />
          </div>
          <div className="metric-value">{config?.review.enabled ? 'enabled' : 'disabled'}</div>
          <div className="metric-meta">
            <span>Confidence floor {config?.review.minConfidence ?? '--'}</span>
          </div>
        </section>
      </div>

      <div className="grid two">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Provider defaults</h2>
              <p>Base URLs, models, timeouts, and review execution caps currently exposed by `/api/admin/config`.</p>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Area</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Claude</td>
                <td className="mono">
                  {config?.claude.defaultModel || '--'} @ {config?.claude.baseUrl || '--'} /{' '}
                  {config?.claude.defaultTimeoutMinutes ?? '--'}m / {config?.claude.reasoningEffort || '--'}
                </td>
              </tr>
              <tr>
                <td>Codex</td>
                <td className="mono">
                  {config?.codex.defaultModel || '--'} @ {config?.codex.baseUrl || '--'} /{' '}
                  {config?.codex.defaultTimeoutMinutes ?? '--'}m / {config?.codex.reasoningEffort || '--'}
                </td>
              </tr>
              <tr>
                <td>GitLab</td>
                <td className="mono">{config?.gitlab.baseUrl || '--'}</td>
              </tr>
              <tr>
                <td>Review caps</td>
                <td className="mono">
                  candidates {config?.review.maxCandidateFindings ?? '--'} / final {config?.review.maxFinalFindings ?? '--'}
                </td>
              </tr>
              <tr>
                <td>Concurrency</td>
                <td className="mono">
                  webhook tasks {config?.webhook.taskConcurrency ?? '--'} / pass{' '}
                  {config?.review.passConcurrency ?? '--'} / scoring{' '}
                  {config?.review.scoringConcurrency ?? '--'}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Secret status</h2>
              <p>Masked values only. Replacements are entered from the runtime settings page.</p>
            </div>
          </div>
          <div className="field-grid">
            {secretSummary.map(secret => (
              <div key={secret.label} className="checkbox-row">
                <div>
                  {secret.status ? <CheckCircle2 className="status-ok" size={16} /> : <TriangleAlert className="status-warn" size={16} />}
                </div>
                <div>
                  <strong>{secret.label}</strong>
                  <div className="field-meta mono">{secret.status ? secret.masked : 'missing'}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid two">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Runtime fields</h2>
              <p>Values that affect process behavior or require restart are broken out separately for operator visibility.</p>
            </div>
          </div>
          <table className="table">
            <tbody>
              <tr>
                <th>Work dir</th>
                <td className="mono">{config?.workDir || '--'}</td>
              </tr>
              <tr>
                <th>Webhook port</th>
                <td className="mono">{config?.webhook.port ?? '--'} (restart required)</td>
              </tr>
              <tr>
                <th>Webhook task concurrency</th>
                <td className="mono">{config?.webhook.taskConcurrency ?? '--'} (hot applied)</td>
              </tr>
              <tr>
                <th>Log level</th>
                <td className="mono">{config?.logLevel || '--'}</td>
              </tr>
              <tr>
                <th>Allowed commands</th>
                <td className="mono">{config?.review.allowedCommands.join(', ') || '--'}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Review behavior</h2>
              <p>Skip flags and gating conditions currently applied to new review runs.</p>
            </div>
          </div>
          <div className="field-grid">
            <div className="checkbox-row">
              <KeyRound size={16} />
              <div>
                <strong>Skip draft merge requests</strong>
                <div className="field-meta">{config?.review.skipDraft ? 'Enabled' : 'Disabled'}</div>
              </div>
            </div>
            <div className="checkbox-row">
              <Wrench size={16} />
              <div>
                <strong>Skip existing head SHA</strong>
                <div className="field-meta">{config?.review.skipExistingSha ? 'Enabled' : 'Disabled'}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

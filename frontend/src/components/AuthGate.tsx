import { FormEvent, PropsWithChildren, useEffect, useState } from 'react';
import { KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api, getAdminKey, setAdminKey } from '../api';

export default function AuthGate({ children }: PropsWithChildren) {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [adminKey, setAdminKeyInput] = useState(getAdminKey());
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getStatus()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false))
      .finally(() => setChecking(false));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setAdminKey(adminKey);
    try {
      await api.getStatus();
      setAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAuthenticated(false);
    }
  }

  if (checking) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="split-title">
            <ShieldCheck size={18} />
            <strong>Admin authentication</strong>
          </div>
          <p className="auth-subtitle">Checking the current admin key against `/api/admin/status`.</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={submit}>
          <div className="split-title">
            <LockKeyhole size={18} />
            <h1>GitLab Claude Webhook</h1>
          </div>
          <p className="auth-subtitle">
            Enter the admin key stored in `ADMIN_TOKEN` to manage runtime configuration under `/admin`.
          </p>
          <div className="field">
            <label htmlFor="admin-key">Admin key</label>
            <input
              id="admin-key"
              type="password"
              value={adminKey}
              onChange={event => setAdminKeyInput(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error ? <p className="status-error">{error}</p> : null}
          <div className="button-row">
            <button className="button primary" type="submit">
              <KeyRound size={16} />
              Sign in
            </button>
          </div>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}

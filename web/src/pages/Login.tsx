import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { errorMessage } from '../util';
import { Credit } from '../components/Bits';

/** Where to go after signing in: the page that sent us to /login (e.g. a "/?task=12" link), else the board. */
export function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  // In-app paths only: must start with a single "/" and must not loop back to /login.
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login') ? from : '/';
}

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);

  useEffect(() => {
    api.get<{ setupRequired: boolean }>('/api/auth/status').then((r) => setSetupRequired(r.setupRequired)).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { username: username.trim(), password, remember });
      await qc.resetQueries();
      navigate(returnPath(location.state), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="row" style={{ gap: 10 }}>
          <img src="/icon.svg" width={36} height={36} alt="" />
          <h1>Project Manager</h1>
        </div>
        <label className="field">Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus required />
        </label>
        <label className="field">Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <label className="row nowrap small">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep me signed in on this device
        </label>
        {setupRequired && (
          <div className="small" style={{ background: 'var(--primary-soft)', padding: 10, borderRadius: 8 }}>
            <b>First-time setup:</b> no account exists yet. On the server, run{' '}
            <code>npm run user -- add &lt;name&gt;</code> in the project folder, then sign in here.
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <Credit />
      </form>
    </div>
  );
}

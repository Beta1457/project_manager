import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, V1 } from '../api';
import { useMe, useMeta } from '../hooks';
import { useMutate } from '../mutate';
import { copyText, formatBytes, plural, timeAgo } from '../util';
import type { Project } from '../types';
import { NewProjectForm, PROJECT_KEY_RE } from '../project';
import { useProject } from '../projectContext';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/Layout';
import { askConfirm } from '../components/Confirm';
import { ColorInput, Credit, StatusPill, TypeBadge } from '../components/Bits';

interface Token { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; owner: string }
interface UserRow { id: number; username: string; isAdmin: boolean; projectCount: number; createdAt: string }
interface Backups { intervalHours: number; keep: number; directory: string; backups: Array<{ name: string; size: number; createdAt: string }> }

export function SettingsPage() {
  const isAdmin = useMe().data?.user.isAdmin ?? false;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="content">
        <div className="stack" style={{ maxWidth: 760 }}>
          <Account />
          <Projects />
          <BoardColumns />
          <Types />
          <Categories />
          <Tokens />
          {isAdmin && <Users />}
          {isAdmin && <BackupsCard />}
          <Credit />
        </div>
      </div>
    </>
  );
}

/** "for My game": the settings below this point apply to the current project only. */
function ForProject() {
  const { project } = useProject();
  return <span className="small muted" style={{ fontWeight: 400 }}> · {project.name}</span>;
}

function Projects() {
  const { project: current, projects, switchTo } = useProject();
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  // "Manage projects…" in the switcher links here.
  useEffect(() => {
    if (hash === '#projects') ref.current?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return (
    <section id="projects" ref={ref} className="card panel stack">
      <div className="row">
        <h2 className="grow">Projects</h2>
        {!adding && <button className="btn btn-sm" onClick={() => setAdding(true)}>+ New project</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Each project has its own board, epochs, files, diagram, task types and categories. Only you can see your projects.
      </p>
      {projects.map((p) => (
        <ProjectRow key={p.id} project={p} current={p.id === current.id} onOpen={() => switchTo(p.id)} />
      ))}
      {adding && (
        <div className="card panel stack">
          <div className="row"><b className="grow">New project</b><button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button></div>
          <NewProjectForm projects={projects} onCreated={(p) => { setAdding(false); switchTo(p.id); }} />
        </div>
      )}
    </section>
  );
}

function ProjectRow({ project: p, current, onOpen }: { project: Project; current: boolean; onOpen: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const [key, setKey] = useState(p.key);
  useEffect(() => setKey(p.key), [p.key]);
  const patch = (body: Partial<Pick<Project, 'key' | 'name' | 'color'>>) => mutate(() => api.patch(`${V1}/projects/${p.id}`, body), ['projects']);

  const saveKey = async () => {
    const next = key.trim().toUpperCase();
    if (next === p.key) return;
    if (!PROJECT_KEY_RE.test(next)) {
      toast('A key is 1–10 letters or digits and starts with a letter', 'error');
      return setKey(p.key);
    }
    const ok = await askConfirm({
      title: `Change the key from ${p.key} to ${next}?`,
      body:
        `Every task is renamed (${p.key}-12 becomes ${next}-12). ` +
        `Notes, commits and messages elsewhere that mention ${p.key}-… keep the old key.`,
      confirmLabel: 'Change key',
      danger: false,
    });
    if (!ok || !(await patch({ key: next }))) setKey(p.key);
  };

  const remove = async () => {
    const ok = await askConfirm({
      title: `Delete ${p.name}?`,
      body:
        `Everything in it will be deleted: ${plural(p.taskCount, 'task')}, epochs, folders, files, diagrams and time entries. ` +
        'This can’t be undone (a backup made before now would still have it).',
      confirmLabel: 'Delete project',
      typeToConfirm: p.key,
    });
    if (!ok) return;
    await mutate(() => api.del(`${V1}/projects/${p.id}?confirm=${encodeURIComponent(p.key)}`), ['projects'], `Deleted ${p.name}`);
  };

  return (
    <div className="project-row">
      <ColorInput value={p.color} label={`${p.name} colour`} onCommit={(color) => patch({ color })} />
      <input value={key} maxLength={10} aria-label={`${p.name} key`} style={{ width: '7.5em', fontFamily: 'ui-monospace, Consolas, monospace' }}
        onChange={(e) => setKey(e.target.value.toUpperCase())} onBlur={saveKey}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      <input key={p.name} defaultValue={p.name} aria-label="Project name" maxLength={100}
        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== p.name) void patch({ name: v }); }} />
      <div className="row nowrap">
        {current ? <span className="current">Current</span> : <button className="btn btn-sm" onClick={onOpen}>Open</button>}
        <button className="btn btn-ghost btn-danger btn-sm" aria-label={`Delete project ${p.name}`} onClick={remove}>✕</button>
      </div>
      <div className="tiny muted" style={{ gridColumn: '2 / -1' }}>{p.openTaskCount} open · {p.taskCount} total</div>
    </div>
  );
}

function Account() {
  const me = useMe().data;
  const qc = useQueryClient();
  const mutate = useMutate();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    window.location.href = '/login';
  };
  return (
    <section className="card panel stack">
      <h2>Account</h2>
      <div className="row"><span className="grow">Signed in as <b>{me?.user.username}</b></span><button className="btn" onClick={logout}>Log out</button></div>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        const ok = await mutate(() => api.post('/api/auth/password', { currentPassword: cur, newPassword: next }), [], 'Password changed — please log in again');
        if (ok) window.setTimeout(() => (window.location.href = '/login'), 1200);
      }}>
        <input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" style={{ flex: '1 1 160px' }} />
        <input type="password" placeholder="New password (8+ chars)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" style={{ flex: '1 1 160px' }} />
        <button className="btn" type="submit" disabled={!cur || next.length < 8}>Change password</button>
      </form>
    </section>
  );
}

function Categories() {
  const meta = useMeta().data;
  const mutate = useMutate();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563eb');
  return (
    <section className="card panel stack">
      <h2>Categories<ForProject /></h2>
      {meta?.categories.map((c) => (
        <div key={c.id} className="row nowrap">
          <ColorInput value={c.color} label={`${c.name} color`} onCommit={(color) => mutate(() => api.patch(`${V1}/categories/${c.id}`, { color }), ['categories'])} />
          <input defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && mutate(() => api.patch(`${V1}/categories/${c.id}`, { name: e.target.value.trim() }), ['categories'])} />
          <button className="btn btn-ghost btn-danger" aria-label={`Delete category ${c.name}`} onClick={async () => {
            const ok = await askConfirm({ title: 'Delete category?', body: `"${c.name}" will be removed from every task that has it. This can’t be undone.`, confirmLabel: 'Delete category' });
            if (ok) await mutate(() => api.del(`${V1}/categories/${c.id}`), ['categories']);
          }}>✕</button>
        </div>
      ))}
      <form className="row nowrap" onSubmit={async (e) => {
        e.preventDefault();
        if (await mutate(() => api.post(`${V1}/categories`, { name, color }), ['categories'])) setName('');
      }}>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>Add</button>
      </form>
    </section>
  );
}

function Types() {
  const meta = useMeta().data;
  const mutate = useMutate();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0891b2');
  return (
    <section className="card panel stack">
      <h2>Task types<ForProject /></h2>
      <p className="small muted" style={{ margin: 0 }}>Each type gets a coloured badge on cards and in the list.</p>
      {meta?.types.map((t) => (
        <div key={t} className="row nowrap">
          <ColorInput value={meta.typeColors[t] ?? '#64748b'} label={`${t} color`} onCommit={(color) => mutate(() => api.patch(`${V1}/types/${encodeURIComponent(t)}`, { color }), ['types', 'tasks'])} />
          <TypeBadge type={t} />
          <span className="grow" />
          <button className="btn btn-ghost btn-danger" aria-label={`Delete type ${t}`}
            onClick={async () => {
              const ok = await askConfirm({ title: 'Delete task type?', body: `"${t}" will be removed from the list of types. A type that tasks still use can’t be deleted.`, confirmLabel: 'Delete type' });
              if (ok) await mutate(() => api.del(`${V1}/types/${encodeURIComponent(t)}`), ['types']);
            }}>✕</button>
        </div>
      ))}
      <form className="row nowrap" onSubmit={async (e) => {
        e.preventDefault();
        if (await mutate(() => api.post(`${V1}/types`, { name, color }), ['types'])) setName('');
      }}>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input placeholder="New type" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>Add</button>
      </form>
    </section>
  );
}

function BoardColumns() {
  const meta = useMeta().data;
  const mutate = useMutate();
  return (
    <section className="card panel stack">
      <h2>Board column colours<ForProject /></h2>
      {meta?.statuses.map((s) => (
        <div key={s.id} className="row nowrap">
          <ColorInput value={s.color} label={`${s.label} color`} onCommit={(color) => mutate(() => api.patch(`${V1}/statuses/${s.id}`, { color }), ['types'])} />
          <StatusPill status={s.id} label={s.label} />
        </div>
      ))}
    </section>
  );
}

function Tokens() {
  const { data } = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<{ tokens: Token[] }>(`${V1}/tokens`) });
  const qc = useQueryClient();
  const mutate = useMutate();
  const toast = useToast();
  const { project } = useProject();
  const [name, setName] = useState('claude');
  const [created, setCreated] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tokens'] });
  return (
    <section className="card panel stack">
      <h2>API tokens</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Tokens let coding agents (Claude Code, Codex, Cursor…) and scripts use the API as you, in any of your projects (each repo’s <code>.pm.json</code> says which).
        The token name appears in task activity (e.g. “claude moved {project.key}-4 to Alpha QA”).
      </p>
      {created && (
        <div className="stack" style={{ gap: 6 }}>
          <b>Copy this token now — it won't be shown again:</b>
          <div className="token-box">{created}</div>
          <div className="row">
            <button
              className="btn btn-sm"
              onClick={async () =>
                (await copyText(created)) ? toast('Token copied') : toast('Could not copy — select the token above and copy it manually', 'error')
              }
            >
              Copy
            </button>
            <button className="btn btn-sm" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      )}
      {data?.tokens.map((t) => (
        <div key={t.id} className="row nowrap small">
          <b>{t.name}</b>
          <span className="key">{t.prefix}…</span>
          <span className="grow muted">created {timeAgo(t.createdAt)} · {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}</span>
          <button className="btn btn-sm btn-danger" onClick={async () => {
            const ok = await askConfirm({
              title: 'Revoke token?',
              body: `Anything using "${t.name}", such as a coding agent’s pm tool, will stop working until it gets a new token.`,
              confirmLabel: 'Revoke token',
            });
            if (!ok) return;
            await mutate(() => api.del(`${V1}/tokens/${t.id}`), []);
            void refresh();
          }}>Revoke</button>
        </div>
      ))}
      <form className="row nowrap" onSubmit={async (e) => {
        e.preventDefault();
        const r = await mutate(() => api.post<{ token: string }>(`${V1}/tokens`, { name }), []);
        if (r) { setCreated(r.token); void refresh(); }
      }}>
        <input placeholder="Token name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>Create token</button>
      </form>
    </section>
  );
}

function Users() {
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: UserRow[] }>(`${V1}/users`) });
  const me = useMe().data;
  const qc = useQueryClient();
  const mutate = useMutate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const remove = async (u: UserRow) => {
    const ok = await askConfirm({
      title: `Delete user ${u.username}?`,
      body: u.projectCount
        ? `Their ${plural(u.projectCount, 'project')} and everything in them will be deleted too. This can’t be undone.`
        : 'They will no longer be able to sign in. This can’t be undone.',
      confirmLabel: 'Delete user',
      typeToConfirm: u.projectCount ? u.username : undefined,
    });
    if (!ok) return;
    await mutate(() => api.del(`${V1}/users/${u.id}${u.projectCount ? '?deleteProjects=true' : ''}`), []);
    void refresh();
  };
  return (
    <section className="card panel stack">
      <h2>Users</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Everyone gets their own projects; nobody (admins included) can see anyone else’s. Admins add and remove accounts and see backups.
      </p>
      {data?.users.map((u) => (
        <div key={u.id} className="row nowrap">
          <span className="grow">
            <b>{u.username}</b>{u.isAdmin && <span className="small muted"> (admin)</span>}{' '}
            <span className="small muted">· {u.projectCount} project{u.projectCount === 1 ? '' : 's'} · since {new Date(u.createdAt).toLocaleDateString()}</span>
          </span>
          {u.id !== me?.user.id && <button className="btn btn-sm btn-danger" aria-label={`Delete user ${u.username}`} onClick={() => void remove(u)}>Delete</button>}
        </div>
      ))}
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        if (await mutate(() => api.post(`${V1}/users`, { username, password, admin }), [], 'User added')) {
          setUsername(''); setPassword(''); setAdmin(false); void refresh();
        }
      }}>
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" style={{ flex: '1 1 140px' }} />
        <input type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" style={{ flex: '1 1 140px' }} />
        <label className="row nowrap small"><input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Admin</label>
        <button className="btn" type="submit" disabled={!username.trim() || password.length < 8}>Add user</button>
      </form>
    </section>
  );
}

function BackupsCard() {
  const { data } = useQuery({ queryKey: ['backups'], queryFn: () => api.get<Backups>(`${V1}/backups`) });
  const qc = useQueryClient();
  const mutate = useMutate();
  const hours = data?.intervalHours ?? 4;
  return (
    <section className="card panel stack">
      <h2>Backups</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Every change is saved to the database immediately.{' '}
        {hours > 0 ? (
          <>A full backup snapshot is taken every {plural(hours, 'hour')} (skipped if nothing changed); </>
        ) : (
          <>Automatic snapshots are turned off (<code>PM_BACKUP_HOURS</code> is 0), so only Back up now makes one; </>
        )}
        the newest {data?.keep ?? 42} are kept in <code>{data?.directory}</code>.
      </p>
      <div>
        <button className="btn" onClick={async () => {
          await mutate(() => api.post(`${V1}/backups`), [], 'Backup created');
          void qc.invalidateQueries({ queryKey: ['backups'] });
        }}>Back up now</button>
      </div>
      {data?.backups.slice(0, 8).map((b) => (
        <div key={b.name} className="row nowrap small">
          <span className="grow key">{b.name}</span>
          <span className="muted">{formatBytes(b.size)} · {timeAgo(b.createdAt)}</span>
        </div>
      ))}
      {data && data.backups.length > 8 && <div className="small muted">…and {data.backups.length - 8} older</div>}
    </section>
  );
}

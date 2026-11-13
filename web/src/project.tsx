import { Fragment, useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, setCurrentProject, V1 } from './api';
import type { Project } from './types';
import { useMutate } from './mutate';
import { errorMessage } from './util';
import { ProjectContext, useProject } from './projectContext';

export { useProject, useProjectId } from './projectContext';

const STORAGE_KEY = 'pm.project';
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;

function readStored(): number | null {
  try {
    const id = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null; // storage blocked: start on the first project
  }
}

function store(id: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    /* storage blocked: the choice lasts until the tab closes */
  }
}

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ projects: Project[] }>(`${V1}/projects`).then((r) => r.projects) });

/**
 * Picks the project this tab works in (remembered per browser) and sends it with every request. Each tab
 * can be in a different project. Users without a project get a form to create their first one.
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const { data: projects, error } = useProjects();
  const [chosen, setChosen] = useState<number | null>(readStored);
  const navigate = useNavigate();
  const project = projects?.find((p) => p.id === chosen) ?? projects?.[0] ?? null;
  // Set while rendering (it's idempotent) so the first requests of the pages below already carry it.
  setCurrentProject(project?.id ?? null);

  const switchTo = useCallback(
    (id: number, opts: { keepTask?: boolean } = {}) => {
      store(id);
      setCurrentProject(id);
      setChosen(id);
      // A single epoch's page and the list filters (epoch, folder, category ids) belong to the old project.
      const { pathname, search } = window.location;
      const task = opts.keepTask ? new URLSearchParams(search).get('task') : null;
      navigate(
        { pathname: pathname.startsWith('/epochs/') ? '/epochs' : pathname, search: task ? `?task=${encodeURIComponent(task)}` : '' },
        { replace: true },
      );
    },
    [navigate],
  );

  const value = useMemo(() => (project && projects ? { project, projects, switchTo } : null), [project, projects, switchTo]);

  if (error) return <div className="empty">Could not load your projects: {errorMessage(error)}</div>;
  if (!projects) return <div className="empty">Loading…</div>;
  if (!value) return <FirstProject onCreated={(p) => store(p.id)} />;
  return (
    <ProjectContext.Provider value={value}>
      {/* Remount everything on a switch so no page keeps state (selection, drafts) from the other project. */}
      <Fragment key={value.project.id}>{children}</Fragment>
    </ProjectContext.Provider>
  );
}

/** "Space Garden" → "SG", "Website" → "WEBS": a starting point the user can change. */
export function suggestKey(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 4);
  return key.replace(/^[0-9]+/, '').slice(0, 10);
}

/** Name, key and colour for a new project; optionally copies types, colours and categories from another. */
export function NewProjectForm({ projects = [], onCreated, submitLabel = 'Create project' }: {
  projects?: Project[];
  onCreated: (p: Project) => void;
  submitLabel?: string;
}) {
  const mutate = useMutate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [color, setColor] = useState('#2563eb');
  const [copyFrom, setCopyFrom] = useState('');
  const shownKey = keyEdited ? key : suggestKey(name);
  const keyOk = PROJECT_KEY_RE.test(shownKey);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const created = await mutate(
      () => api.post<Project>(`${V1}/projects`, { name: name.trim(), key: shownKey, color, ...(copyFrom && { copyFrom: Number(copyFrom) }) }),
      [],
      `Project ${shownKey} created`,
    );
    if (!created) return;
    await qc.invalidateQueries({ queryKey: ['projects'] });
    onCreated(created);
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid-2">
        <label className="field">Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My game" maxLength={100} required />
        </label>
        <label className="field">Key
          <input value={shownKey} maxLength={10} autoCapitalize="characters" aria-invalid={!!shownKey && !keyOk}
            onChange={(e) => { setKey(e.target.value.toUpperCase()); setKeyEdited(true); }} placeholder="e.g. GAME" />
        </label>
      </div>
      <div className="small muted">
        {shownKey && !keyOk
          ? 'A key is 1–10 letters or digits and starts with a letter.'
          : `Tasks will be numbered ${shownKey || 'KEY'}-1, ${shownKey || 'KEY'}-2, … Keys are unique on this server.`}
      </div>
      <div className="row">
        <label className="row nowrap small">Colour <input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
        {projects.length > 0 && (
          <label className="row nowrap small grow">Copy types, colours, categories and templates from
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Nothing (defaults)</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <div><button className="btn btn-primary" type="submit" disabled={!name.trim() || !keyOk}>{submitLabel}</button></div>
    </form>
  );
}

function FirstProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const qc = useQueryClient();
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    window.location.href = '/login';
  };
  return (
    <div className="login-wrap">
      <div className="card login-card" style={{ width: 'min(100%, 520px)' }}>
        <div className="row" style={{ gap: 10 }}>
          <img src="/icon.svg" width={36} height={36} alt="" />
          <h1 className="grow">Create your first project</h1>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          A project has its own board, epochs, files, diagram and settings. Only you can see your projects; you can add more later in
          Settings.
        </p>
        <NewProjectForm onCreated={onCreated} />
        <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={logout}>Log out</button>
      </div>
    </div>
  );
}

/** Project picker for the sidebar and the phone's More page. */
export function ProjectSwitcher() {
  const { project, projects, switchTo } = useProject();
  const navigate = useNavigate();
  return (
    <label className="project-switch" style={{ ['--project' as string]: project.color }}>
      <span className="project-dot" aria-hidden />
      <select value={project.id} aria-label="Project"
        onChange={(e) => (e.target.value === 'manage' ? navigate('/settings#projects') : switchTo(Number(e.target.value)))}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
        <option value="manage">Manage projects…</option>
      </select>
    </label>
  );
}

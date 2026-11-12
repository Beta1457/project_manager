import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api, V1 } from '../api';
import { useLiveUpdates, useRunningTimer } from '../hooks';
import { useMutate } from '../mutate';
import { useTaskParam } from '../taskParam';
import { contrastText, formatMinutes } from '../util';
import { ProjectSwitcher } from '../project';
import { useProject } from '../projectContext';
import { QuickAdd } from './QuickAdd';
import { TaskSheet } from './TaskSheet';

// Lives in its own module so components that Layout renders (TaskSheet, Markdown) can use it without a cycle.
export { useTaskParam };

const NAV = [
  { to: '/', label: 'Board', ico: '▦', end: true },
  { to: '/list', label: 'List', ico: '☰' },
  { to: '/epochs', label: 'Epochs', ico: '◆' },
  { to: '/explorer', label: 'Explorer', ico: '📁' },
  { to: '/diagram', label: 'Diagram', ico: '⎔' },
  { to: '/time', label: 'Time', ico: '⏱' },
  { to: '/settings', label: 'Settings', ico: '⚙' },
];
// Phones get the five most used; Diagram/Time/Settings are reachable from "More".
const MOBILE_NAV = ['/', '/list', '/epochs', '/explorer'];

export function Layout() {
  useLiveUpdates(true);
  const [taskId, setTaskId] = useTaskParam();
  const [adding, setAdding] = useState(false);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.svg" width={24} height={24} alt="" /> Project Manager
        </div>
        <ProjectSwitcher />
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <span>{n.ico}</span> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ New task</button>
      </aside>
      <div className="main">
        <Outlet />
      </div>
      <nav className="bottom-nav">
        {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <span className="ico">{n.ico}</span>
            {n.label}
          </NavLink>
        ))}
        <NavLink to="/more">
          <span className="ico">⋯</span>More
        </NavLink>
      </nav>
      <button className="fab hide-desktop" onClick={() => setAdding(true)} aria-label="New task">+</button>
      {adding && <QuickAdd onClose={() => setAdding(false)} onCreated={(id) => setTaskId(id)} />}
      {taskId !== null && <TaskSheet id={taskId} onClose={() => setTaskId(null)} />}
    </div>
  );
}

export function MorePage() {
  return (
    <>
      <PageHeader title="More" />
      <div className="content">
        <div className="stack">
          <div className="card panel stack" style={{ gap: 8 }}>
            <div className="section-title">Project</div>
            <ProjectSwitcher />
          </div>
          {NAV.filter((n) => !MOBILE_NAV.includes(n.to)).map((n) => (
            <NavLink key={n.to} to={n.to} className="card panel row" style={{ color: 'var(--text)', fontWeight: 600 }}>
              <span style={{ fontSize: '1.3rem', width: 28 }}>{n.ico}</span> {n.label}
            </NavLink>
          ))}
        </div>
      </div>
    </>
  );
}

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="header">
      <ProjectChip />
      <h1>{title}</h1>
      <RunningTimerChip />
      {children}
    </header>
  );
}

/** Phones have no sidebar: with several projects, show which one you're in (tap to switch on More). */
function ProjectChip() {
  const { project, projects } = useProject();
  if (projects.length < 2) return null;
  return (
    <NavLink to="/more" className="project-chip hide-desktop" title={`${project.name} (switch on More)`}
      style={{ background: project.color, color: contrastText(project.color) }}>
      {project.key}
    </NavLink>
  );
}

function RunningTimerChip() {
  const entry = useRunningTimer().data;
  const mutate = useMutate();
  const [, setTaskId] = useTaskParam();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!entry) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, [entry]);
  if (!entry) return null;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(entry.startedAt)) / 60000));
  return (
    <span className="row nowrap" style={{ gap: 4 }}>
      <button className="timer-chip" onClick={() => entry.taskId && setTaskId(entry.taskId)} title={entry.taskTitle ?? entry.epochName ?? ''}>
        <span className="pulse" /> {formatMinutes(minutes)}
        <span className="hide-mobile ellipsis" style={{ maxWidth: 160 }}>{entry.taskKey ?? entry.epochName}</span>
      </button>
      <button className="btn btn-sm" onClick={() => mutate(() => api.post(`${V1}/time/stop`, {}), ['time'], 'Timer stopped')} aria-label="Stop timer">■</button>
    </span>
  );
}

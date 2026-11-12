import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, CLIENT_ID, V1, getCurrentProject, lastWriteStartedAt } from './api';
import { STATUS_COLORS } from './util';
import { useProjectId } from './projectContext';
import type { Diagram, DiagramList, Epoch, Folder, Meta, Task, TaskDetail, TimeEntry, Tree, User } from './types';

export interface TaskFilters {
  q?: string;
  status?: string;
  type?: string;
  category?: string;
  priority?: string;
  epoch?: string;
  folder?: string;
  createdBy?: string;
}

/** A task by id or by key ("APP-12"). Both are unique on the server. */
export type TaskRef = number | string;

const qs = (params: object) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// Lists are cached per project (the project id is in the key) and fetched for that project explicitly.
// Single items by id don't need it: ids are unique on the server.

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User; actor: string }>('/api/auth/me'),
    retry: false,
    staleTime: Infinity,
  });

export function useMeta() {
  const pid = useProjectId();
  return useQuery({ queryKey: ['meta', pid], queryFn: () => api.get<Meta>(`${V1}/meta`, pid), staleTime: 60_000 });
}

/** User-configurable colours for Kanban columns and task types (Settings → Colours). */
export function useColors() {
  const meta = useMeta().data;
  return useMemo(
    () => ({
      status: (id: string) => meta?.statuses.find((s) => s.id === id)?.color ?? STATUS_COLORS[id] ?? '#64748b',
      type: (name: string) => meta?.typeColors?.[name] ?? '#64748b',
    }),
    [meta],
  );
}

export const tasksKey = (pid: number, filters: TaskFilters) => ['tasks', pid, filters];

export function useTasks(filters: TaskFilters) {
  const pid = useProjectId();
  return useQuery({
    queryKey: tasksKey(pid, filters),
    // summary=1: no descriptions (cards don't show them), so live refreshes stay small on a phone.
    queryFn: () => api.get<{ tasks: Task[] }>(`${V1}/tasks${qs({ ...filters, summary: 1 })}`, pid).then((r) => r.tasks),
    placeholderData: (prev) => prev,
  });
}

export const useTask = (ref: TaskRef | null) =>
  useQuery({
    queryKey: ['task', ref],
    queryFn: () => api.get<TaskDetail>(`${V1}/tasks/${encodeURIComponent(String(ref))}`),
    enabled: ref !== null,
  });

export function useEpochs() {
  const pid = useProjectId();
  return useQuery({ queryKey: ['epochs', pid], queryFn: () => api.get<{ epochs: Epoch[] }>(`${V1}/epochs`, pid).then((r) => r.epochs) });
}

export const useEpoch = (id: number | null) =>
  useQuery({ queryKey: ['epoch', id], queryFn: () => api.get<Epoch>(`${V1}/epochs/${id}`), enabled: id !== null });

export function useFolders() {
  const pid = useProjectId();
  return useQuery({ queryKey: ['folders', pid], queryFn: () => api.get<{ folders: Folder[] }>(`${V1}/folders`, pid).then((r) => r.folders) });
}

export function useTree() {
  const pid = useProjectId();
  return useQuery({ queryKey: ['tree', pid], queryFn: () => api.get<Tree>(`${V1}/tree`, pid) });
}

export function useTime(params: { taskId?: number; epochId?: number; actor?: string; from?: string; to?: string }, enabled = true) {
  const pid = useProjectId();
  return useQuery({
    queryKey: ['time', pid, params],
    queryFn: () => api.get<{ entries: TimeEntry[]; totalMinutes: number }>(`${V1}/time${qs(params)}`, pid),
    enabled,
  });
}

/** Your running timer, whichever project it is in. */
export const useRunningTimer = () =>
  useQuery({
    queryKey: ['running'],
    queryFn: () => api.get<{ entry: TimeEntry | null }>(`${V1}/time/running`).then((r) => r.entry),
  });

export function useDiagrams() {
  const pid = useProjectId();
  return useQuery({
    queryKey: ['diagrams', pid],
    queryFn: () => api.get<DiagramList>(`${V1}/diagrams`, pid),
  });
}

export const useDiagram = (id: number | null) =>
  useQuery({ queryKey: ['diagram', id], queryFn: () => api.get<Diagram>(`${V1}/diagrams/${id}`), enabled: id !== null });

const INVALIDATE: Record<string, string[]> = {
  tasks: ['tasks', 'task', 'epochs', 'epoch', 'tree', 'time', 'projects'],
  epochs: ['epochs', 'epoch', 'tree', 'tasks', 'task'],
  folders: ['folders', 'tree', 'tasks'],
  files: ['tree', 'files'],
  categories: ['meta', 'tasks', 'task'],
  types: ['meta'],
  diagrams: ['diagrams', 'diagram'],
  time: ['time', 'running', 'tasks', 'task', 'epochs', 'epoch'],
  // A new key renames every task key; a new name or colour shows in the switcher.
  projects: ['projects', 'meta', 'tasks', 'task', 'tree', 'time', 'running', 'users'],
  // Changes in one of your other projects only touch what is shown across projects.
  'elsewhere:tasks': ['projects'],
  'elsewhere:time': ['running'],
};

/** Refetches the queries that show these kinds of data. Resolves when the refetches have finished. */
export function invalidateKinds(qc: QueryClient, kinds: Iterable<string>, onlyStaleSince?: number): Promise<void> {
  const keys = new Set<string>();
  for (const k of kinds) for (const key of INVALIDATE[k] ?? []) keys.add(key);
  const refetches: Promise<unknown>[] = [];
  for (const key of keys) {
    refetches.push(qc.invalidateQueries({
      queryKey: [key],
      // Skip queries already refetched (or refetching) after the given time: they include the change.
      ...(onlyStaleSince !== undefined && {
        predicate: (q) => q.state.fetchStatus !== 'fetching' && q.state.dataUpdatedAt < onlyStaleSince,
      }),
    }));
  }
  return Promise.all(refetches).then(() => undefined);
}

/** Subscribes to server change events so every open device stays in sync. */
export function useLiveUpdates(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    // Changes made elsewhere always refresh. Echoes of this tab's own writes only refresh what this tab
    // hasn't already refetched since writing (useMutate refetches right after each write).
    let others = new Set<string>();
    let own = new Set<string>();
    let timer: number | undefined;
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as { kind: string; origin?: string; projectId?: number };
        // The server only sends events from your own projects; this tab shows one of them.
        const kind = e.projectId !== undefined && e.projectId !== getCurrentProject() ? `elsewhere:${e.kind}` : e.kind;
        (e.origin === CLIENT_ID ? own : others).add(kind);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          invalidateKinds(qc, others);
          invalidateKinds(qc, [...own].filter((k) => !others.has(k)), lastWriteStartedAt);
          others = new Set();
          own = new Set();
        }, 150);
      } catch {
        /* ignore malformed events */
      }
    };
    // After a *re*connect (e.g. the phone woke up) refresh everything once; skip the initial connect.
    let opened = false;
    es.onopen = () => {
      if (opened) void qc.invalidateQueries();
      opened = true;
    };
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, [enabled, qc]);
}

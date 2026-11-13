import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, V1 } from '../api';
import { useProject } from '../projectContext';
import type { Task } from '../types';
import { StatusPill } from './Bits';

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Props {
  /** Accessible name of the search box ("Find a task to link"). */
  label: string;
  /** Shown before the search box, e.g. a link type picker. */
  before?: ReactNode;
  /** Extra list filters, e.g. { parent: 'none' } to offer top-level tasks only. */
  params?: Record<string, string>;
  /** Tasks not to offer: the task itself, ones already linked... */
  exclude?: (task: Task) => boolean;
  /** Ends "No matching tasks …" when every match was excluded ("that aren't already linked"). */
  excludedHint?: string;
  onPick: (task: Task) => void;
  onCancel: () => void;
}

/**
 * Finds a task in the current project by title, description or key; a bare number means a key ("12" is
 * APP-12). Enter picks the first match.
 */
export function TaskSearch({ label, before, params, exclude, excludedHint, onPick, onCancel }: Props) {
  const { project } = useProject();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const query = /^\d+$/.test(term) ? `${project.key}-${term}` : term;
  const search = useQuery({
    queryKey: ['task-search', project.id, query, params ?? null],
    queryFn: () =>
      api
        .get<{ tasks: Task[] }>(`${V1}/tasks?${new URLSearchParams({ q: query, summary: '1', limit: '8', ...params })}`, project.id)
        .then((r) => r.tasks),
    enabled: query.length > 0,
  });
  const results = (search.data ?? []).filter((t) => !exclude?.(t));

  return (
    <div className="link-add stack" style={{ gap: 6 }}>
      <div className="row nowrap">
        {before}
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) {
              e.preventDefault();
              onPick(results[0]);
            }
          }}
          placeholder={`Search by title or key (${project.key}-12)`}
          aria-label={label}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
      {query && (
        <div className="link-results">
          {search.isFetching && !search.data ? (
            <div className="tiny muted">Searching…</div>
          ) : results.length ? (
            results.map((t) => (
              <button key={t.id} type="button" className="link-result" onClick={() => onPick(t)}>
                <span className="key">{t.key}</span> <span className="grow ellipsis">{t.title}</span>
                <StatusPill status={t.status} label={t.statusLabel} />
              </button>
            ))
          ) : (
            <div className="tiny muted">No matching tasks{search.data?.length && excludedHint ? ` ${excludedHint}` : ''}.</div>
          )}
        </div>
      )}
    </div>
  );
}

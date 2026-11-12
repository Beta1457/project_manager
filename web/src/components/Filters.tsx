import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TaskFilters } from '../hooks';
import { useEpochs, useFolders, useMeta } from '../hooks';
import { Sheet } from './Sheet';

const KEYS: Array<keyof TaskFilters> = ['q', 'status', 'type', 'category', 'priority', 'epoch', 'folder', 'createdBy'];

/** Filters live in the URL so filtered views can be bookmarked and shared. */
export function useFilters(): [TaskFilters, (patch: Partial<TaskFilters>) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => {
    const f: TaskFilters = {};
    for (const k of KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [params]);
  const update = (patch: Partial<TaskFilters>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  const clear = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const k of KEYS) next.delete(k);
        return next;
      },
      { replace: true },
    );
  return [filters, update, clear];
}

/**
 * A text box bound to a URL filter. Typing stays local (smooth on slow phones); the URL is written
 * after a pause. Outside changes (Clear all, back button) are adopted, but the echo of our own
 * write is not, so characters typed while that write commits are never overwritten.
 */
function useDebouncedParam(urlValue: string, write: (v: string) => void, delay = 300): [string, (v: string) => void] {
  const [value, setValue] = useState(urlValue);
  const lastWritten = useRef(urlValue);
  useEffect(() => {
    if (urlValue === lastWritten.current) return;
    lastWritten.current = urlValue;
    setValue(urlValue);
  }, [urlValue]);
  useEffect(() => {
    if (value === lastWritten.current) return;
    const t = window.setTimeout(() => {
      lastWritten.current = value;
      write(value);
    }, delay);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return [value, setValue];
}

const split = (v?: string) => (v ? v.split(',').filter(Boolean) : []);
const toggle = (v: string | undefined, item: string) => {
  const list = split(v);
  return (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]).join(',');
};

export function FilterBar({ hide = [] }: { hide?: Array<keyof TaskFilters> }) {
  const [filters, update, clear] = useFilters();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useDebouncedParam(filters.q ?? '', (v) => update({ q: v }));
  const [createdBy, setCreatedBy] = useDebouncedParam(filters.createdBy ?? '', (v) => update({ createdBy: v.trim() }));
  const meta = useMeta().data;
  const epochs = useEpochs().data ?? [];
  const folders = useFolders().data ?? [];

  const active: Array<{ key: keyof TaskFilters; label: string }> = [];
  for (const s of split(filters.status)) active.push({ key: 'status', label: meta?.statuses.find((x) => x.id === s)?.label ?? s });
  for (const t of split(filters.type)) active.push({ key: 'type', label: t });
  for (const c of split(filters.category)) active.push({ key: 'category', label: `#${c}` });
  for (const p of split(filters.priority)) active.push({ key: 'priority', label: `${p} priority` });
  if (filters.epoch && !hide.includes('epoch'))
    active.push({ key: 'epoch', label: filters.epoch === 'none' ? 'No epoch' : `Epoch: ${epochs.find((e) => String(e.id) === filters.epoch)?.name ?? filters.epoch}` });
  if (filters.folder)
    active.push({ key: 'folder', label: filters.folder === 'inbox' ? 'Inbox' : `Folder: ${folders.find((f) => String(f.id) === filters.folder)?.name ?? filters.folder}` });
  if (filters.createdBy) active.push({ key: 'createdBy', label: `By ${filters.createdBy}` });

  const remove = (key: keyof TaskFilters, label: string) => {
    if (key === 'status' || key === 'type' || key === 'category' || key === 'priority') {
      const raw =
        key === 'status' ? meta?.statuses.find((x) => x.label === label)?.id ?? label
        : key === 'category' ? label.slice(1)
        : key === 'priority' ? label.replace(' priority', '')
        : label;
      update({ [key]: toggle(filters[key], raw) });
    } else update({ [key]: '' });
  };

  return (
    <>
      <div className="filterbar">
        <input type="search" placeholder={`Search tasks or ${meta?.project.key ?? 'KEY'}-12…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
        <button className="btn" onClick={() => setOpen(true)}>
          Filters {active.length > 0 && <span className="filter-count">{active.length}</span>}
        </button>
      </div>
      {active.length > 0 && (
        <div className="active-filters">
          {active.map((a, i) => (
            <button key={i} type="button" className="pill" onClick={() => remove(a.key, a.label)} title="Remove filter">
              {a.label} ✕
            </button>
          ))}
          <button type="button" className="pill" onClick={clear} style={{ background: 'transparent', color: 'var(--muted)' }}>
            Clear all
          </button>
        </div>
      )}
      {open && meta && (
        <Sheet title="Filters" onClose={() => setOpen(false)} variant="center" actions={<button className="btn btn-sm" onClick={clear}>Clear</button>}>
          <div className="stack">
            {!hide.includes('status') && (
              <div>
                <div className="section-title">Status</div>
                <div className="check-list">
                  {meta.statuses.map((s) => (
                    <button key={s.id} className={`toggle-chip ${split(filters.status).includes(s.id) ? 'on' : ''}`} onClick={() => update({ status: toggle(filters.status, s.id) })}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="section-title">Category</div>
              <div className="check-list">
                {meta.categories.map((c) => (
                  <button key={c.id} className={`toggle-chip ${split(filters.category).includes(c.name) ? 'on' : ''}`} onClick={() => update({ category: toggle(filters.category, c.name) })}>
                    <span className="dot" style={{ background: c.color }} /> {c.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="section-title">Type</div>
              <div className="check-list">
                {meta.types.map((t) => (
                  <button key={t} className={`toggle-chip ${split(filters.type).includes(t) ? 'on' : ''}`} onClick={() => update({ type: toggle(filters.type, t) })}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="section-title">Priority</div>
              <div className="check-list">
                {meta.priorities.map((p) => (
                  <button key={p} className={`toggle-chip ${split(filters.priority).includes(p) ? 'on' : ''}`} onClick={() => update({ priority: toggle(filters.priority, p) })} style={{ textTransform: 'capitalize' }}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid-2">
              {!hide.includes('epoch') && (
                <label className="field">
                  Epoch
                  <select value={filters.epoch ?? ''} onChange={(e) => update({ epoch: e.target.value })}>
                    <option value="">Any</option>
                    <option value="none">No epoch</option>
                    {epochs.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                Folder (incl. sub-folders)
                <select value={filters.folder ?? ''} onChange={(e) => update({ folder: e.target.value })}>
                  <option value="">Any</option>
                  <option value="inbox">Inbox (unfiled)</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{folderPath(folders, f.id)}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Created by
                <input value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} placeholder="e.g. claude" />
              </label>
            </div>
            <button className="btn btn-primary" onClick={() => setOpen(false)}>Done</button>
          </div>
        </Sheet>
      )}
    </>
  );
}

export function folderPath(folders: Array<{ id: number; parentId: number | null; name: string }>, id: number): string {
  const parts: string[] = [];
  let cur = folders.find((f) => f.id === id);
  let guard = 0;
  while (cur && guard++ < 50) {
    parts.unshift(cur.name);
    const parentId = cur.parentId;
    cur = parentId === null ? undefined : folders.find((f) => f.id === parentId);
  }
  return parts.join(' / ');
}

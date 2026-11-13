import { useMemo, useState, type MouseEvent } from 'react';
import { useTasks } from '../hooks';
import { useTaskSelection } from '../selection';
import type { Task } from '../types';
import { BulkBar } from '../components/BulkBar';
import { FilterBar, useFilters } from '../components/Filters';
import { PageHeader, useTaskParam } from '../components/Layout';
import { CategoryChip, PriorityBadge, Spinner, StatusPill, TypeBadge } from '../components/Bits';
import { TaskCard } from '../components/TaskCard';
import { cx, formatMinutes, timeAgo } from '../util';

type SortKey = 'id' | 'title' | 'status' | 'priority' | 'type' | 'epochName' | 'loggedMinutes' | 'updatedAt';
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK = ['open', 'in_progress', 'alpha_qa', 'alpha_complete', 'beta_in_progress', 'beta_qa', 'beta_complete', 'ready_to_ship'];

function compare(a: Task, b: Task, key: SortKey): number {
  switch (key) {
    case 'priority':
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case 'status':
      return STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status);
    case 'id':
    case 'loggedMinutes':
      return a[key] - b[key];
    default:
      return String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
  }
}

// The checkboxes are ticked in onClick, which also knows about Shift; React wants an onChange on a controlled box.
const noop = () => {};

export function ListPage() {
  const [filters] = useFilters();
  const { data: tasks, isLoading } = useTasks(filters);
  const [, openTask] = useTaskParam();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updatedAt', dir: -1 });

  const sorted = useMemo(() => [...(tasks ?? [])].sort((a, b) => compare(a, b, sort.key) * sort.dir), [tasks, sort]);
  const ordered = useMemo(() => sorted.map((t) => t.id), [sorted]);
  const selection = useTaskSelection(ordered);
  const selectedTasks = useMemo(() => sorted.filter((t) => selection.has(t.id)), [sorted, selection]);
  const allSelected = sorted.length > 0 && selectedTasks.length === sorted.length;

  /** A row click opens the task; with Ctrl/Cmd it ticks the row, with Shift everything from the last ticked row. */
  const rowClick = (e: MouseEvent, t: Task) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) selection.toggle(t.id, e.shiftKey);
    else openTask(t.id);
  };

  const th = (key: SortKey, label: string, cls = '') => (
    <th className={cls} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
      {label} {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : ''}
    </th>
  );

  return (
    <>
      <PageHeader title={`List${tasks ? ` (${tasks.length})` : ''}`} />
      <div className="content flush">
        <FilterBar />
        <div className={cx(selection.active && 'selecting')} style={{ flex: 1, overflow: 'auto' }}>
          {isLoading ? (
            <Spinner />
          ) : !sorted.length ? (
            <div className="empty">No tasks match these filters.</div>
          ) : (
            <>
              {/* Bottom padding keeps the last card clear of the floating + button. */}
              <div className="list-cards hide-desktop" style={{ padding: '10px 10px 96px' }}>
                <div className="row small muted">
                  Sort:
                  <select value={`${sort.key}:${sort.dir}`} style={{ width: 'auto', minHeight: 34 }}
                    onChange={(e) => { const [k, d] = e.target.value.split(':'); setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }}>
                    <option value="updatedAt:-1">Recently updated</option>
                    <option value="priority:1">Priority</option>
                    <option value="status:1">Status</option>
                    <option value="id:-1">Newest</option>
                    <option value="title:1">Title</option>
                  </select>
                  <span className="grow" />
                  <button type="button" className={cx('btn btn-sm select-toggle', selection.mode && 'on')} aria-pressed={selection.mode}
                    onClick={() => (selection.mode ? selection.clear() : selection.setMode(true))}>
                    Select
                  </button>
                </div>
                {sorted.map((t) => (
                  <div key={t.id}>
                    <TaskCard task={t} onOpen={openTask}
                      select={{ selected: selection.has(t.id), tapSelects: selection.mode, onToggle: (range) => selection.toggle(t.id, range) }} />
                    <div style={{ marginTop: -4 }} />
                  </div>
                ))}
              </div>
              <table className="list-table hide-mobile">
                <thead>
                  <tr>
                    <th className="select-col">
                      <input
                        type="checkbox"
                        aria-label={allSelected ? 'Clear the selection' : `Select all ${sorted.length} tasks`}
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = selectedTasks.length > 0 && !allSelected;
                        }}
                        onChange={() => (allSelected ? selection.clear() : selection.selectAll())}
                      />
                    </th>
                    {th('id', 'Key')}
                    {th('title', 'Title')}
                    {th('status', 'Status')}
                    {th('priority', 'Priority')}
                    {th('type', 'Type')}
                    <th>Categories</th>
                    {th('epochName', 'Epoch')}
                    {th('loggedMinutes', 'Time')}
                    {th('updatedAt', 'Updated')}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t) => (
                    <tr
                      key={t.id}
                      className={cx(selection.has(t.id) && 'selected')}
                      onClick={(e) => rowClick(e, t)}
                      // Shift+click picks a range of rows, not a stretch of text.
                      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter') openTask(t.id);
                        else if (e.key === ' ') {
                          e.preventDefault();
                          selection.toggle(t.id, e.shiftKey);
                        }
                      }}
                    >
                      {/* The whole cell ticks the box: an easier target than the box alone. */}
                      <td className="select-col" onClick={(e) => { e.stopPropagation(); selection.toggle(t.id, e.shiftKey); }}>
                        <input type="checkbox" checked={selection.has(t.id)} aria-label={`Select ${t.key}`} onChange={noop}
                          onClick={(e) => { e.stopPropagation(); selection.toggle(t.id, e.shiftKey); }} />
                      </td>
                      <td className="key">{t.key}</td>
                      <td>
                        {t.parent && <span className="tiny muted" title={`Sub-task of ${t.parent.key} "${t.parent.title}"`}>↳ {t.parent.key} </span>}
                        <span style={{ fontWeight: 600 }}>{t.title}</span>
                        {t.subtasks.total > 0 && <span className="tiny muted"> · sub-tasks {t.subtasks.done}/{t.subtasks.total}</span>}
                      </td>
                      <td><StatusPill status={t.status} label={t.statusLabel} /></td>
                      <td><PriorityBadge priority={t.priority} /></td>
                      <td><TypeBadge type={t.type} /></td>
                      <td><div className="row" style={{ gap: 4 }}>{t.categories.map((c) => <CategoryChip key={c.id} category={c} />)}</div></td>
                      <td>{t.epochName ?? <span className="muted">—</span>}</td>
                      <td className="small">{t.loggedMinutes ? formatMinutes(t.loggedMinutes) : ''}{t.estimateMinutes ? ` / ${formatMinutes(t.estimateMinutes)}` : ''}</td>
                      <td className="small muted">{timeAgo(t.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <BulkBar selection={selection} tasks={selectedTasks} total={sorted.length} />
      </div>
    </>
  );
}

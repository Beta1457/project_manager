import { useMemo, useState } from 'react';
import { useTasks } from '../hooks';
import type { Task } from '../types';
import { FilterBar, useFilters } from '../components/Filters';
import { PageHeader, useTaskParam } from '../components/Layout';
import { CategoryChip, PriorityBadge, Spinner, StatusPill, TypeBadge } from '../components/Bits';
import { TaskCard } from '../components/TaskCard';
import { formatMinutes, timeAgo } from '../util';

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

export function ListPage() {
  const [filters] = useFilters();
  const { data: tasks, isLoading } = useTasks(filters);
  const [, openTask] = useTaskParam();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updatedAt', dir: -1 });

  const sorted = useMemo(() => [...(tasks ?? [])].sort((a, b) => compare(a, b, sort.key) * sort.dir), [tasks, sort]);
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
        <div style={{ flex: 1, overflow: 'auto' }}>
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
                </div>
                {sorted.map((t) => (
                  <div key={t.id}>
                    <TaskCard task={t} onOpen={openTask} />
                    <div style={{ marginTop: -4 }} />
                  </div>
                ))}
              </div>
              <table className="list-table hide-mobile">
                <thead>
                  <tr>
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
                    <tr key={t.id} onClick={() => openTask(t.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openTask(t.id)}>
                      <td className="key">{t.key}</td>
                      <td style={{ fontWeight: 600 }}>{t.title}</td>
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
      </div>
    </>
  );
}

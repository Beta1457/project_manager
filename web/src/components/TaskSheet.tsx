import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, V1 } from '../api';
import { useEpochs, useFolders, useMeta, useTask, type TaskRef } from '../hooks';
import { useProject } from '../projectContext';
import { useToast } from './Toast';
import { useMutate } from '../mutate';
import { useTaskParam } from '../taskParam';
import type { TaskDetail } from '../types';
import { clip, formatMinutes, joinAnd, plural, timeAgo } from '../util';
import { useUndoableDelete } from '../undoableDelete';
import { Markdown, Spinner, StatusPill } from './Bits';
import { askConfirm } from './Confirm';
import { folderPath } from './Filters';
import { Sheet } from './Sheet';
import { TimePanel } from './TimePanel';
import { MarkdownEditor } from './MarkdownEditor';
import { TaskSearch } from './TaskSearch';
import { SaveAsTemplate } from './Templates';

const K = ['tasks'];

export function TaskSheet({ id, onClose }: { id: TaskRef; onClose: () => void }) {
  const { data: task, error } = useTask(id);
  const { project, projects, switchTo } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  // A link or the timer can point at a task in another of your projects: open that project along with it,
  // so the sheet offers that project's types, categories, epochs and folders.
  const elsewhere = task && task.projectId !== project.id ? task.projectId : null;
  useEffect(() => {
    if (elsewhere === null) return;
    const other = projects.find((p) => p.id === elsewhere);
    if (!other) {
      void qc.invalidateQueries({ queryKey: ['projects'] }); // created moments ago on another device
      return;
    }
    switchTo(elsewhere, { keepTask: true });
    toast(`Switched to ${other.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elsewhere, projects]);
  const [saving, setSaving] = useState(false);
  return (
    <>
    <Sheet
      title={task ? <span><span className="key">{task.key}</span> {task.title}</span> : 'Task'}
      onClose={onClose}
      actions={
        task && (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setSaving(true)} title="Start new tasks from a copy of this one">
              Save as template
            </button>
            <DeleteButton task={task} onDone={onClose} />
          </>
        )
      }
    >
      {/* Keyed by id: following a link to another task must not carry this task's unsaved edits across. */}
      {error ? (
        <div className="empty">{(error as Error).message}</div>
      ) : task && elsewhere === null ? (
        <TaskBody key={task.id} task={task} />
      ) : (
        <Spinner />
      )}
    </Sheet>
    {saving && task && <SaveAsTemplate task={task} onClose={() => setSaving(false)} />}
    </>
  );
}

function DeleteButton({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  return (
    <button
      className="btn btn-ghost btn-danger btn-sm"
      onClick={async () => {
        const goes = ['checklist', 'comments', 'links'];
        if (task.loggedMinutes > 0) goes.push(`${formatMinutes(task.loggedMinutes)} of logged time`);
        const body = `"${task.title}" will be deleted, along with its ${joinAnd(goes)}. This can't be undone.`;
        const n = task.subtasks.total;
        let url = `${V1}/tasks/${task.id}`;
        if (n > 0) {
          const answer = await askConfirm({
            title: `Delete ${task.key}?`,
            body: (
              <>
                <p>{body}</p>
                <p>Its {plural(n, 'sub-task')} will stay, as top-level tasks, unless you tick the box.</p>
              </>
            ),
            confirmLabel: 'Delete task',
            checkbox: `Also delete its ${plural(n, 'sub-task')}`,
          });
          if (!answer.ok) return;
          if (answer.checked) url += '?withSubtasks=true';
        } else if (!(await askConfirm({ title: `Delete ${task.key}?`, body, confirmLabel: 'Delete task' }))) return;
        const done = await mutate(() => api.del<{ deleted: number }>(url), K);
        if (done) {
          toast(done.deleted > 1 ? `Deleted ${plural(done.deleted, 'task')}` : 'Task deleted');
          onDone();
        }
      }}
    >
      Delete
    </button>
  );
}

function TaskBody({ task }: { task: TaskDetail }) {
  const mutate = useMutate();
  // Removed checklist items hide at once and are deleted when the Undo window closes.
  const undoable = useUndoableDelete();
  const checklistUrl = (itemId: number) => `${V1}/checklist/${itemId}`;
  const checklistItems = task.checklistItems.filter((i) => !undoable.isHidden(checklistUrl(i.id)));
  const checklistDone = checklistItems.filter((i) => i.done).length;
  const meta = useMeta().data;
  const epochs = useEpochs().data ?? [];
  const folders = useFolders().data ?? [];
  const [title, setTitle] = useState(task.title);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState(task.description);
  const [newItem, setNewItem] = useState('');
  const [comment, setComment] = useState('');
  const [tab, setTab] = useState<'activity' | 'time'>('activity');

  useEffect(() => setTitle(task.title), [task.title]);

  const patch = (body: Record<string, unknown>) => mutate(() => api.patch(`${V1}/tasks/${task.id}`, body), K);
  // Writes from this sheet go out one at a time, in order, so a slow request can't land after a newer one.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const patchInOrder = <T,>(body: () => Record<string, unknown>, after?: (ok: boolean) => T) =>
    (queue.current = queue.current.then(async () => after?.(Boolean(await patch(body()))))) as Promise<T>;

  const saveTitle = () => {
    const t = title.trim();
    if (t && t !== task.title) void patch({ title: t });
    else setTitle(task.title);
  };

  // ---- Description: autosaves ~1s after typing stops, and on Done / closing the sheet. ----
  // `saved` is the text the server is known to have; the editor is dirty while desc differs from it.
  const saved = useRef(task.description);
  const descRef = useRef(desc);
  descRef.current = desc;
  const flushDesc = (): Promise<boolean> => {
    let sent = '';
    return patchInOrder(
      () => ({ description: (sent = descRef.current) }),
      (ok) => {
        if (ok) saved.current = sent; // on failure stay dirty: the text is kept and retried
        return ok;
      },
    );
  };
  useEffect(() => {
    if (!editingDesc || desc === saved.current) return;
    const t = window.setTimeout(() => void flushDesc(), 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desc, editingDesc]);
  // Changes from elsewhere (another device, Claude) replace the text only if there are no unsaved local edits.
  useEffect(() => {
    if (descRef.current === saved.current) setDesc(task.description);
    saved.current = task.description;
  }, [task.description]);
  // Closing the sheet mid-sentence (✕, Escape, back button) still saves.
  useEffect(
    () => () => {
      if (descRef.current !== saved.current) void flushDesc();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const finishDesc = async () => {
    if (await flushDesc()) setEditingDesc(false);
  };

  // ---- Categories: toggles build on the last *intended* set, so quick taps don't undo each other. ----
  const serverCats = task.categories.map((c) => c.name);
  const [catDraft, setCatDraft] = useState<string[] | null>(null);
  const cats = catDraft ?? serverCats;
  const serverCatsKey = [...serverCats].sort().join('\n');
  useEffect(() => {
    if (catDraft && [...catDraft].sort().join('\n') === serverCatsKey) setCatDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverCatsKey]);
  const toggleCategory = (name: string) => {
    const next = cats.includes(name) ? cats.filter((n) => n !== name) : [...cats, name];
    setCatDraft(next);
    void patchInOrder(
      () => ({ categories: next }),
      (ok) => !ok && setCatDraft(null), // failed: fall back to what the server has
    );
  };
  const location = task.epochId ? `e:${task.epochId}` : task.folderId ? `f:${task.folderId}` : '';
  const setLocation = (v: string) => {
    if (v.startsWith('e:')) void patch({ epochId: Number(v.slice(2)) });
    else if (v.startsWith('f:')) void patch({ folderId: Number(v.slice(2)) });
    else void patch({ folderId: null });
  };

  if (!meta) return <Spinner />;

  return (
    <div className="stack">
      <input
        className="title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Title"
      />
      <div className="row small muted">
        <StatusPill status={task.status} label={task.statusLabel} />
        <span>
          by {task.createdBy} · {timeAgo(task.createdAt)} · updated {timeAgo(task.updatedAt)}
        </span>
      </div>
      <ParentRow task={task} onPatch={patch} />

      <div className="prop-grid">
        <label className="field">
          Status
          <select value={task.status} onChange={(e) => patch({ status: e.target.value })}>
            {meta.statuses.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Type
          <select value={task.type} onChange={(e) => patch({ type: e.target.value })}>
            {meta.types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Priority
          <select value={task.priority} onChange={(e) => patch({ priority: e.target.value })}>
            {meta.priorities.map((p) => (
              <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Estimate
          <EstimateInput value={task.estimateMinutes} onSave={(v) => patch({ estimate: v })} />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          Epoch / folder
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">Inbox (unfiled)</option>
            <optgroup label="Epochs">
              {epochs.map((e) => (
                <option key={e.id} value={`e:${e.id}`}>◆ {e.name}</option>
              ))}
            </optgroup>
            <optgroup label="Folders">
              {folders.map((f) => (
                <option key={f.id} value={`f:${f.id}`}>📁 {folderPath(folders, f.id)}</option>
              ))}
            </optgroup>
          </select>
        </label>
      </div>

      <div>
        <div className="section-title">Categories</div>
        <div className="check-list">
          {meta.categories.map((c) => {
            const on = cats.includes(c.name);
            return (
              <button key={c.id} className={`toggle-chip ${on ? 'on' : ''}`} onClick={() => toggleCategory(c.name)} style={on ? { background: c.color, borderColor: c.color } : undefined}>
                {!on && <span className="dot" style={{ background: c.color }} />} {c.name}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="section-title">Description</div>
          {editingDesc ? (
            <button className="btn btn-sm btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={finishDesc}>Done</button>
          ) : (
            <button className="btn btn-sm" onClick={() => setEditingDesc(true)}>Edit</button>
          )}
        </div>
        {editingDesc ? (
          <MarkdownEditor autoFocus value={desc} onChange={setDesc} rows={10} />
        ) : (
          <div
            className="desc-view"
            onClick={(e) => {
              // Links and images inside the description should open, not switch to editing.
              if (!(e.target as HTMLElement).closest('a, img')) setEditingDesc(true);
            }}
          >
            {desc ? <Markdown text={desc} /> : <span className="muted">Add a description…</span>}
          </div>
        )}
      </div>

      <div>
        <div className="section-title">
          Checklist {checklistItems.length > 0 && `(${checklistDone}/${checklistItems.length})`}
        </div>
        {checklistItems.map((item) => (
          <div key={item.id} className={`checklist-item ${item.done ? 'done' : ''}`}>
            <input type="checkbox" checked={item.done} onChange={(e) => mutate(() => api.patch(`${V1}/checklist/${item.id}`, { done: e.target.checked }), K)} />
            <span className="grow">{item.text}</span>
            <button
              className="btn btn-ghost btn-sm"
              aria-label={`Remove "${item.text}"`}
              onClick={() => undoable.remove(checklistUrl(item.id), `Removed "${clip(item.text)}"`, K)}
            >
              ✕
            </button>
          </div>
        ))}
        <form
          className="row nowrap"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newItem.trim()) return;
            if (await mutate(() => api.post(`${V1}/tasks/${task.id}/checklist`, { text: newItem }), K)) setNewItem('');
          }}
        >
          <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add checklist item" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      {!task.parent && <SubtasksSection task={task} />}

      <LinksSection task={task} />

      <div className="tabs">
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
        <button className={tab === 'time' ? 'on' : ''} onClick={() => setTab('time')}>Time tracking</button>
      </div>

      {tab === 'time' ? (
        <TimePanel taskId={task.id} loggedMinutes={task.loggedMinutes} estimateMinutes={task.estimateMinutes} />
      ) : (
        <div className="stack">
          <form
            className="stack"
            style={{ gap: 6 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              if (await mutate(() => api.post(`${V1}/tasks/${task.id}/comments`, { message: comment }), K)) setComment('');
            }}
          >
            <MarkdownEditor value={comment} onChange={setComment} placeholder="Add a note… (images welcome)" rows={2} minHeight={60} />
            <div><button className="btn btn-sm" type="submit" disabled={!comment.trim()}>Post note</button></div>
          </form>
          <div className="activity">
            {task.activity.map((a) => (
              <div key={a.id} className={`activity-item ${a.kind}`}>
                <div className="tiny muted">
                  <strong>{a.actor}</strong> · {a.kind} · {timeAgo(a.createdAt)}
                </div>
                {/* Notes are markdown; link and sub-task entries go through it too so their task keys are clickable. */}
                <div className="msg">{a.kind === 'comment' || a.kind === 'link' || a.kind === 'subtask' ? <Markdown text={a.message} /> : a.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const LINK_KINDS = [
  { value: 'relates', label: 'relates to' },
  { value: 'blocks', label: 'blocks' },
  { value: 'blocked_by', label: 'is blocked by' },
  { value: 'duplicates', label: 'duplicates' },
  { value: 'duplicated_by', label: 'is duplicated by' },
];

/** Opens a task in this sheet; Ctrl/Cmd/Shift-click opens it in a new browser tab instead. */
function useOpenTask() {
  const [, openTask] = useTaskParam();
  return (e: MouseEvent, id: number) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // let the browser open a new tab
    e.preventDefault();
    openTask(id);
  };
}

/** Which task this one is a sub-task of: open it, change it, detach. Top-level tasks with sub-tasks can't have one. */
function ParentRow({ task, onPatch }: { task: TaskDetail; onPatch: (body: Record<string, unknown>) => Promise<unknown> }) {
  const open = useOpenTask();
  const [picking, setPicking] = useState(false);
  if (!task.parent && task.subtasks.total > 0) return null;
  return (
    <div>
      <div className="parent-row small">
        <span className="muted">Parent</span>
        {task.parent ? (
          <a className="grow ellipsis" href={`?task=${task.parent.id}`} onClick={(e) => open(e, task.parent!.id)}>
            <span className="key">{task.parent.key}</span> {task.parent.title}
          </a>
        ) : (
          <span className="grow muted">None (a top-level task)</span>
        )}
        {!picking && (
          <button className="btn btn-sm" onClick={() => setPicking(true)}>
            {task.parent ? 'Change' : 'Make sub-task of…'}
          </button>
        )}
        {task.parent && !picking && (
          <button className="btn btn-ghost btn-sm" onClick={() => void onPatch({ parent: null })} title="Make it a top-level task">
            Detach
          </button>
        )}
      </div>
      {picking && (
        <TaskSearch
          label="Find the parent task"
          params={{ parent: 'none' }}
          exclude={(t) => t.id === task.id || t.id === task.parentId}
          excludedHint="that can be its parent"
          onPick={async (t) => {
            if (await onPatch({ parent: t.id })) setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** A top-level task's sub-tasks: open one, change its status, add new ones or move existing tasks under it. */
function SubtasksSection({ task }: { task: TaskDetail }) {
  const mutate = useMutate();
  const meta = useMeta().data;
  const epochs = useEpochs().data ?? [];
  const open = useOpenTask();
  const [mode, setMode] = useState<'idle' | 'new' | 'existing'>('idle');
  const [title, setTitle] = useState('');
  // New sub-tasks start in the parent's epoch; pick another for work that belongs elsewhere (VFX, SFX...).
  const [epochId, setEpochId] = useState(task.epochId ? String(task.epochId) : '');
  const { done, total } = task.subtasks;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const body = { title: title.trim(), parent: task.id, epochId: epochId ? Number(epochId) : null, folderId: epochId ? null : task.folderId };
    if (await mutate(() => api.post(`${V1}/tasks`, body), K, 'Sub-task added')) setTitle('');
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title">Sub-tasks {total > 0 && `(${done}/${total} done)`}</div>
        {mode === 'idle' && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm" onClick={() => setMode('existing')}>Add existing…</button>
            <button className="btn btn-sm" onClick={() => setMode('new')}>+ Sub-task</button>
          </div>
        )}
      </div>
      {task.children.map((c) => (
        <div key={c.id} className="link-row subtask-row">
          <a className="grow ellipsis" href={`?task=${c.id}`} onClick={(e) => open(e, c.id)}>
            <span className="key">{c.key}</span> {c.title}
          </a>
          {c.epochName && c.epochId !== task.epochId && (
            <span className="tiny muted ellipsis subtask-epoch" title={`Epoch: ${c.epochName}`}>◆ {c.epochName}</span>
          )}
          <select
            className="subtask-status"
            value={c.status}
            aria-label={`Status of ${c.key}`}
            onChange={(e) => void mutate(() => api.post(`${V1}/tasks/${c.id}/status`, { status: e.target.value }), K)}
          >
            {meta?.statuses.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
      ))}
      {mode === 'new' && (
        <form className="link-add stack" style={{ gap: 6 }} onSubmit={add}>
          <div className="row nowrap">
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sub-task title" aria-label="Sub-task title" />
            <select value={epochId} onChange={(e) => setEpochId(e.target.value)} aria-label="Epoch of the sub-task" style={{ width: 'auto', maxWidth: '40%' }}>
              <option value="">No epoch</option>
              {epochs.map((ep) => (
                <option key={ep.id} value={ep.id}>◆ {ep.name}</option>
              ))}
            </select>
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!title.trim()}>Add sub-task</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMode('idle'); setTitle(''); }}>Done</button>
          </div>
        </form>
      )}
      {mode === 'existing' && (
        <TaskSearch
          label="Find a task to make a sub-task"
          params={{ parent: 'none' }}
          exclude={(t) => t.id === task.id || t.subtasks.total > 0}
          excludedHint="that can become a sub-task"
          onPick={async (t) => {
            if (await mutate(() => api.patch(`${V1}/tasks/${t.id}`, { parent: task.id }), K, `${t.key} is now a sub-task`)) setMode('idle');
          }}
          onCancel={() => setMode('idle')}
        />
      )}
      {mode === 'idle' && total === 0 && (
        <div className="tiny muted">No sub-tasks. Use them for parts of the work that move across the board on their own or belong in another epoch.</div>
      )}
    </div>
  );
}

/** Links to other tasks: list (click to open), remove, and add by searching title or key. */
function LinksSection({ task }: { task: TaskDetail }) {
  const mutate = useMutate();
  const undoable = useUndoableDelete();
  const linkUrl = (otherId: number) => `${V1}/tasks/${task.id}/links/${otherId}`;
  const links = task.links.filter((l) => !undoable.isHidden(linkUrl(l.task.id)));
  const open = useOpenTask();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('relates');
  // Only tasks in the same project can be linked, so the search stays in this project.
  const linked = new Set(task.links.map((l) => l.task.id));
  const add = async (other: { id: number; key: string }) => {
    if (await mutate(() => api.post(`${V1}/tasks/${task.id}/links`, { task: other.id, kind }), K, `Linked ${other.key}`)) setAdding(false);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title">Links {links.length > 0 && `(${links.length})`}</div>
        {!adding && <button className="btn btn-sm" onClick={() => setAdding(true)}>+ Link task</button>}
      </div>
      {task.openBlockers > 0 && (
        <div className="blocked-note small">
          ⛔ Blocked by {task.openBlockers} open task{task.openBlockers > 1 ? 's' : ''} (not yet Alpha Complete)
        </div>
      )}
      {links.map((l) => (
        <div key={l.id} className="link-row">
          <span className="link-label tiny muted">{l.label}</span>
          <a className="grow ellipsis" href={`?task=${l.task.id}`} onClick={(e) => open(e, l.task.id)}>
            <span className="key">{l.task.key}</span> {l.task.title}
          </a>
          <StatusPill status={l.task.status} label={l.task.statusLabel} />
          <button
            className="btn btn-ghost btn-sm"
            aria-label={`Remove link to ${l.task.key}`}
            onClick={() => undoable.remove(linkUrl(l.task.id), `Removed link to ${l.task.key}`, K)}
          >
            ✕
          </button>
        </div>
      ))}
      {adding && (
        <TaskSearch
          label="Find a task to link"
          before={
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Link type" style={{ width: 'auto' }}>
              {LINK_KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          }
          exclude={(t) => t.id === task.id || linked.has(t.id)}
          excludedHint="that aren’t already linked"
          onPick={(t) => void add(t)}
          onCancel={() => setAdding(false)}
        />
      )}
      {!adding && task.links.length === 0 && <div className="tiny muted">No links yet. Link tasks that block, duplicate or relate to this one.</div>}
    </div>
  );
}

function EstimateInput({ value, onSave }: { value: number | null; onSave: (v: string) => void }) {
  const fmt = (m: number | null) => (m == null ? '' : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}` : `${m}m`);
  const [draft, setDraft] = useState(fmt(value));
  useEffect(() => setDraft(fmt(value)), [value]);
  return (
    <input
      value={draft}
      placeholder="e.g. 2h"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== fmt(value) && onSave(draft.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

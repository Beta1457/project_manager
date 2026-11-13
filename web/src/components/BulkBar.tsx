import { useState, type ReactNode } from 'react';
import { api, V1 } from '../api';
import { useEpochs, useFolders, useMeta } from '../hooks';
import { useMutate } from '../mutate';
import type { TaskSelection } from '../selection';
import type { Task } from '../types';
import { formatMinutes, joinAnd, plural } from '../util';
import { askConfirm } from './Confirm';
import { folderPath } from './Filters';
import { Sheet } from './Sheet';
import { TaskSearch } from './TaskSearch';
import { useToast } from './Toast';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The bar under the board or list while tasks are selected: changes them all in one request
 * (POST /tasks/bulk, all or nothing), or deletes them after asking.
 */
export function BulkBar({ selection, tasks, total }: {
  selection: TaskSelection;
  /** The selected tasks, in the order shown. */
  tasks: Task[];
  /** How many tasks are shown. */
  total: number;
}) {
  const meta = useMeta().data;
  const epochs = useEpochs().data ?? [];
  const folders = useFolders().data ?? [];
  const mutate = useMutate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pickingParent, setPickingParent] = useState(false);
  if (!selection.active || !meta) return null;

  const n = tasks.length;
  const ids = tasks.map((t) => t.id);
  const them = plural(n, 'task');
  const idle = n === 0 || busy;

  const send = async <T,>(body: Record<string, unknown>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await mutate(() => api.post<T>(`${V1}/tasks/bulk`, { ids, ...body }), ['tasks'], success);
    } finally {
      setBusy(false);
    }
  };
  const update = (set: Record<string, unknown>, success: string) => send({ action: 'update', set }, success);

  const moveTo = (value: string) => {
    if (value === 'inbox') return update({ folderId: null }, `Moved ${them} to the Inbox`);
    const id = Number(value.slice(2));
    if (value.startsWith('e:')) {
      return update({ epochId: id }, `Moved ${them} to the epoch "${epochs.find((e) => e.id === id)?.name ?? ''}"`);
    }
    return update({ folderId: id }, `Moved ${them} to the folder "${folderPath(folders, id)}"`);
  };

  const categories = (value: string) => {
    const id = Number(value.slice(1));
    const name = meta.categories.find((c) => c.id === id)?.name ?? '';
    return value.startsWith('+')
      ? send({ action: 'categories', add: [id] }, `Added "${name}" to ${them}`)
      : send({ action: 'categories', remove: [id] }, `Removed "${name}" from ${them}`);
  };

  const remove = async () => {
    const picked = new Set(ids);
    // Sub-tasks of the selected tasks that aren't selected themselves.
    const subtasks = tasks.reduce((sum, t) => sum + t.subtasks.total, 0) - tasks.filter((t) => t.parentId !== null && picked.has(t.parentId)).length;
    const logged = tasks.reduce((sum, t) => sum + t.loggedMinutes, 0);
    const goes = [n === 1 ? 'checklist' : 'checklists', 'comments', 'links'];
    if (logged > 0) goes.push(`${formatMinutes(logged)} of logged time`);
    const one = n === 1 ? tasks[0] : null;
    const body = (
      <>
        <p>
          {one ? `"${one.title}" will be deleted` : `These ${n} tasks will be deleted`}, along with {one ? 'its' : 'their'} {joinAnd(goes)}. This
          can't be undone.
        </p>
        {!one && (
          <ul className="confirm-list">
            {tasks.slice(0, 10).map((t) => (
              <li key={t.id}>
                <span className="key">{t.key}</span> {t.title}
              </li>
            ))}
            {n > 10 && <li className="muted">and {n - 10} more</li>}
          </ul>
        )}
        {subtasks > 0 && <p>{one ? 'Its' : 'Their'} {plural(subtasks, 'sub-task')} will stay, as top-level tasks, unless you tick the box.</p>}
      </>
    );
    const options = {
      title: `Delete ${one ? one.key : them}?`,
      body,
      confirmLabel: one ? 'Delete task' : `Delete ${them}`,
      // Many tasks at once: make sure it isn't a slip.
      typeToConfirm: n > 10 ? 'delete' : undefined,
    };
    let withSubtasks = false;
    if (subtasks > 0) {
      const answer = await askConfirm({ ...options, checkbox: `Also delete ${one ? 'its' : 'their'} ${plural(subtasks, 'sub-task')}` });
      if (!answer.ok) return;
      withSubtasks = answer.checked;
    } else if (!(await askConfirm(options))) return;
    const done = await send<{ deleted: number }>({ action: 'delete', withSubtasks });
    if (done) {
      toast(`Deleted ${plural(done.deleted, 'task')}`);
      selection.clear();
    }
  };

  return (
    <>
      <div className="bulk-bar" role="toolbar" aria-label="Change the selected tasks">
        <div className="bulk-head">
          <b aria-live="polite">{n ? `${n} selected` : 'Tap tasks to select them'}</b>
          {n < total && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={selection.selectAll}>
              Select all {total}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={selection.clear} title="Shortcut: Esc" aria-keyshortcuts="Escape">
            {selection.mode ? 'Done' : 'Clear'}
          </button>
        </div>
        <div className="bulk-actions">
          <ActionSelect label="Status…" ariaLabel="Set the status of the selected tasks" disabled={idle}
            onPick={(s) => update({ status: s }, `Moved ${them} to ${meta.statuses.find((x) => x.id === s)?.label ?? s}`)}>
            {meta.statuses.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </ActionSelect>
          <ActionSelect label="Move to…" ariaLabel="Move the selected tasks to an epoch or folder" disabled={idle} onPick={moveTo}>
            <option value="inbox">Inbox (unfiled)</option>
            {epochs.length > 0 && (
              <optgroup label="Epochs">
                {epochs.map((e) => (
                  <option key={e.id} value={`e:${e.id}`}>◆ {e.name}</option>
                ))}
              </optgroup>
            )}
            {folders.length > 0 && (
              <optgroup label="Folders">
                {folders.map((f) => (
                  <option key={f.id} value={`f:${f.id}`}>📁 {folderPath(folders, f.id)}</option>
                ))}
              </optgroup>
            )}
          </ActionSelect>
          <ActionSelect label="Priority…" ariaLabel="Set the priority of the selected tasks" disabled={idle}
            onPick={(p) => update({ priority: p }, `Set ${them} to ${p} priority`)}>
            {meta.priorities.map((p) => (
              <option key={p} value={p}>{capitalize(p)}</option>
            ))}
          </ActionSelect>
          <ActionSelect label="Type…" ariaLabel="Set the type of the selected tasks" disabled={idle}
            onPick={(t) => update({ type: t }, `Changed ${them} to the type ${t}`)}>
            {meta.types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </ActionSelect>
          {meta.categories.length > 0 && (
            <ActionSelect label="Categories…" ariaLabel="Add or remove a category on the selected tasks" disabled={idle} onPick={categories}>
              <optgroup label="Add">
                {meta.categories.map((c) => (
                  <option key={c.id} value={`+${c.id}`}>+ {c.name}</option>
                ))}
              </optgroup>
              <optgroup label="Remove">
                {meta.categories.map((c) => (
                  <option key={c.id} value={`-${c.id}`}>− {c.name}</option>
                ))}
              </optgroup>
            </ActionSelect>
          )}
          <button type="button" className="btn btn-sm" disabled={idle} onClick={() => setPickingParent(true)}>
            Parent…
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={idle} onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
      {pickingParent && (
        <Sheet title={`Parent task for ${them}`} variant="center" onClose={() => setPickingParent(false)}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              They become sub-tasks of the task you pick. A task that has sub-tasks of its own can't become one.
            </p>
            <TaskSearch
              label="Find the parent task"
              params={{ parent: 'none' }}
              exclude={(t) => ids.includes(t.id)}
              excludedHint="that aren't selected"
              onPick={(t) => {
                setPickingParent(false);
                void update({ parent: t.id }, `Made ${them} sub-tasks of ${t.key}`);
              }}
              onCancel={() => setPickingParent(false)}
            />
            {tasks.some((t) => t.parentId !== null) && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPickingParent(false);
                  void update({ parent: null }, n === 1 ? `${tasks[0].key} is a top-level task now` : `${n} tasks are top-level tasks now`);
                }}
              >
                Make them top-level tasks
              </button>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

/** A menu as a select: picking an entry runs it, and the select shows its label again. */
function ActionSelect({ label, ariaLabel, disabled, onPick, children }: {
  label: string;
  ariaLabel: string;
  disabled: boolean;
  onPick: (value: string) => unknown;
  children: ReactNode;
}) {
  return (
    <select value="" aria-label={ariaLabel} disabled={disabled} onChange={(e) => e.target.value && void onPick(e.target.value)}>
      <option value="">{label}</option>
      {children}
    </select>
  );
}

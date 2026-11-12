import { useState } from 'react';
import { api, V1 } from '../api';
import { useEpochs, useMeta } from '../hooks';
import { useMutate } from '../mutate';
import type { TaskDetail } from '../types';
import { Sheet, confirmAction } from './Sheet';
import { MarkdownEditor } from './MarkdownEditor';

interface Props {
  onClose: () => void;
  onCreated?: (id: number) => void;
  defaults?: { status?: string; epochId?: number | null; folderId?: number | null };
}

/** Fast capture: only the title is required. Everything else can be filled in later. */
export function QuickAdd({ onClose, onCreated, defaults = {} }: Props) {
  const mutate = useMutate();
  const meta = useMeta().data;
  const epochs = useEpochs().data ?? [];
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // Empty = let the server pick its default type ("Feature" if it still exists, else the first type).
  const [type, setType] = useState('');
  const [status, setStatus] = useState(defaults.status ?? 'open');
  const [priority, setPriority] = useState('medium');
  const [epochId, setEpochId] = useState<string>(defaults.epochId ? String(defaults.epochId) : '');
  const [categories, setCategories] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const shownType = type || (meta?.types.includes('Feature') ? 'Feature' : (meta?.types[0] ?? ''));
  // Ideas typed on a phone shouldn't vanish because of a stray tap outside the sheet.
  const dirty = Boolean(title.trim() || description.trim());

  const submit = async (openAfter: boolean) => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const created = await mutate(
      () =>
        api.post<TaskDetail>(`${V1}/tasks`, {
          title: title.trim(),
          description,
          type: type || undefined,
          status,
          priority,
          categories,
          epochId: epochId ? Number(epochId) : null,
          folderId: epochId ? null : (defaults.folderId ?? null),
        }),
      ['tasks'],
      'Task created',
    );
    setBusy(false);
    if (!created) return;
    if (openAfter) onCreated?.(created.id);
    onClose();
  };

  return (
    <Sheet title="New task" onClose={onClose} variant="center" confirmClose={() => !dirty || confirmAction('Discard this new task?')}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <input autoFocus placeholder="What's the idea?" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <MarkdownEditor placeholder="Details (optional). Markdown, images welcome." value={description} onChange={setDescription} rows={3} minHeight={80} />
        {meta && (
          <div className="check-list">
            {meta.categories.map((c) => {
              const on = categories.includes(c.name);
              return (
                <button type="button" key={c.id} className={`toggle-chip ${on ? 'on' : ''}`} style={on ? { background: c.color, borderColor: c.color } : undefined}
                  onClick={() => setCategories((xs) => (on ? xs.filter((x) => x !== c.name) : [...xs, c.name]))}>
                  {c.name}
                </button>
              );
            })}
          </div>
        )}
        {!more ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMore(true)} style={{ justifySelf: 'start' }}>
            + Type, status, priority, epoch
          </button>
        ) : (
          meta && (
            <div className="grid-2">
              <label className="field">Type
                <select value={shownType} onChange={(e) => setType(e.target.value)}>{meta.types.map((t) => <option key={t}>{t}</option>)}</select>
              </label>
              <label className="field">Status
                <select value={status} onChange={(e) => setStatus(e.target.value)}>{meta.statuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
              </label>
              <label className="field">Priority
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>{meta.priorities.map((p) => <option key={p} value={p}>{p}</option>)}</select>
              </label>
              <label className="field">Epoch
                <select value={epochId} onChange={(e) => setEpochId(e.target.value)}>
                  <option value="">None</option>
                  {epochs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </label>
            </div>
          )
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary grow" disabled={!title.trim() || busy}>Add task</button>
          <button type="button" className="btn" disabled={!title.trim() || busy} onClick={() => submit(true)}>Add & open</button>
        </div>
      </form>
    </Sheet>
  );
}

export function StatusPicker({ current, onPick, onClose }: { current: string; onPick: (status: string) => void; onClose: () => void }) {
  const meta = useMeta().data;
  return (
    <Sheet title="Move to" onClose={onClose} variant="center">
      <div className="stack" style={{ gap: 6 }}>
        {meta?.statuses.map((s) => (
          <button key={s.id} className={`btn ${s.id === current ? 'btn-primary' : ''}`} style={{ justifyContent: 'flex-start', minHeight: 46 }}
            onClick={() => { onPick(s.id); onClose(); }}>
            {s.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

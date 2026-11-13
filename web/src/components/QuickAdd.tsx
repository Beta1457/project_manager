import { useEffect, useRef, useState } from 'react';
import { api, V1 } from '../api';
import { useEpochs, useMeta, useTemplates } from '../hooks';
import { useMutate } from '../mutate';
import type { TaskDetail } from '../types';
import { plural } from '../util';
import { askConfirm } from './Confirm';
import { Sheet } from './Sheet';
import { MarkdownEditor } from './MarkdownEditor';
import { TemplateSummary, needsTitle } from './Templates';
import { useToast } from './Toast';

interface Props {
  onClose: () => void;
  onCreated?: (id: number) => void;
  defaults?: {
    status?: string;
    epochId?: number | null;
    folderId?: number | null;
    templateId?: number;
    /** Makes the new task a sub-task of this one; `parentLabel` ("APP-12 “Card”") says so in the dialog. */
    parentId?: number;
    parentLabel?: string;
    /** Opened as "Task from template…": the template list gets the focus. */
    chooseTemplate?: boolean;
  };
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Fast capture: only the title is required. Everything else can be filled in later. With a template, what
 * is left untouched here comes from the template; anything set here replaces the template's value.
 */
export function QuickAdd({ onClose, onCreated, defaults = {} }: Props) {
  const mutate = useMutate();
  const toast = useToast();
  const meta = useMeta().data;
  const epochs = useEpochs().data ?? [];
  const allTemplates = useTemplates().data ?? [];
  // A sub-task can't have sub-tasks of its own, so templates that bring some don't fit under a parent.
  const templates = defaults.parentId ? allTemplates.filter((t) => !t.subtasks.length) : allTemplates;
  const [templateId, setTemplateId] = useState(defaults.templateId ? String(defaults.templateId) : '');
  const template = templates.find((t) => String(t.id) === templateId) ?? null;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // Empty / undefined = not chosen here: the template's value, else the server's default.
  const [type, setType] = useState('');
  const [status, setStatus] = useState(defaults.status ?? 'open');
  const [priority, setPriority] = useState('');
  const [epochId, setEpochId] = useState<string | undefined>(undefined);
  const [categories, setCategories] = useState<string[] | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const templateSelect = useRef<HTMLSelectElement>(null);

  // "Task from template…" starts on the template list, once, as the dialog opens. This effect runs after the
  // Sheet's own, which focuses the dialog itself; a select, unlike a text field, doesn't open a phone's keyboard.
  useEffect(() => {
    if (defaults.chooseTemplate) templateSelect.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opened from an epoch or a folder: the task goes there, template or not.
  const fromPlace = defaults.epochId != null || defaults.folderId != null;
  const templateEpoch = template?.epoch ? epochs.find((e) => sameName(e.name, template.epoch!)) : undefined;
  const shownEpoch = epochId ?? (defaults.epochId ? String(defaults.epochId) : !fromPlace && templateEpoch ? String(templateEpoch.id) : '');
  const serverDefaultType = meta?.types.includes('Feature') ? 'Feature' : (meta?.types[0] ?? '');
  const shownType = type || (template?.type && meta?.types.find((t) => sameName(t, template.type!))) || serverDefaultType;
  const shownPriority = priority || template?.priority || 'medium';
  const shownCategories =
    categories ?? (template ? (meta?.categories ?? []).filter((c) => template.categories.some((n) => sameName(n, c.name))).map((c) => c.name) : []);
  const titleNeeded = !template || needsTitle(template);
  const ready = (!titleNeeded || title.trim() !== '') && !busy;
  // Ideas typed on a phone shouldn't vanish because of a stray tap outside the sheet.
  const dirty = Boolean(title.trim() || description.trim());

  const submit = async (openAfter: boolean) => {
    if (!ready) return;
    setBusy(true);
    const place =
      epochId !== undefined
        ? { epochId: epochId ? Number(epochId) : null, folderId: epochId ? null : (defaults.folderId ?? null) }
        : fromPlace || !template
          ? { epochId: defaults.epochId ?? null, folderId: defaults.epochId ? null : (defaults.folderId ?? null) }
          : {};
    const body = template
      ? {
          template: template.id,
          ...(title.trim() && { title: title.trim() }),
          ...(description.trim() && { description }),
          ...(type && { type }),
          status,
          ...(priority && { priority }),
          ...(categories !== undefined && { categories }),
          ...place,
          ...(defaults.parentId && { parent: defaults.parentId }),
        }
      : {
          title: title.trim(),
          description,
          type: type || undefined,
          status,
          priority: shownPriority,
          categories: categories ?? [],
          ...place,
          ...(defaults.parentId && { parent: defaults.parentId }),
        };
    const created = await mutate(
      () => api.post<TaskDetail & { warnings?: string[] }>(`${V1}/tasks`, body),
      ['tasks'],
      template ? undefined : defaults.parentId ? 'Sub-task created' : 'Task created',
    );
    setBusy(false);
    if (!created) return;
    if (template) {
      const made = created.children.length ? `Created ${created.key} with ${plural(created.children.length, 'sub-task')}` : `Created ${created.key}`;
      const notes = created.warnings ?? [];
      toast(notes.length ? `${made}. ${notes.join('. ')}.` : made, 'info', notes.length ? { duration: 12_000 } : undefined);
    }
    if (openAfter) onCreated?.(created.id);
    onClose();
  };

  return (
    <Sheet
      title={defaults.parentId ? 'New sub-task' : 'New task'}
      onClose={onClose}
      variant="center"
      confirmClose={() => !dirty || askConfirm({ title: 'Discard this new task?', body: 'What you typed will be lost.', confirmLabel: 'Discard' })}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        {defaults.parentLabel && <div className="small muted">Sub-task of {defaults.parentLabel}</div>}
        {templates.length > 0 && (
          <label className="field">Template
            <select ref={templateSelect} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">None (a blank task)</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        <input
          autoFocus
          placeholder={template ? (titleNeeded ? 'Title' : `Title (optional): ${template.title}`) : "What's the idea?"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Title"
        />
        {template && <TemplateSummary template={template} title={title} />}
        <MarkdownEditor
          placeholder={template?.description ? "Details (optional). Leave empty to use the template's." : 'Details (optional). Markdown, images welcome.'}
          value={description}
          onChange={setDescription}
          rows={3}
          minHeight={80}
        />
        {meta && (
          <div className="check-list">
            {meta.categories.map((c) => {
              const on = shownCategories.includes(c.name);
              return (
                <button type="button" key={c.id} className={`toggle-chip ${on ? 'on' : ''}`} aria-pressed={on} style={on ? { background: c.color, borderColor: c.color } : undefined}
                  onClick={() => setCategories(on ? shownCategories.filter((x) => x !== c.name) : [...shownCategories, c.name])}>
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
                <select value={shownPriority} onChange={(e) => setPriority(e.target.value)}>{meta.priorities.map((p) => <option key={p} value={p}>{p}</option>)}</select>
              </label>
              <label className="field">Epoch
                <select value={shownEpoch} onChange={(e) => setEpochId(e.target.value)}>
                  <option value="">None</option>
                  {epochs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </label>
            </div>
          )
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary grow" disabled={!ready}>Add task</button>
          <button type="button" className="btn" disabled={!ready} onClick={() => submit(true)}>Add & open</button>
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

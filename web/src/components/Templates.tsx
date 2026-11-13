import { useRef, useState, type FormEvent } from 'react';
import { api, V1 } from '../api';
import { useEpochs, useMeta } from '../hooks';
import { useMutate } from '../mutate';
import type { TaskDetail, Template, TemplateTask } from '../types';
import { formatMinutes, plural } from '../util';
import { askConfirm } from './Confirm';
import { MarkdownEditor } from './MarkdownEditor';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

const SLOT = /\{title\}/gi;

/** Whether a task made from this template needs a title typed: its title has "{title}" in it. */
export const needsTitle = (t: Pick<TemplateTask, 'title'>) => (t.title.trim() || '{title}').toLowerCase().includes('{title}');

/** What "{title}" becomes and what the new task will be called, for a title typed so far ("…" while empty). */
function titles(t: Template, typed: string) {
  const own = typed.trim();
  const pattern = t.title.trim() || '{title}';
  const main = needsTitle(t) ? pattern.replace(SLOT, () => own || '…') : own || pattern;
  const slot = own || (needsTitle(t) ? '…' : main);
  return { main, fill: (s: string) => s.replace(SLOT, () => slot) };
}

const some = (items: string[], max = 4) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/** A few lines saying what a template creates, with the title typed so far filled in. */
export function TemplateSummary({ template: t, title }: { template: Template; title?: string }) {
  // Without a title (Settings), the template's own wording, {title} and all.
  const { main, fill } = title === undefined ? { main: t.title.trim() || '{title}', fill: (s: string) => s } : titles(t, title);
  const facts = [
    t.type,
    t.priority && `${t.priority} priority`,
    t.estimateMinutes != null && formatMinutes(t.estimateMinutes),
    t.epoch && `in ${t.epoch}`,
    ...t.categories,
  ].filter(Boolean);
  return (
    <div className="template-summary small">
      <div>
        <b>{main}</b>
        {facts.length > 0 && <span className="muted"> · {facts.join(' · ')}</span>}
      </div>
      {t.checklist.length > 0 && <div className="muted">Checklist: {some(t.checklist.map(fill))}</div>}
      {t.subtasks.length > 0 && (
        <div className="muted">
          {plural(t.subtasks.length, 'sub-task')}: {some(t.subtasks.map((s) => fill(s.title) + (s.epoch ? ` (${s.epoch})` : '')))}
        </div>
      )}
    </div>
  );
}

// ---- Editing a template -----------------------------------------------------------------

/** A template task as the form holds it: an estimate as typed ("1h 30m"), the checklist one item per line. */
interface Draft {
  title: string;
  description: string;
  type: string;
  priority: string;
  categories: string[];
  estimate: string;
  checklist: string;
  epoch: string;
}

const toDraft = (t: TemplateTask): Draft => ({
  title: t.title,
  description: t.description,
  type: t.type ?? '',
  priority: t.priority ?? '',
  categories: t.categories,
  estimate: t.estimateMinutes != null ? formatMinutes(t.estimateMinutes) : '',
  checklist: t.checklist.join('\n'),
  epoch: t.epoch ?? '',
});

const fromDraft = (d: Draft) => ({
  title: d.title.trim(),
  description: d.description,
  type: d.type || null,
  priority: d.priority || null,
  categories: d.categories,
  estimate: d.estimate.trim() || null,
  checklist: d.checklist.split('\n').map((s) => s.trim()).filter(Boolean),
  epoch: d.epoch || null,
});

const blank = (title: string): Draft => ({ title, description: '', type: '', priority: '', categories: [], estimate: '', checklist: '', epoch: '' });

/** Creates a template (`template` null) or changes one. */
export function TemplateEditor({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const mutate = useMutate();
  const [name, setName] = useState(template?.name ?? '');
  const [main, setMain] = useState<Draft>(() => (template ? toDraft(template) : blank('{title}')));
  const [subs, setSubs] = useState<Draft[]>(() => (template?.subtasks ?? []).map(toDraft));
  const [busy, setBusy] = useState(false);
  const snapshot = JSON.stringify({ name, main, subs });
  const initial = useRef(snapshot);
  const dirty = snapshot !== initial.current;
  const lastSub = useRef<HTMLInputElement>(null);

  const untitled = subs.some((s) => !s.title.trim());

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || untitled || busy) return;
    setBusy(true);
    const body = { name: name.trim(), ...fromDraft(main), subtasks: subs.map(fromDraft) };
    const ok = await mutate(
      () => (template ? api.patch(`${V1}/templates/${template.id}`, body) : api.post(`${V1}/templates`, body)),
      ['templates'],
      template ? 'Template saved' : `Created the template "${body.name}"`,
    );
    setBusy(false);
    if (ok) {
      initial.current = snapshot;
      onClose();
    }
  };

  const addSub = () => {
    setSubs((xs) => [...xs, blank('')]);
    window.setTimeout(() => lastSub.current?.focus(), 0);
  };

  return (
    <Sheet
      title={template ? `Template: ${template.name}` : 'New template'}
      onClose={onClose}
      confirmClose={() => !dirty || askConfirm({ title: 'Discard your changes?', body: 'The template stays as it was.', confirmLabel: 'Discard' })}
    >
      <form className="stack" onSubmit={save}>
        <label className="field">Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Card, Boss fight, Bug report" autoFocus={!template} />
        </label>
        <label className="field">Task title
          <input value={main.title} onChange={(e) => setMain({ ...main, title: e.target.value })} maxLength={500} />
          <span className="field-hint">
            {'{title}'} becomes the title you type when you use the template, e.g. "Card: {'{title}'}". Without it, the title is used as it is.
          </span>
        </label>
        <TaskFields value={main} onChange={setMain} epochNone="None (where the task is added)" />
        <label className="field">Description
          <MarkdownEditor value={main.description} onChange={(description) => setMain({ ...main, description })} rows={4} minHeight={90} placeholder="Optional. {title} works here too." />
        </label>

        <div className="row">
          <h3 className="grow" style={{ margin: 0 }}>Sub-tasks</h3>
          <button type="button" className="btn btn-sm" onClick={addSub} disabled={subs.length >= 50}>+ Sub-task</button>
        </div>
        {subs.length === 0 && <p className="small muted" style={{ margin: 0 }}>None. Each sub-task can go to an epoch of its own, like VFX or Audio.</p>}
        {subs.map((s, i) => (
          <div key={i} className="template-sub stack">
            <div className="row nowrap">
              <input
                ref={i === subs.length - 1 ? lastSub : undefined}
                className="grow"
                value={s.title}
                maxLength={500}
                aria-label={`Sub-task ${i + 1} title`}
                placeholder="e.g. VFX: {title}"
                onChange={(e) => setSubs((xs) => xs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              />
              <button type="button" className="btn btn-ghost btn-danger btn-sm" aria-label={`Remove sub-task ${i + 1}`}
                onClick={() => setSubs((xs) => xs.filter((_, j) => j !== i))}>✕</button>
            </div>
            <TaskFields
              value={s}
              onChange={(d) => setSubs((xs) => xs.map((x, j) => (j === i ? d : x)))}
              epochNone="Where its parent is"
              label={`Sub-task ${i + 1}`}
            />
          </div>
        ))}
        {untitled && <p className="small muted" style={{ margin: 0 }}>Every sub-task needs a title.</p>}
        <div className="row">
          <button type="submit" className="btn btn-primary grow" disabled={!name.trim() || untitled || busy}>{template ? 'Save template' : 'Create template'}</button>
        </div>
      </form>
    </Sheet>
  );
}

/** Type, priority, epoch, estimate, categories and checklist of a template task. */
function TaskFields({ value, onChange, epochNone, label }: { value: Draft; onChange: (d: Draft) => void; epochNone: string; label?: string }) {
  const meta = useMeta().data;
  const epochs = useEpochs().data ?? [];
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...value, [k]: v });
  const prefix = label ? `${label} ` : '';
  const epochNames = [...new Set(epochs.map((e) => e.name))];
  const has = (names: string[], name: string) => names.some((n) => n.toLowerCase() === name.toLowerCase());
  const categories = meta?.categories ?? [];
  // Names this project doesn't have (renamed, deleted, or copied from another project) stay visible.
  const missingCategories = value.categories.filter((n) => !has(categories.map((c) => c.name), n));
  return (
    <>
      <div className="grid-2">
        <label className="field">Type
          <select value={value.type} onChange={(e) => set('type', e.target.value)} aria-label={`${prefix}type`}>
            <option value="">Default</option>
            {meta?.types.map((t) => <option key={t}>{t}</option>)}
            {value.type && meta && !has(meta.types, value.type) && <option value={value.type}>{value.type} (not in this project)</option>}
          </select>
        </label>
        <label className="field">Priority
          <select value={value.priority} onChange={(e) => set('priority', e.target.value)} aria-label={`${prefix}priority`}>
            <option value="">Default (medium)</option>
            {meta?.priorities.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field">Epoch
          <select value={value.epoch} onChange={(e) => set('epoch', e.target.value)} aria-label={`${prefix}epoch`}>
            <option value="">{epochNone}</option>
            {epochNames.map((n) => <option key={n}>{n}</option>)}
            {value.epoch && !has(epochNames, value.epoch) && <option value={value.epoch}>{value.epoch} (not in this project)</option>}
          </select>
        </label>
        <label className="field">Estimate
          <input value={value.estimate} onChange={(e) => set('estimate', e.target.value)} placeholder="e.g. 2h or 1h 30m" aria-label={`${prefix}estimate`} />
        </label>
      </div>
      {(categories.length > 0 || missingCategories.length > 0) && (
        <div className="check-list" role="group" aria-label={`${prefix}categories`}>
          {categories.map((c) => {
            const on = has(value.categories, c.name);
            return (
              <button type="button" key={c.id} className={`toggle-chip small-chip ${on ? 'on' : ''}`} aria-pressed={on}
                style={on ? { background: c.color, borderColor: c.color } : undefined}
                onClick={() => set('categories', on ? value.categories.filter((n) => n.toLowerCase() !== c.name.toLowerCase()) : [...value.categories, c.name])}>
                {c.name}
              </button>
            );
          })}
          {missingCategories.map((n) => (
            <button type="button" key={n} className="toggle-chip small-chip on" aria-pressed title="Not a category in this project: left out when the template is used. Click to remove."
              onClick={() => set('categories', value.categories.filter((x) => x !== n))}>
              {n} ✕
            </button>
          ))}
        </div>
      )}
      <label className="field">Checklist
        <textarea className="template-checklist" rows={value.checklist ? Math.min(8, value.checklist.split('\n').length + 1) : 2} value={value.checklist}
          onChange={(e) => set('checklist', e.target.value)} placeholder="One item per line" aria-label={`${prefix}checklist`} />
      </label>
    </>
  );
}

// ---- Saving a task as a template --------------------------------------------------------

export function SaveAsTemplate({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const n = task.subtasks.total;
  const [name, setName] = useState(task.title.slice(0, 100));
  const [title, setTitle] = useState(task.title);
  const [withSubtasks, setWithSubtasks] = useState(n > 0);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !title.trim() || busy) return;
    setBusy(true);
    const made = await mutate(
      () => api.post<Template>(`${V1}/templates`, { name: name.trim(), title: title.trim(), fromTask: task.id, includeSubtasks: withSubtasks }),
      ['templates'],
    );
    setBusy(false);
    if (!made) return;
    toast(`Saved the template "${made.name}". Change it any time in Settings.`);
    onClose();
  };
  return (
    <Sheet title="Save as template" onClose={onClose} variant="center">
      <form className="stack" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>
          Copies the type, priority, epoch, categories, estimate, description and checklist of {task.key}, so new tasks can start from them.
        </p>
        <label className="field">Template name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </label>
        <label className="field">Task title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} />
          <span className="field-hint">Put {'{title}'} where each new task's own title goes, e.g. "Boss: {'{title}'}".</span>
        </label>
        {n > 0 && (
          <label className="row nowrap small">
            <input type="checkbox" checked={withSubtasks} onChange={(e) => setWithSubtasks(e.target.checked)} />
            Include its {plural(n, 'sub-task')}
          </label>
        )}
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || !title.trim() || busy}>Save template</button>
      </form>
    </Sheet>
  );
}

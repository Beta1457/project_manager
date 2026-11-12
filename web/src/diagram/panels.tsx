import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEpochs, useTree } from '../hooks';
import { useProject } from '../projectContext';
import { contrastText, plural } from '../util';
import { useTaskParam } from '../components/Layout';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { layerColor } from './flow';
import { descendantsOf, roleOf, type DiagramEdge, type DiagramNode, type ViewEdge } from './model';

/** A value edited in a form and saved when the field loses focus, on Enter, or when the panel closes. */
function useDraft(value: string, commit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  const ref = useRef({ draft, value, sent: value, commit });
  ref.current.draft = draft;
  ref.current.commit = commit;
  useEffect(() => {
    ref.current.value = value;
    ref.current.sent = value;
    setDraft(value);
  }, [value]);
  const flush = () => {
    const r = ref.current;
    if (r.draft === r.value || r.draft === r.sent) return;
    r.sent = r.draft;
    r.commit(r.draft);
  };
  // Closing the panel (Esc, the backdrop) doesn't always blur the field first.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flush(), []);
  return { draft, setDraft, flush };
}

function TextField(props: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  mono?: boolean;
}) {
  const { label, value, onCommit, multiline, mono, placeholder, maxLength, type, min, max } = props;
  const { draft, setDraft, flush } = useDraft(value, onCommit);
  return (
    <label className="field">
      {label}
      {multiline ? (
        <textarea rows={4} value={draft} placeholder={placeholder} maxLength={maxLength} onChange={(e) => setDraft(e.target.value)} onBlur={flush} />
      ) : (
        <input
          value={draft}
          type={type}
          min={min}
          max={max}
          step={type === 'number' ? 'any' : undefined}
          placeholder={placeholder}
          maxLength={maxLength}
          className={mono ? 'mono' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={flush}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      )}
    </label>
  );
}

/** "" for no number; otherwise the number clamped to [min, max], or null if it isn't one. */
function parseNumber(text: string, min: number, max: number, integer = false): number | undefined | null {
  if (!text.trim()) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const v = Math.min(max, Math.max(min, n));
  return integer ? Math.round(v) : v;
}

const numberText = (v: number | undefined) => (v === undefined ? '' : String(v));

/** Where a box sits: "Combat › Weapons › Sword". */
function pathLabel(byId: Map<string, DiagramNode>, id: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let n = byId.get(id); n && !seen.has(n.id); n = n.parent !== undefined ? byId.get(n.parent) : undefined) {
    seen.add(n.id);
    names.unshift(n.label);
  }
  return names.join(' › ');
}

/**
 * The groups a box can be put inside: not itself or anything inside it (a loop), and not so deep that the
 * box, or the deepest box inside it, would end up more than `depthLimit` groups down.
 */
function parentChoices(nodes: DiagramNode[], node: DiagramNode, depthLimit: number) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent === undefined) continue;
    const list = kids.get(n.parent);
    if (list) list.push(n.id);
    else kids.set(n.parent, [n.id]);
  }
  const levelsBelow = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return Math.max(0, ...(kids.get(id) ?? []).map((k) => 1 + levelsBelow(k, seen)));
  };
  const depth = (id: string) => {
    let d = 0;
    const seen = new Set<string>();
    for (let p = byId.get(id)?.parent; p !== undefined && !seen.has(p); p = byId.get(p)?.parent) {
      seen.add(p);
      d++;
    }
    return d;
  };
  const inside = descendantsOf(nodes, node.id);
  const below = levelsBelow(node.id);
  return nodes
    .filter((n) => n.id !== node.id && !inside.has(n.id) && depth(n.id) + 1 + below <= depthLimit)
    .map((n) => ({ id: n.id, label: pathLabel(byId, n.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface NodePanelProps {
  node: DiagramNode;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  layers: string[];
  editable: boolean;
  depthLimit: number;
  /** How it is drawn when it has boxes inside: as an open group or a closed one. */
  group: 'open' | 'closed' | null;
  onToggle: () => void;
  onChange: (patch: Partial<DiagramNode>) => void;
  onMove: (parent: string | undefined) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** A box's details; while editing, all of its fields. */
export function NodePanel(p: NodePanelProps) {
  const { node, nodes, edges, editable } = p;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const inside = useMemo(() => descendantsOf(nodes, node.id).size, [nodes, node.id]);
  const arrowsIn = edges.filter((e) => e.target === node.id).length;
  const arrowsOut = edges.filter((e) => e.source === node.id).length;
  const color = layerColor(node.layer);
  const parent = node.parent !== undefined ? byId.get(node.parent) : undefined;
  const groupButton = p.group && (
    <button type="button" className="btn" onClick={p.onToggle}>
      {p.group === 'open' ? 'Close group' : `Open group (${inside} inside)`}
    </button>
  );

  if (!editable) {
    const role = roleOf(node);
    return (
      <Sheet title={node.label} onClose={p.onClose} variant="center">
        <div className="stack">
          <div className="row">
            <span className="pill" style={{ background: color, color: contrastText(color) }}>
              {node.layer}
            </span>
            {parent && (
              <span className="small muted">
                Inside <b>{pathLabel(byId, parent.id)}</b>
              </span>
            )}
          </div>
          {node.path && <code className="diagram-path">{node.path}</code>}
          {node.role && <div className="diagram-role">{role}</div>}
          <div style={{ whiteSpace: 'pre-wrap' }}>{node.description || (!node.role && <span className="muted">No description.</span>)}</div>
          <div className="small muted">
            {[
              inside ? `${plural(inside, 'box', 'boxes')} inside` : '',
              `${plural(arrowsIn, 'arrow')} in, ${arrowsOut} out`,
              node.weight !== undefined ? `weight ${node.weight.toLocaleString()}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {(groupButton || node.link) && (
            <div className="row">
              {groupButton}
              {node.link && <LinkButton link={node.link} />}
            </div>
          )}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Edit box" onClose={p.onClose} variant="center">
      <div className="stack">
        <TextField label="Label" value={node.label} maxLength={200} onCommit={(v) => v.trim() && p.onChange({ label: v.trim() })} />
        <div className="grid-2">
          <label className="field">
            Layer
            <select value={node.layer} onChange={(e) => p.onChange({ layer: e.target.value })}>
              {[...new Set([...p.layers, node.layer])].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <ParentPicker {...p} />
        </div>
        <TextField label="Path in the code (optional)" value={node.path ?? ''} maxLength={300} mono placeholder="src/combat/"
          onCommit={(v) => p.onChange({ path: v.trim() || undefined })} />
        <TextField label="Role: what it does, in one line (optional)" value={node.role ?? ''} maxLength={200}
          onCommit={(v) => p.onChange({ role: v.replace(/\s+/g, ' ').trim() || undefined })} />
        <TextField label="Description" value={node.description} maxLength={5000} multiline onCommit={(v) => p.onChange({ description: v })} />
        <div className="grid-2">
          <TextField label="Weight (bigger boxes; e.g. lines of code)" type="number" min={0} value={numberText(node.weight)}
            onCommit={(v) => {
              const w = parseNumber(v, 0, 1e9);
              if (w !== null) p.onChange({ weight: w });
            }} />
          <SizeFields node={node} onChange={p.onChange} />
        </div>
        <LinkFields node={node} onChange={p.onChange} />
        <div className="small muted">
          {[inside ? `${plural(inside, 'box', 'boxes')} inside` : '', `${plural(arrowsIn, 'arrow')} in, ${arrowsOut} out`].filter(Boolean).join(' · ')}
        </div>
        <div className="row">
          {groupButton}
          {node.link && <LinkButton link={node.link} />}
          <span className="grow" />
          <button type="button" className="btn btn-danger" onClick={p.onDelete}>
            Delete box
          </button>
          <button type="button" className="btn btn-primary" onClick={p.onClose}>
            Done
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function ParentPicker({ node, nodes, depthLimit, onMove }: NodePanelProps) {
  const choices = useMemo(() => parentChoices(nodes, node, depthLimit), [nodes, node, depthLimit]);
  return (
    <label className="field">
      Inside
      <select value={node.parent ?? ''} onChange={(e) => onMove(e.target.value || undefined)}>
        <option value="">Nothing (top level)</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SizeFields({ node, onChange }: { node: DiagramNode; onChange: (patch: Partial<DiagramNode>) => void }) {
  return (
    <div className="field-pair">
      <TextField label="Width" type="number" min={40} max={4000} value={numberText(node.width)} placeholder="auto"
        onCommit={(v) => {
          const w = parseNumber(v, 40, 4000, true);
          if (w !== null) onChange({ width: w });
        }} />
      <TextField label="Height" type="number" min={24} max={4000} value={numberText(node.height)} placeholder="auto"
        onCommit={(v) => {
          const h = parseNumber(v, 24, 4000, true);
          if (h !== null) onChange({ height: h });
        }} />
    </div>
  );
}

function LinkButton({ link }: { link: NonNullable<DiagramNode['link']> }) {
  const navigate = useNavigate();
  const [, openTask] = useTaskParam();
  const follow = () => {
    if (link.kind === 'task') openTask(link.id);
    else if (link.kind === 'epoch') navigate(`/epochs/${link.id}`);
    else navigate('/explorer');
  };
  return (
    <button type="button" className="btn" onClick={follow}>
      Open linked {link.kind} →
    </button>
  );
}

/** Link the box to a task (by key) or an epoch of this project. */
function LinkFields({ node, onChange }: { node: DiagramNode; onChange: (patch: Partial<DiagramNode>) => void }) {
  const epochs = useEpochs().data ?? [];
  const tasks = useTree().data?.tasks;
  const { project } = useProject();
  const toast = useToast();
  const link = node.link;
  const linkedKey = link?.kind === 'task' ? (tasks?.find((t) => t.id === link.id)?.key ?? '') : '';
  // null = showing the linked task's key; a string = what is being typed.
  const [taskDraft, setTaskDraft] = useState<string | null>(null);
  const commitTask = () => {
    if (taskDraft === null) return;
    const raw = taskDraft.trim().toUpperCase();
    setTaskDraft(null);
    if (!raw) {
      if (link?.kind === 'task') onChange({ link: null });
      return;
    }
    // "12" means a task in this project; diagrams can only link to their own project's tasks.
    const key = /^\d+$/.test(raw) ? `${project.key}-${raw}` : raw;
    const task = tasks?.find((t) => t.key === key);
    if (task) onChange({ link: { kind: 'task', id: task.id } });
    else toast(`No task ${key} in ${project.name}`, 'error');
  };
  return (
    <div className="grid-2">
      <label className="field">
        Link to task
        <input value={taskDraft ?? linkedKey} placeholder={`${project.key}-12`} onChange={(e) => setTaskDraft(e.target.value)}
          onBlur={commitTask} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      </label>
      <label className="field">
        …or epoch
        <select value={link?.kind === 'epoch' ? link.id : ''} onChange={(e) => onChange({ link: e.target.value ? { kind: 'epoch', id: Number(e.target.value) } : null })}>
          <option value="">None</option>
          {epochs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export interface EdgePanelProps {
  edge: DiagramEdge;
  from: string;
  to: string;
  editable: boolean;
  onChange: (patch: Partial<DiagramEdge>) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** One stored arrow: its label and how many connections it stands for. */
export function EdgePanel({ edge, from, to, editable, onChange, onDelete, onClose }: EdgePanelProps) {
  const ends = (
    <div>
      <b>{from}</b> → <b>{to}</b>
    </div>
  );
  if (!editable) {
    return (
      <Sheet title="Arrow" onClose={onClose} variant="center">
        <div className="stack">
          {ends}
          {edge.label && <div>{edge.label}</div>}
          {(edge.count ?? 1) > 1 && <div className="small muted">Stands for {edge.count} connections.</div>}
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet title="Arrow" onClose={onClose} variant="center">
      <div className="stack">
        {ends}
        <TextField label="Label (optional)" value={edge.label} maxLength={200} placeholder="e.g. calls, emits, reads"
          onCommit={(v) => onChange({ label: v.trim() })} />
        <TextField label="Stands for how many connections (optional)" type="number" min={1} max={1000000} value={numberText(edge.count)}
          placeholder="1" onCommit={(v) => {
            const c = parseNumber(v, 1, 1e6, true);
            if (c !== null) onChange({ count: c === undefined || c <= 1 ? undefined : c });
          }} />
        <div className="row">
          <span className="grow" />
          <button type="button" className="btn btn-danger" onClick={onDelete}>
            Delete arrow
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Sheet>
  );
}

const BUNDLE_LIST_MAX = 100;

/** An arrow that adds up several stored ones, between groups shown closed. */
export function BundlePanel({ edge, labelOf, openable, onOpen, onClose }: {
  edge: ViewEdge;
  labelOf: (id: string) => string;
  /** Which of its two ends are closed groups that can be opened. */
  openable: string[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const shown = edge.members.slice(0, BUNDLE_LIST_MAX);
  return (
    <Sheet title={`${edge.count} connections`} onClose={onClose} variant="center">
      <div className="stack">
        <div>
          <b>{labelOf(edge.source)}</b> → <b>{labelOf(edge.target)}</b>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          This arrow adds up {plural(edge.members.length, 'arrow')} between the boxes inside. Open a group to see them, and to edit them one by one.
        </p>
        <ul className="bundle-list">
          {shown.map((m) => (
            <li key={m.id}>
              {labelOf(m.source)} → {labelOf(m.target)}
              {m.label && <span className="muted"> · {m.label}</span>}
              {(m.count ?? 1) > 1 && <span className="muted"> ×{m.count}</span>}
            </li>
          ))}
        </ul>
        {edge.members.length > shown.length && <div className="small muted">…and {edge.members.length - shown.length} more</div>}
        {openable.length > 0 && (
          <div className="row">
            {openable.map((id) => (
              <button key={id} type="button" className="btn" onClick={() => onOpen(id)}>
                Open {labelOf(id)}
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** The bar at the bottom of the canvas describing what is selected, with its most used actions. */
export function Inspector({ children, actions, onClose }: { children: ReactNode; actions: ReactNode; onClose: () => void }) {
  return (
    <div className="diagram-inspector" role="region" aria-label="Selection">
      <div className="grow diagram-inspector-text">{children}</div>
      <div className="row nowrap">
        {actions}
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={onClose} aria-label="Clear selection" title="Clear selection">
          ✕
        </button>
      </div>
    </div>
  );
}

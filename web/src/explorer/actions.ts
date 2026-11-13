import type { MenuNode } from '../components/ContextMenu';
import type { FileItem, Tree } from '../types';
import { joinAnd, plural } from '../util';

/**
 * What the Explorer offers for each kind of row, and for several selected rows: one list, shown as the
 * right-click menu on a computer and as the ⋯ sheet on a phone. Pure functions, so the rules (what can be
 * pasted or moved where) live in one place.
 */

export type Kind = 'folder' | 'epoch' | 'task' | 'file';
export interface Item {
  kind: Kind;
  id: number;
  name: string;
}
/** What a menu is for: a row, several selected rows, the top level of the tree ("Root"), or the Inbox of unfiled tasks. */
export type Target = Item | { kind: 'selection'; items: Item[] } | { kind: 'root' } | { kind: 'inbox' };
/** Where something goes: a folder (null: the top level; for tasks, the Inbox), or for tasks an epoch. */
export type Dest = { folderId: number | null } | { epochId: number };
/** The Explorer's own clipboard: one or more items, to move (cut) or copy. */
export interface Clip {
  mode: 'cut' | 'copy';
  items: Item[];
}

export type ActionId =
  | 'new-folder'
  | 'new-epoch'
  | 'new-task'
  | 'new-from-template'
  | 'new-doc'
  | 'upload'
  | 'open'
  | 'toggle'
  | 'select'
  | 'clear-selection'
  | 'add-subtask'
  | 'edit'
  | 'download'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'move'
  | 'rename'
  | 'delete';

export interface ActionContext {
  tree: Tree;
  clip: Clip | null;
  /** A folder or epoch row: whether it is expanded. */
  expanded: boolean;
  /** A row: whether it is selected. */
  selected: boolean;
  hasTemplates: boolean;
}

export const ICONS: Record<Kind, string> = { folder: '📁', epoch: '◆', task: '▫', file: '📄' };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const SHORTCUTS = {
  cut: isMac ? '⌘X' : 'Ctrl+X',
  copy: isMac ? '⌘C' : 'Ctrl+C',
  paste: isMac ? '⌘V' : 'Ctrl+V',
  rename: 'F2',
  delete: isMac ? '⌘⌫' : 'Del',
  select: isMac ? '⌘+click' : 'Ctrl+click',
};
/** Whether a key press is the Delete shortcut: Delete, or ⌘⌫ on a Mac (which has no Delete key). */
export const isDeleteKey = (e: { key: string; metaKey: boolean }) => e.key === 'Delete' || (isMac && e.metaKey && e.key === 'Backspace');

/** An item's row key, as in data-row: "folder-12". */
export const keyOf = (item: Pick<Item, 'kind' | 'id'>) => `${item.kind}-${item.id}`;

// The same list as the server's (files.ts): these open in the text editor.
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.xml',
  '.cs', '.gd', '.js', '.ts', '.tsx', '.jsx', '.py', '.lua', '.c', '.h', '.cpp', '.hpp', '.java', '.shader',
  '.hlsl', '.glsl', '.css', '.html', '.htm', '.svg', '.sh', '.ps1', '.bat', '.sql', '.tscn', '.tres', '.godot',
]);
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export function isEditable(file: Pick<FileItem, 'name' | 'mime' | 'size'>): boolean {
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : '';
  return (TEXT_EXT.has(ext) || file.mime.startsWith('text/')) && file.size <= MAX_EDIT_BYTES;
}

/** Whether folder `id` is `ancestor` itself or somewhere inside it. */
export function isWithin(tree: Tree, id: number | null, ancestor: number): boolean {
  const seen = new Set<number>();
  for (let cur = id; cur !== null && !seen.has(cur); cur = tree.folders.find((f) => f.id === cur)?.parentId ?? null) {
    if (cur === ancestor) return true;
    seen.add(cur);
  }
  return false;
}

/** The item as it is in the tree now (its current name), or null if it is gone. */
export function findItem(tree: Tree, item: Pick<Item, 'kind' | 'id'>): Item | null {
  const { kind, id } = item;
  const name =
    kind === 'folder' ? tree.folders.find((f) => f.id === id)?.name
    : kind === 'epoch' ? tree.epochs.find((e) => e.id === id)?.name
    : kind === 'task' ? tree.tasks.find((t) => t.id === id)?.title
    : tree.files.find((f) => f.id === id)?.name;
  return name === undefined ? null : { kind, id, name };
}

/** Where an item is now. */
export function placeOf(tree: Tree, item: Item): Dest {
  switch (item.kind) {
    case 'folder':
      return { folderId: tree.folders.find((f) => f.id === item.id)?.parentId ?? null };
    case 'epoch':
      return { folderId: tree.epochs.find((e) => e.id === item.id)?.folderId ?? null };
    case 'task': {
      const t = tree.tasks.find((x) => x.id === item.id);
      return t?.epochId ? { epochId: t.epochId } : { folderId: t?.folderId ?? null };
    }
    case 'file':
      return { folderId: tree.files.find((f) => f.id === item.id)?.folderId ?? null };
  }
}

/** The row that holds an item: its folder, epoch, the top level or the Inbox. */
export function containerOf(tree: Tree, item: Item): Target {
  const place = placeOf(tree, item);
  if ('epochId' in place) return findItem(tree, { kind: 'epoch', id: place.epochId }) ?? { kind: 'inbox' };
  if (place.folderId !== null) return findItem(tree, { kind: 'folder', id: place.folderId }) ?? { kind: 'root' };
  return item.kind === 'task' ? { kind: 'inbox' } : { kind: 'root' };
}

/** `“Art”` for one item; `3 items` for several. */
export function itemsName(items: Item[]): string {
  return items.length === 1 ? `“${items[0].name}”` : `${items.length} items`;
}

/** What several items are: "2 folders, 1 epoch and 3 tasks". */
export function describeKinds(items: Item[]): string {
  const count = (k: Kind) => items.filter((i) => i.kind === k).length;
  return joinAnd(
    (['folder', 'epoch', 'task', 'file'] as const).map((k) => count(k) && plural(count(k), k)).filter((s): s is string => !!s),
  );
}

/**
 * Where the clipboard's items land if pasted on `target`, or null where they can't all go: anything into a
 * folder (but a folder not into itself or a folder inside it), folders, epochs and files at the top level
 * (tasks cut or copied along with them go to the Inbox), tasks alone into an epoch or the Inbox.
 */
export function pasteDestination(clip: Clip | null, target: Target, tree: Tree): Dest | null {
  if (!clip?.items.length) return null;
  const tasksOnly = clip.items.every((i) => i.kind === 'task');
  switch (target.kind) {
    case 'folder':
      return clip.items.some((i) => i.kind === 'folder' && isWithin(tree, target.id, i.id)) ? null : { folderId: target.id };
    case 'root':
      return tasksOnly ? null : { folderId: null };
    case 'epoch':
      return tasksOnly ? { epochId: target.id } : null;
    case 'inbox':
      return tasksOnly ? { folderId: null } : null;
    default:
      return null;
  }
}

/** Why the clipboard's items can't go on `target`, for the keyboard shortcut (the menu just leaves Paste out). */
export function pasteRefusal(clip: Clip, target: Target): string {
  const has = (k: Kind) => clip.items.some((i) => i.kind === k);
  if (has('folder') && target.kind === 'folder') return "A folder can't go inside itself or a folder inside it";
  if (target.kind === 'epoch' || target.kind === 'inbox') return target.kind === 'epoch' ? 'Only tasks can go inside an epoch' : 'Only tasks go in the Inbox';
  if (has('task')) return 'Tasks go in a folder, an epoch or the Inbox';
  return `${itemsName(clip.items)} can't go there`;
}

/** Why the items can't all move to `dest`, or null when they can (the server checks the same). */
export function moveRefusal(items: Item[], dest: Dest, tree: Tree): string | null {
  if ('epochId' in dest) return items.every((i) => i.kind === 'task') ? null : 'Only tasks can go inside an epoch';
  const folderId = dest.folderId;
  if (folderId === null) return null;
  const into = items.find((i) => i.kind === 'folder' && isWithin(tree, folderId, i.id));
  return into ? `“${into.name}” can't go inside itself or a folder inside it` : null;
}

/** "the top level", "the Inbox", "“Art”". */
export function destName(tree: Tree, dest: Dest, kind: Kind): string {
  if ('epochId' in dest) return `“${tree.epochs.find((e) => e.id === dest.epochId)?.name ?? 'the epoch'}”`;
  if (dest.folderId === null) return kind === 'task' ? 'the Inbox' : 'the top level';
  return `“${tree.folders.find((f) => f.id === dest.folderId)?.name ?? 'the folder'}”`;
}

/** destName for several items: at the top level, tasks go to the Inbox. */
export function destNameFor(tree: Tree, dest: Dest, items: Item[]): string {
  const tasks = items.filter((i) => i.kind === 'task').length;
  if ('epochId' in dest || dest.folderId !== null || tasks === 0) return destName(tree, dest, 'folder');
  return tasks === items.length ? 'the Inbox' : 'the top level (tasks to the Inbox)';
}

/** A row of the tree as shown: an item, or the "No tasks" line under an open, empty epoch. */
export type TreeRow =
  | { type: 'item'; key: string; item: Item; depth: number; open?: boolean }
  | { type: 'empty'; key: string; depth: number };

/**
 * The tree's rows in the order shown, and how deep each one sits. In each folder: its folders, its epochs
 * (with their tasks when open), its tasks, then its files. Tasks at the top level are in the Inbox instead.
 */
export function flattenTree(tree: Tree, expanded: ReadonlySet<string>): TreeRow[] {
  const by = <T, K>(list: T[], key: (x: T) => K) => {
    const map = new Map<K, T[]>();
    for (const x of list) {
      const group = map.get(key(x));
      if (group) group.push(x);
      else map.set(key(x), [x]);
    }
    return map;
  };
  const folders = by(tree.folders, (f) => f.parentId);
  const epochs = by(tree.epochs, (e) => e.folderId);
  const epochTasks = by(tree.tasks.filter((t) => t.epochId !== null), (t) => t.epochId);
  const folderTasks = by(tree.tasks.filter((t) => t.epochId === null), (t) => t.folderId);
  const files = by(tree.files, (f) => f.folderId);
  const rows: TreeRow[] = [];
  const task = (t: Tree['tasks'][number], depth: number): TreeRow => ({ type: 'item', key: `task-${t.id}`, item: { kind: 'task', id: t.id, name: t.title }, depth });
  const walk = (folderId: number | null, depth: number) => {
    for (const f of folders.get(folderId) ?? []) {
      const key = `folder-${f.id}`;
      const open = expanded.has(key);
      rows.push({ type: 'item', key, item: { kind: 'folder', id: f.id, name: f.name }, depth, open });
      if (open) walk(f.id, depth + 1);
    }
    for (const e of epochs.get(folderId) ?? []) {
      const key = `epoch-${e.id}`;
      const open = expanded.has(key);
      rows.push({ type: 'item', key, item: { kind: 'epoch', id: e.id, name: e.name }, depth, open });
      if (!open) continue;
      const inside = epochTasks.get(e.id) ?? [];
      for (const t of inside) rows.push(task(t, depth + 1));
      if (!inside.length) rows.push({ type: 'empty', key: `empty-${e.id}`, depth: depth + 1 });
    }
    if (folderId !== null) for (const t of folderTasks.get(folderId) ?? []) rows.push(task(t, depth));
    for (const f of files.get(folderId) ?? []) rows.push({ type: 'item', key: `file-${f.id}`, item: { kind: 'file', id: f.id, name: f.name }, depth });
  };
  walk(null, 0);
  return rows;
}

/** The Inbox: tasks in no folder and no epoch. */
export function inboxRows(tree: Tree): TreeRow[] {
  return tree.tasks
    .filter((t) => t.folderId === null && t.epochId === null)
    .map((t): TreeRow => ({ type: 'item', key: `task-${t.id}`, item: { kind: 'task', id: t.id, name: t.title }, depth: 0 }));
}

export interface CopyCounts {
  folders: number;
  epochs: number;
  tasks: number;
  files: number;
  bytes: number;
  /** Sub-tasks in other epochs or folders: their copies go there, under the copied parent. */
  subtasksElsewhere: number;
}

/** "2 folders, 1 epoch, 37 tasks and 12 files". */
export function describeCounts(c: CopyCounts): string {
  return joinAnd(
    [
      c.folders && plural(c.folders, 'folder'),
      c.epochs && plural(c.epochs, 'epoch'),
      c.tasks && plural(c.tasks, 'task'),
      c.files && plural(c.files, 'file'),
    ].filter((s): s is string => !!s),
  );
}

/** A copy asks first when it makes tasks besides the items themselves (they show up on the board), or a lot. */
export function copyNeedsConfirm(c: CopyCounts, items = 1): boolean {
  const total = c.folders + c.epochs + c.tasks + c.files;
  return (c.tasks > 0 && total > items) || total > 20;
}

type Node = MenuNode<ActionId>;
const SEP: Node = { type: 'separator' };
const action = (id: ActionId, label: string, extra: Partial<Extract<Node, { type: 'action' }>> = {}): Node => ({ type: 'action', id, label, ...extra });

/** The menu for a row, several selected rows, the top level or the Inbox. */
export function explorerActions(target: Target, ctx: ActionContext): Node[] {
  const { tree, clip } = ctx;
  const pasteHere = pasteDestination(clip, target, tree)
    ? [action('paste', `Paste ${itemsName(clip!.items)}`, { shortcut: SHORTCUTS.paste })]
    : [];
  const fromTemplate = (label: string) => (ctx.hasTemplates ? [action('new-from-template', label, { icon: '▫' })] : []);
  const newMenu = (inFolder: boolean): Node => ({
    type: 'submenu',
    label: 'New',
    icon: '+',
    items: [
      action('new-folder', 'Folder…', { icon: ICONS.folder }),
      action('new-epoch', 'Epoch…', { icon: ICONS.epoch }),
      ...(inFolder ? [action('new-task', 'Task…', { icon: ICONS.task }), ...fromTemplate('Task from template…')] : []),
      action('new-doc', 'Markdown document…', { icon: '📝' }),
      action('upload', 'Upload files…', { icon: '⬆' }),
    ],
  });
  const clipboard = (canPaste: boolean): Node[] => [
    action('cut', 'Cut', { shortcut: SHORTCUTS.cut }),
    action('copy', 'Copy', { shortcut: SHORTCUTS.copy }),
    ...(canPaste ? pasteHere : []),
    action('duplicate', 'Duplicate'),
  ];
  const manage: Node[] = [
    action('move', 'Move to…'),
    action('rename', 'Rename…', { shortcut: SHORTCUTS.rename }),
    action('delete', 'Delete…', { danger: true, shortcut: SHORTCUTS.delete }),
  ];
  const toggle = action('toggle', ctx.expanded ? 'Collapse' : 'Expand');
  // Starts a selection with this row (the same as Ctrl+click), for anyone who doesn't know the shortcut.
  const select = action('select', ctx.selected ? 'Deselect' : 'Select', { icon: '☑', shortcut: SHORTCUTS.select });

  switch (target.kind) {
    case 'root':
      return [newMenu(false), ...(pasteHere.length ? [SEP, ...pasteHere] : [])];
    case 'inbox':
      return [action('new-task', 'New task…', { icon: ICONS.task }), ...fromTemplate('New task from template…'), ...(pasteHere.length ? [SEP, ...pasteHere] : [])];
    case 'selection':
      return [
        action('cut', 'Cut', { shortcut: SHORTCUTS.cut }),
        action('copy', 'Copy', { shortcut: SHORTCUTS.copy }),
        action('duplicate', 'Duplicate'),
        action('move', 'Move to…'),
        SEP,
        action('clear-selection', 'Clear selection', { shortcut: 'Esc' }),
        action('delete', `Delete ${target.items.length} items…`, { danger: true, shortcut: SHORTCUTS.delete }),
      ];
    case 'folder':
      return [newMenu(true), toggle, select, SEP, ...clipboard(true), SEP, ...manage];
    case 'epoch':
      return [
        action('open', 'Open'),
        action('new-task', 'New task in this epoch…', { icon: ICONS.task }),
        ...fromTemplate('New task from template…'),
        toggle,
        select,
        SEP,
        ...clipboard(true),
        SEP,
        ...manage,
      ];
    case 'task': {
      const t = tree.tasks.find((x) => x.id === target.id);
      // Sub-tasks can't have sub-tasks of their own.
      const subtask = t && t.parentId === null ? [action('add-subtask', 'Add sub-task…', { icon: ICONS.task })] : [];
      return [action('open', 'Open'), ...subtask, select, SEP, ...clipboard(false), SEP, ...manage];
    }
    case 'file': {
      const f = tree.files.find((x) => x.id === target.id);
      return [
        action('open', 'Open'),
        ...(f && isEditable(f) ? [action('edit', 'Edit')] : []),
        action('download', 'Download', { icon: '⬇' }),
        select,
        SEP,
        ...clipboard(false),
        SEP,
        ...manage,
      ];
    }
  }
}

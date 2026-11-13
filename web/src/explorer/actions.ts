import type { MenuNode } from '../components/ContextMenu';
import type { FileItem, Tree } from '../types';
import { joinAnd, plural } from '../util';

/**
 * What the Explorer offers for each kind of row: one list, shown as the right-click menu on a computer and
 * as the ⋯ sheet on a phone. Pure functions, so the rules (what can be pasted where) live in one place.
 */

export type Kind = 'folder' | 'epoch' | 'task' | 'file';
export interface Item {
  kind: Kind;
  id: number;
  name: string;
}
/** What a menu is for: a row, the top level of the tree ("Root"), or the Inbox of unfiled tasks. */
export type Target = Item | { kind: 'root' } | { kind: 'inbox' };
/** Where something goes: a folder (null: the top level; for tasks, the Inbox), or for tasks an epoch. */
export type Dest = { folderId: number | null } | { epochId: number };
/** The Explorer's own clipboard: one item, to move (cut) or copy. */
export interface Clip {
  mode: 'cut' | 'copy';
  item: Item;
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
};
/** Whether a key press is the Delete shortcut: Delete, or ⌘⌫ on a Mac (which has no Delete key). */
export const isDeleteKey = (e: { key: string; metaKey: boolean }) => e.key === 'Delete' || (isMac && e.metaKey && e.key === 'Backspace');

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

/** Where an item is now: Duplicate makes its copy there. */
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

/**
 * Where the clipboard's item lands if pasted on `target`, or null where it can't go: anything into a folder
 * (but a folder not into itself or a folder inside it), folders, epochs and files at the top level, tasks
 * into an epoch or the Inbox.
 */
export function pasteDestination(clip: Clip | null, target: Target, tree: Tree): Dest | null {
  if (!clip) return null;
  const kind = clip.item.kind;
  switch (target.kind) {
    case 'folder':
      return kind === 'folder' && isWithin(tree, target.id, clip.item.id) ? null : { folderId: target.id };
    case 'root':
      return kind === 'task' ? null : { folderId: null };
    case 'epoch':
      return kind === 'task' ? { epochId: target.id } : null;
    case 'inbox':
      return kind === 'task' ? { folderId: null } : null;
    default:
      return null;
  }
}

/** Why the clipboard's item can't go on `target`, for the keyboard shortcut (the menu just leaves Paste out). */
export function pasteRefusal(clip: Clip, target: Target): string {
  if (clip.item.kind === 'folder' && target.kind === 'folder') return "A folder can't go inside itself or a folder inside it";
  if (target.kind === 'epoch' || target.kind === 'inbox') return target.kind === 'epoch' ? 'Only tasks can go inside an epoch' : 'Only tasks go in the Inbox';
  if (clip.item.kind === 'task') return 'Tasks go in a folder, an epoch or the Inbox';
  return `“${clip.item.name}” can't go there`;
}

/** "the top level", "the Inbox", "“Art”". */
export function destName(tree: Tree, dest: Dest, kind: Kind): string {
  if ('epochId' in dest) return `“${tree.epochs.find((e) => e.id === dest.epochId)?.name ?? 'the epoch'}”`;
  if (dest.folderId === null) return kind === 'task' ? 'the Inbox' : 'the top level';
  return `“${tree.folders.find((f) => f.id === dest.folderId)?.name ?? 'the folder'}”`;
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

/** A copy asks first when it makes tasks besides the item itself (they show up on the board), or a lot. */
export function copyNeedsConfirm(c: CopyCounts): boolean {
  const total = c.folders + c.epochs + c.tasks + c.files;
  return (c.tasks > 0 && total > 1) || total > 20;
}

type Node = MenuNode<ActionId>;
const SEP: Node = { type: 'separator' };
const action = (id: ActionId, label: string, extra: Partial<Extract<Node, { type: 'action' }>> = {}): Node => ({ type: 'action', id, label, ...extra });

/** The menu for a row, the top level or the Inbox. */
export function explorerActions(target: Target, ctx: ActionContext): Node[] {
  const { tree, clip } = ctx;
  const pasteHere = pasteDestination(clip, target, tree)
    ? [action('paste', `Paste “${clip!.item.name}”`, { shortcut: SHORTCUTS.paste })]
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

  switch (target.kind) {
    case 'root':
      return [newMenu(false), ...(pasteHere.length ? [SEP, ...pasteHere] : [])];
    case 'inbox':
      return [action('new-task', 'New task…', { icon: ICONS.task }), ...fromTemplate('New task from template…'), ...(pasteHere.length ? [SEP, ...pasteHere] : [])];
    case 'folder':
      return [newMenu(true), toggle, SEP, ...clipboard(true), SEP, ...manage];
    case 'epoch':
      return [
        action('open', 'Open'),
        action('new-task', 'New task in this epoch…', { icon: ICONS.task }),
        ...fromTemplate('New task from template…'),
        toggle,
        SEP,
        ...clipboard(true),
        SEP,
        ...manage,
      ];
    case 'task': {
      const t = tree.tasks.find((x) => x.id === target.id);
      // Sub-tasks can't have sub-tasks of their own.
      const subtask = t && t.parentId === null ? [action('add-subtask', 'Add sub-task…', { icon: ICONS.task })] : [];
      return [action('open', 'Open'), ...subtask, SEP, ...clipboard(false), SEP, ...manage];
    }
    case 'file': {
      const f = tree.files.find((x) => x.id === target.id);
      return [
        action('open', 'Open'),
        ...(f && isEditable(f) ? [action('edit', 'Edit')] : []),
        action('download', 'Download', { icon: '⬇' }),
        SEP,
        ...clipboard(false),
        SEP,
        ...manage,
      ];
    }
  }
}

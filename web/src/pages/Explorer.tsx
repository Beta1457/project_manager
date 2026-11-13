import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { api, V1 } from '../api';
import { useColors, useEpochs, useTemplates, useTree } from '../hooks';
import { useMutate } from '../mutate';
import type { FileItem, Tree } from '../types';
import { cx, errorMessage, formatBytes, formatMinutes, joinAnd, plural } from '../util';
import { Markdown, Spinner } from '../components/Bits';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { folderPath } from '../components/Filters';
import { PageHeader, useTaskParam } from '../components/Layout';
import { QuickAdd } from '../components/QuickAdd';
import { askConfirm, type ConfirmOptions } from '../components/Confirm';
import { ActionSheet, ContextMenu, type MenuPosition } from '../components/ContextMenu';
import { Sheet, isSheetOpen } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { useProject } from '../projectContext';
import { useSelection, type Selection } from '../selection';
import { EpochForm, epochDeleteQuestion } from './Epochs';
import {
  ICONS,
  SHORTCUTS,
  containerOf,
  copyNeedsConfirm,
  describeCounts,
  describeKinds,
  destName,
  destNameFor,
  explorerActions,
  findItem,
  flattenTree,
  inboxRows,
  isDeleteKey,
  itemsName,
  keyOf,
  moveRefusal,
  pasteDestination,
  pasteRefusal,
  placeOf,
  type ActionId,
  type Clip,
  type CopyCounts,
  type Dest,
  type Item,
  type Kind,
  type Target,
  type TreeRow,
} from '../explorer/actions';

const EXP_KEY = 'pm.explorer.expanded';
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXP_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

// The clipboard lasts as long as the tab, one per project. It is the app's own, not the system clipboard,
// which browsers only offer over HTTPS (this app is usually opened over plain HTTP on the home network).
const KINDS: Kind[] = ['folder', 'epoch', 'task', 'file'];
const clipKey = (projectId: number) => `pm.explorer.clip.${projectId}`;
const isItemRef = (v: unknown): v is Item => {
  const i = v as Partial<Item> | null;
  return !!i && KINDS.includes(i.kind as Kind) && Number.isInteger(i.id);
};
function loadClip(projectId: number): Clip | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(clipKey(projectId)) ?? 'null') as { mode?: unknown; items?: unknown; item?: unknown } | null;
    if (!v || (v.mode !== 'cut' && v.mode !== 'copy')) return null;
    // Before several items could be cut or copied at once, the clipboard held { mode, item }.
    const items: unknown[] = Array.isArray(v.items) ? v.items : v.item ? [v.item] : [];
    return items.length && items.every(isItemRef) ? { mode: v.mode, items } : null;
  } catch {
    return null;
  }
}
function storeClip(projectId: number, clip: Clip | null) {
  try {
    if (clip) sessionStorage.setItem(clipKey(projectId), JSON.stringify(clip));
    else sessionStorage.removeItem(clipKey(projectId));
  } catch {
    /* storage unavailable: the clipboard still works until the page reloads */
  }
}

const ALL_KINDS = ['folders', 'epochs', 'tasks', 'files'];
/** What the server needs to know about items: which ones. */
const refs = (items: Item[]) => items.map(({ kind, id }) => ({ kind, id }));
const noop = () => {};

interface MenuState {
  id: number;
  target: Target;
  at: MenuPosition;
  returnFocus: HTMLElement | null;
  toggleFrom?: HTMLElement;
  /** Opened from the keyboard. */
  focusFirst: boolean;
}

interface NewTask {
  epochId?: number | null;
  folderId?: number | null;
  parentId?: number;
  parentLabel?: string;
  chooseTemplate?: boolean;
}

/** What rows hand up to the page: clicks (open, or select), the menus (right-click, ⋯, menu key) and shortcuts. */
interface RowEvents {
  click: (e: MouseEvent<HTMLElement>, item: Item) => void;
  /** The row's checkbox; `range` with Shift. */
  check: (item: Item, range: boolean) => void;
  open: (item: Item) => void;
  context: (e: MouseEvent<HTMLElement>, target: Target, row: HTMLElement | null) => void;
  more: (e: MouseEvent<HTMLButtonElement>, target: Target) => void;
  keys: (e: KeyboardEvent<HTMLElement>, target: Target) => void;
}

/**
 * After rows are deleted, the focus would fall back to the page: give it to a row that was next to them
 * instead, once the deleted row has left the screen, so the keyboard keeps its place. (Timers rather than
 * animation frames, which stop while the tab is in the background.)
 */
function refocusAfterRemoval(removed: string, candidates: string[]) {
  const row = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);
  const until = Date.now() + 3000;
  const check = () => {
    if (row(removed)) {
      if (Date.now() < until) setTimeout(check, 50);
      return;
    }
    if (document.activeElement && document.activeElement !== document.body) return;
    for (const key of candidates) {
      const el = row(key);
      if (el) return el.focus({ preventScroll: true });
    }
  };
  check();
}

/** The rows next to the ones about to be deleted, nearest first: after them, then before them. */
function neighboursOf(removed: Set<string>): string[] {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')].map((el) => el.dataset.row ?? '');
  const at = rows.map((k, i) => (removed.has(k) ? i : -1)).filter((i) => i >= 0);
  if (!at.length) return [];
  const after = rows.slice(Math.max(...at) + 1).filter((k) => !removed.has(k));
  const before = rows.slice(0, Math.min(...at)).filter((k) => !removed.has(k)).reverse();
  return [...after, ...before];
}

const labelOf = (target: Target) =>
  target.kind === 'root' ? 'the top level'
  : target.kind === 'inbox' ? 'the Inbox'
  : target.kind === 'selection' ? `${target.items.length} selected items`
  : `“${target.name}”`;

export function ExplorerPage() {
  const { data: tree, isLoading } = useTree();
  const { project } = useProject();
  const templates = useTemplates().data ?? [];
  const epochs = useEpochs().data;
  const colors = useColors();
  const mutate = useMutate();
  const toast = useToast();
  const navigate = useNavigate();
  const [, openTask] = useTaskParam();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  /** What a drag carries: the row picked up, and the selection with it when that row is part of it. */
  const [dragging, setDragging] = useState<{ lead: Item; items: Item[] } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sheetFor, setSheetFor] = useState<Target | null>(null);
  const [moving, setMoving] = useState<Item[] | null>(null);
  const [preview, setPreview] = useState<{ file: FileItem; edit: boolean; hash?: string } | null>(null);
  const [newTask, setNewTask] = useState<NewTask | null>(null);
  const [newEpochIn, setNewEpochIn] = useState<{ folderId: number | null } | null>(null);
  const [savedClip, setSavedClip] = useState<Clip | null>(() => loadClip(project.id));
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<number | null>(null);
  const menuSeq = useRef(0);
  const lastPointer = useRef('mouse');
  const menuKeyAt = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(EXP_KEY, JSON.stringify([...expanded]));
    } catch {
      /* storage unavailable */
    }
  }, [expanded]);

  // Touch or mouse decides between the ⋯ sheet and the floating menu.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      lastPointer.current = e.pointerType;
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, []);

  // The rows as shown, and the selection over them (in that order: Shift picks a range as you see it).
  const rows = useMemo(() => (tree ? flattenTree(tree, expanded) : []), [tree, expanded]);
  const inbox = useMemo(() => (tree ? inboxRows(tree) : []), [tree]);
  const itemRows = useMemo(() => [...rows, ...inbox].filter((r): r is Extract<TreeRow, { type: 'item' }> => r.type === 'item'), [rows, inbox]);
  const orderedKeys = useMemo(() => itemRows.map((r) => r.key), [itemRows]);
  const itemByKey = useMemo(() => new Map(itemRows.map((r) => [r.key, r.item])), [itemRows]);
  const selection = useSelection(orderedKeys);
  const selected = useMemo(() => selection.ids.flatMap((k) => itemByKey.get(k) ?? []), [selection.ids, itemByKey]);
  const draggingKeys = useMemo(() => (dragging ? new Set(dragging.items.map(keyOf)) : null), [dragging]);
  const lookups = useMemo(
    () =>
      tree && {
        epochs: new Map(tree.epochs.map((e) => [e.id, e])),
        tasks: new Map(tree.tasks.map((t) => [t.id, t])),
        files: new Map(tree.files.map((f) => [f.id, f])),
      },
    [tree],
  );

  const setClip = useCallback(
    (next: Clip | null) => {
      setSavedClip(next);
      storeClip(project.id, next);
    },
    [project.id],
  );
  // The clipboard's items as they are now (renamed since?); the deleted ones drop out.
  const clip = useMemo(() => {
    if (!savedClip || !tree) return null;
    const items = savedClip.items.flatMap((i) => findItem(tree, i) ?? []);
    return items.length ? { mode: savedClip.mode, items } : null;
  }, [savedClip, tree]);
  useEffect(() => {
    if (tree && savedClip && !clip) setClip(null);
  }, [tree, savedClip, clip, setClip]);

  // Esc empties the clipboard, once nothing is selected (menus, dialogs and the selection use Esc first).
  useEffect(() => {
    if (!clip) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isSheetOpen() || selection.active) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      setClip(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clip, setClip, selection.active]);

  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const expand = (key: string) => setExpanded((s) => (s.has(key) ? s : new Set(s).add(key)));
  const expandDest = (dest: Dest) => {
    if ('epochId' in dest) expand(`epoch-${dest.epochId}`);
    else if (dest.folderId !== null) expand(`folder-${dest.folderId}`);
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  /** Moves an item to a folder (null = root) or, for tasks, into an epoch. Resolves to undefined if it didn't. */
  const moveItem = async (item: Item, dest: Dest) => {
    if ('epochId' in dest) {
      if (item.kind !== 'task') return toast('Only tasks can go inside an epoch', 'error');
      return mutate(() => api.patch(`${V1}/tasks/${item.id}`, { epochId: dest.epochId }), ALL_KINDS);
    }
    const f = dest.folderId;
    switch (item.kind) {
      case 'folder':
        if (f === item.id) return;
        return mutate(() => api.patch(`${V1}/folders/${item.id}`, { parentId: f }), ALL_KINDS);
      case 'epoch':
        return mutate(() => api.patch(`${V1}/epochs/${item.id}`, { folderId: f }), ALL_KINDS);
      case 'task':
        return mutate(() => api.patch(`${V1}/tasks/${item.id}`, { folderId: f }), ALL_KINDS);
      case 'file':
        return mutate(() => api.patch(`${V1}/files/${item.id}`, { folderId: f }), ALL_KINDS);
    }
  };

  const upload = async (files: FileList | null, folderId: number | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    if (folderId !== null) fd.append('folderId', String(folderId));
    for (const f of Array.from(files)) fd.append('file', f, f.name);
    await mutate(() => api.post(`${V1}/files`, fd), ['files'], `Uploaded ${files.length} file(s)`);
    if (folderId !== null) expand(`folder-${folderId}`);
  };

  const createDoc = async (folderId: number | null) => {
    const name = window.prompt('Document name', 'Notes.md');
    if (!name?.trim()) return;
    try {
      const file = await api.post<FileItem>(`${V1}/docs`, { name: name.trim(), folderId, content: '' });
      if (folderId !== null) expand(`folder-${folderId}`);
      setPreview({ file, edit: true });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const createFolder = async (parentId: number | null) => {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    await mutate(() => api.post(`${V1}/folders`, { name: name.trim(), parentId }), ['folders']);
    if (parentId !== null) expand(`folder-${parentId}`);
  };

  if (isLoading || !tree || !lookups) return <><PageHeader title="Explorer" /><Spinner /></>;

  /** Moves several items in one request, all or nothing. Opens the destination first, so they stay in view (and selected). */
  const moveItems = async (items: Item[], dest: Dest) => {
    const refusal = moveRefusal(items, dest, tree);
    if (refusal) {
      toast(refusal, 'error');
      return undefined;
    }
    expandDest(dest);
    return mutate(
      () => api.post<{ moved: number }>(`${V1}/explorer/move`, { items: refs(items), to: dest }),
      ALL_KINDS,
      `Moved ${itemsName(items)} to ${destNameFor(tree, dest, items)}`,
    );
  };

  /** A selected row carries the whole selection along; any other row goes alone. */
  const dragGroup = (lead: Item) => ({ lead, items: selected.length > 1 && selection.has(keyOf(lead)) ? selected : [lead] });
  const onDragStart = (e: DragStartEvent) => {
    const item = e.active.data.current?.item as Item | undefined;
    if (item) setDragging(dragGroup(item));
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const item = e.active.data.current?.item as Item | undefined;
    const over = e.over?.id ? String(e.over.id) : null;
    if (!item || !over) return;
    const group = dragGroup(item);
    let dest: Dest;
    if (over === 'drop-root') dest = { folderId: null };
    else if (over.startsWith('drop-folder-')) dest = { folderId: Number(over.slice(12)) };
    else if (over.startsWith('drop-epoch-')) dest = { epochId: Number(over.slice(11)) };
    else return;
    // Dropped back on one of the rows being dragged: nothing to do.
    const onto = 'epochId' in dest ? `epoch-${dest.epochId}` : dest.folderId !== null ? `folder-${dest.folderId}` : null;
    if (onto && group.items.some((i) => keyOf(i) === onto)) return;
    if (group.items.length > 1) return void moveItems(group.items, dest);
    void moveItem(group.items[0], dest);
    if (!('epochId' in dest) && dest.folderId !== null) expand(`folder-${dest.folderId}`);
  };

  const open = (item: Item) => {
    if (item.kind === 'task') openTask(item.id);
    else if (item.kind === 'epoch') navigate(`/epochs/${item.id}`);
    else if (item.kind === 'file') {
      const file = tree.files.find((f) => f.id === item.id);
      setPreview(file ? { file, edit: false } : null);
    }
    else toggle(`folder-${item.id}`);
  };

  const urlOf = (i: Item) => (i.kind === 'folder' ? `folders/${i.id}` : i.kind === 'epoch' ? `epochs/${i.id}` : i.kind === 'file' ? `files/${i.id}` : `tasks/${i.id}`);
  const rename = async (i: Item) => {
    const name = window.prompt('New name', i.name);
    if (!name?.trim() || name === i.name) return;
    await mutate(() => api.patch(`${V1}/${urlOf(i)}`, i.kind === 'task' ? { title: name.trim() } : { name: name.trim() }), ALL_KINDS);
  };
  /** Where a folder's or epoch's contents go when it is deleted. */
  const parentName = (folderId: number | null) => {
    const f = folderId === null ? undefined : tree.folders.find((x) => x.id === folderId);
    return f ? `"${f.name}"` : 'the top level';
  };
  const remove = async (i: Item) => {
    let question: ConfirmOptions;
    let url = urlOf(i);
    if (i.kind === 'folder') {
      const parentId = tree.folders.find((f) => f.id === i.id)?.parentId ?? null;
      const others = [
        plural(tree.folders.filter((f) => f.parentId === i.id).length, 'folder'),
        plural(tree.epochs.filter((e) => e.folderId === i.id).length, 'epoch'),
        plural(tree.files.filter((f) => f.folderId === i.id).length, 'file'),
      ].filter((s) => !s.startsWith('0 '));
      const taskCount = tree.tasks.filter((t) => t.folderId === i.id && t.epochId === null).length;
      const tasks = taskCount ? [plural(taskCount, 'task')] : [];
      // "its 1 epoch moves", "its 2 epochs move", "its folder and epoch move".
      const its = (items: string[], one: string, many: string) => `its ${joinAnd(items)} ${items.length === 1 && items[0].startsWith('1 ') ? one : many}`;
      // Everything moves up to the parent folder. At the top level, tasks become unfiled (the Inbox).
      const moves: string[] = [];
      if (parentId !== null) {
        const all = [...others, ...tasks];
        if (all.length) moves.push(`${its(all, 'moves', 'move')} up to ${parentName(parentId)}`);
      } else {
        if (others.length) moves.push(`${its(others, 'moves', 'move')} up to the top level`);
        if (tasks.length) moves.push(`${its(tasks, 'goes', 'go')} to the Inbox (unfiled tasks)`);
      }
      question = {
        title: 'Delete folder?',
        body: `"${i.name}" will be deleted. ` + (moves.length ? `Nothing inside it is deleted: ${moves.join(', and ')}.` : 'It is empty.'),
        confirmLabel: 'Delete folder',
      };
    } else if (i.kind === 'epoch') {
      // The epochs list knows how much time was logged directly on the epoch; the tree's copy doesn't.
      const e = epochs?.find((x) => x.id === i.id) ?? tree.epochs.find((x) => x.id === i.id);
      question = epochDeleteQuestion(e ?? { name: i.name, total: 0, folderId: null }, tree.folders);
      url += '?deleteTime=true'; // the question says so; without it the server refuses when such time exists
    } else if (i.kind === 'task') {
      const t = tree.tasks.find((x) => x.id === i.id);
      question = {
        title: `Delete ${t?.key ?? 'task'}?`,
        body: `"${i.name}" will be deleted, along with its checklist, comments, links and logged time. This can't be undone.`,
        confirmLabel: 'Delete task',
      };
    } else {
      question = { title: 'Delete file?', body: `"${i.name}" will be deleted. This can't be undone.`, confirmLabel: 'Delete file' };
    }
    if (!(await askConfirm(question))) return;
    const key = keyOf(i);
    const neighbours = neighboursOf(new Set([key]));
    if ((await mutate(() => api.del(`${V1}/${url}`), ALL_KINDS)) !== undefined) refocusAfterRemoval(key, neighbours);
  };

  /** Deletes several items in one request, all or nothing, after one question that says what goes and what stays. */
  const removeItems = async (items: Item[]) => {
    if (items.length === 1) return remove(items[0]);
    const n = items.length;
    const count = (k: Kind) => items.filter((i) => i.kind === k).length;
    const picked = new Set(items.map(keyOf));
    // Sub-tasks of the tasks picked that aren't picked themselves.
    const subtasks = tree.tasks.filter((t) => t.parentId !== null && picked.has(`task-${t.parentId}`) && !picked.has(`task-${t.id}`)).length;
    // The epochs list knows how much time was logged directly on each epoch; the tree doesn't.
    const picks = items.filter((i) => i.kind === 'epoch').map((i) => epochs?.find((e) => e.id === i.id));
    const direct = picks.every(Boolean) ? picks.reduce((sum, e) => sum + (e?.loggedDirectMinutes ?? 0), 0) : null;
    const [tasks, files, folders, epochCount] = [count('task'), count('file'), count('folder'), count('epoch')];
    const gone =
      tasks && files ? 'The tasks and files are deleted for good, the tasks with their checklists, comments, links and logged time.'
      : tasks ? `${tasks === 1 ? 'The task is' : 'The tasks are'} deleted for good, with ${tasks === 1 ? 'its' : 'their'} checklist${tasks === 1 ? '' : 's'}, comments, links and logged time.`
      : files ? `${files === 1 ? 'The file is' : 'The files are'} deleted for good.`
      : '';
    const body = (
      <>
        <p>These {n} items will be deleted: {describeKinds(items)}.</p>
        <ul className="confirm-list">
          {items.slice(0, 10).map((i) => (
            <li key={keyOf(i)}>
              {ICONS[i.kind]} {i.name}
            </li>
          ))}
          {n > 10 && <li className="muted">and {n - 10} more</li>}
        </ul>
        {gone && <p>{gone} This can't be undone.</p>}
        {folders > 0 && (
          <p>
            {folders === 1
              ? 'Anything else in the folder is kept and moves up to the folder it is in (at the top level, its tasks go to the Inbox).'
              : 'Anything else in the folders is kept and moves up to the folder each one is in (at the top level, their tasks go to the Inbox).'}
          </p>
        )}
        {epochCount > 0 && (
          <p>
            {epochCount === 1
              ? "The epoch's other tasks and their logged time are kept and move to the folder the epoch is in (at the top level, to the Inbox)."
              : "The epochs' other tasks and their logged time are kept and move to the folder each epoch is in (at the top level, to the Inbox)."}{' '}
            {direct === null
              ? `Any time logged directly on the ${epochCount === 1 ? 'epoch is deleted with it' : 'epochs is deleted with them'}.`
              : direct > 0 &&
                `The ${formatMinutes(direct)} logged directly on the ${epochCount === 1 ? 'epoch is deleted with it' : 'epochs is deleted with them'}.`}
          </p>
        )}
        {subtasks > 0 && <p>{plural(subtasks, 'sub-task')} of these tasks will stay, as top-level tasks, unless you tick the box.</p>}
      </>
    );
    const options: ConfirmOptions = {
      title: `Delete ${n} items?`,
      body,
      confirmLabel: `Delete ${n} items`,
      // Many tasks at once (as on the board): make sure it isn't a slip.
      typeToConfirm: tasks > 10 ? 'delete' : undefined,
    };
    let withSubtasks = false;
    if (subtasks > 0) {
      const answer = await askConfirm({ ...options, checkbox: `Also delete their ${plural(subtasks, 'sub-task')}` });
      if (!answer.ok) return;
      withSubtasks = answer.checked;
    } else if (!(await askConfirm(options))) return;
    const neighbours = neighboursOf(picked);
    // deleteTime: the question said what happens to time logged directly on the epochs.
    const done = await mutate(
      () => api.post(`${V1}/explorer/delete`, { items: refs(items), withSubtasks, deleteTime: true }),
      ALL_KINDS,
      `Deleted ${n} items`,
    );
    if (done !== undefined) refocusAfterRemoval(keyOf(items[0]), neighbours);
  };

  /**
   * Copy and Duplicate (`dest` null: each copy next to its original). Asks the server what the copy would make
   * first, and asks before making a lot.
   */
  const copyItems = async (items: Item[], dest: Dest | null, verb: 'Copy' | 'Duplicate') => {
    const one = items.length === 1 ? items[0] : null;
    const where = dest ? destNameFor(tree, dest, items) : one ? destName(tree, placeOf(tree, one), one.kind) : '';
    const at = where ? `in ${where}` : 'next to the originals';
    const body = { items: refs(items), to: dest ?? { inPlace: true } };
    let counts: CopyCounts;
    try {
      counts = await api.post<CopyCounts>(`${V1}/copy`, { ...body, dryRun: true });
    } catch (err) {
      toast(errorMessage(err), 'error');
      return;
    }
    if (copyNeedsConfirm(counts, items.length)) {
      const n = counts.subtasksElsewhere;
      const parents = one?.kind === 'task' ? 'the copy' : 'the copies';
      const except = !n
        ? ''
        : n === 1
          ? `, except one sub-task, which goes where its original is (as a sub-task of ${parents})`
          : `, except ${n} sub-tasks, which go where their originals are (as sub-tasks of ${parents})`;
      const ok = await askConfirm({
        title: `${verb} ${itemsName(items)}?`,
        body:
          `This makes ${describeCounts(counts)}${counts.bytes ? ` (${formatBytes(counts.bytes)} of files)` : ''} ${at}${except}.` +
          (counts.tasks ? ' The new tasks start in Open with their checklists unticked; logged time, comments and links stay with the originals.' : ''),
        confirmLabel: verb,
        danger: false,
      });
      if (!ok) return;
    }
    if (dest) expandDest(dest);
    const made = await mutate(() => api.post<CopyCounts & { items: Item[] }>(`${V1}/copy`, body), ALL_KINDS);
    if (!made) return;
    if (one) {
      const copy = made.items[0];
      const renamed = copy && copy.name !== one.name ? ` as “${copy.name}”` : '';
      toast(verb === 'Copy' ? `Copied “${one.name}” to ${where}${renamed}` : `Duplicated “${one.name}”${renamed}`);
    } else toast(verb === 'Copy' ? `Copied ${items.length} items to ${where}` : `Duplicated ${items.length} items`);
  };

  const paste = async (target: Target, fromKeyboard: boolean) => {
    if (!clip) {
      if (fromKeyboard) toast('Nothing to paste yet: cut or copy something first');
      return;
    }
    let place: Target = target;
    let dest = pasteDestination(clip, place, tree);
    // Ctrl+V on a task or a file pastes next to it.
    if (!dest && fromKeyboard && (target.kind === 'task' || target.kind === 'file')) {
      place = containerOf(tree, target);
      dest = pasteDestination(clip, place, tree);
    }
    if (!dest) return toast(pasteRefusal(clip, place), 'error');
    if (clip.mode === 'copy') return copyItems(clip.items, dest, 'Copy');
    if (clip.items.length > 1) {
      if ((await moveItems(clip.items, dest)) !== undefined) setClip(null);
      return;
    }
    const [item] = clip.items;
    if ((await moveItem(item, dest)) === undefined) return;
    setClip(null);
    expandDest(dest);
    toast(`Moved “${item.name}” to ${destName(tree, dest, item.kind)}`);
  };

  /** Runs a menu entry, a shortcut or a button of the selection bar. */
  const run = (id: ActionId, target: Target, fromKeyboard = false) => {
    const folderId = target.kind === 'folder' ? target.id : null;
    switch (id) {
      case 'new-folder':
        return void createFolder(folderId);
      case 'new-epoch':
        return setNewEpochIn({ folderId });
      case 'new-task':
      case 'new-from-template':
        return setNewTask({ ...(target.kind === 'epoch' ? { epochId: target.id } : { folderId }), chooseTemplate: id === 'new-from-template' });
      case 'new-doc':
        return void createDoc(folderId);
      case 'upload':
        // Straight away: browsers only open the file picker during the click or key press.
        setUploadTarget(folderId);
        uploadRef.current?.click();
        return;
      case 'paste':
        return void paste(target, fromKeyboard);
    }
    if (target.kind === 'root' || target.kind === 'inbox') return;
    // One row, or every selected row.
    const items = target.kind === 'selection' ? target.items : [target];
    switch (id) {
      case 'cut':
      case 'copy':
        return setClip({ mode: id, items });
      case 'duplicate':
        return void copyItems(items, null, 'Duplicate');
      case 'move':
        return setMoving(items);
      case 'delete':
        return void removeItems(items);
      case 'clear-selection':
        return selection.clear();
    }
    if (target.kind === 'selection') return;
    const item = target;
    switch (id) {
      case 'open':
        return open(item);
      case 'toggle':
        return toggle(keyOf(item));
      case 'select':
        return selection.toggle(keyOf(item));
      case 'add-subtask': {
        const t = tree.tasks.find((x) => x.id === item.id);
        if (t) setNewTask({ parentId: t.id, parentLabel: `${t.key} “${t.title}”`, epochId: t.epochId, folderId: t.epochId ? null : t.folderId });
        return;
      }
      case 'edit': {
        const file = tree.files.find((f) => f.id === item.id);
        if (file) setPreview({ file, edit: true });
        return;
      }
      case 'download':
        return window.location.assign(`/api/v1/files/${item.id}/content?download=1`);
      case 'rename':
        return void rename(item);
    }
  };

  /** A row that is one of several selected stands for all of them: menus and shortcuts act on the selection. */
  const forSelection = (target: Target): Target =>
    target.kind !== 'root' && target.kind !== 'inbox' && target.kind !== 'selection' && selected.length > 1 && selection.has(keyOf(target))
      ? { kind: 'selection', items: selected }
      : target;

  /** A floating menu, or the sheet when the last tap was a finger. */
  const showActions = (target: Target, at: MenuPosition, returnFocus: HTMLElement | null, viaPointer: boolean, toggleFrom?: HTMLElement) => {
    if (viaPointer && lastPointer.current === 'touch') return setSheetFor(target);
    if (toggleFrom && menu?.toggleFrom === toggleFrom) return setMenu(null);
    setMenu({ id: ++menuSeq.current, target, at, returnFocus, toggleFrom, focusFirst: !viaPointer });
  };

  const events: RowEvents = {
    click: (e, item) => {
      // Select mode, Ctrl/⌘+click and Shift+click pick rows; a plain click opens.
      if (selection.mode || e.ctrlKey || e.metaKey || e.shiftKey) return selection.toggle(keyOf(item), e.shiftKey);
      open(item);
    },
    check: (item, range) => selection.toggle(keyOf(item), range),
    open,
    context: (e, target, row) => {
      if (e.shiftKey) return; // Shift+right-click: the browser's own menu
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - menuKeyAt.current < 600) return; // the menu key's own event, after the key opened ours
      row?.focus({ preventScroll: true });
      showActions(forSelection(target), { x: e.clientX, y: e.clientY }, row, true);
    },
    more: (e, target) => {
      e.stopPropagation();
      const button = e.currentTarget;
      // detail is 0 for a press of Enter or Space, which is never a finger.
      showActions(forSelection(target), { anchor: button, align: 'end' }, button, e.detail !== 0, button);
    },
    keys: (e, target) => {
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      const letter = e.key.toLowerCase();
      let id: ActionId | 'menu' | null = null;
      if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') id = 'menu';
      else if (mod && letter === 'v') id = 'paste';
      else if (target.kind !== 'root' && target.kind !== 'inbox') {
        if (e.key === 'F2') id = 'rename';
        else if (isDeleteKey(e)) id = 'delete';
        else if (mod && (letter === 'c' || letter === 'x')) {
          if (window.getSelection()?.toString()) return; // selected text copies as text
          id = letter === 'c' ? 'copy' : 'cut';
        }
      }
      if (!id) return;
      e.preventDefault();
      if (id === 'menu') {
        const row = e.currentTarget;
        menuKeyAt.current = Date.now();
        showActions(forSelection(target), { anchor: row.querySelector<HTMLElement>('.name') ?? row, align: 'start' }, row, false);
      } else if (id === 'paste' || id === 'rename') run(id, target, true);
      else run(id, forSelection(target), true);
    },
  };

  const actionsFor = (target: Target) =>
    explorerActions(target, {
      tree,
      clip,
      expanded: (target.kind === 'folder' || target.kind === 'epoch') && expanded.has(keyOf(target)),
      selected: target.kind !== 'root' && target.kind !== 'inbox' && target.kind !== 'selection' && selection.has(keyOf(target)),
      hasTemplates: templates.length > 0,
    });
  const isCut = (item: Item) => clip?.mode === 'cut' && clip.items.some((i) => i.kind === item.kind && i.id === item.id);

  const renderRow = (row: TreeRow) => {
    if (row.type === 'empty') {
      return <div key={row.key} className="tree-empty tiny muted" style={{ paddingLeft: row.depth * 18 + 40 }}>No tasks</div>;
    }
    const { item, depth, key } = row;
    const props = { item, depth, events, dragging: draggingKeys, cut: isCut(item), selected: selection.has(key) };
    switch (item.kind) {
      case 'folder':
        return <Row key={key} {...props} twisty={row.open ? '▾' : '▸'} onTwisty={() => toggle(key)} droppableId={`drop-folder-${item.id}`} />;
      case 'epoch': {
        const e = lookups.epochs.get(item.id);
        return (
          <Row key={key} {...props} twisty={row.open ? '▾' : '▸'} onTwisty={() => toggle(key)} droppableId={`drop-epoch-${item.id}`}
            icon={<span style={{ color: e?.color }}>◆</span>} extra={<span className="tiny muted">{e?.shipped}/{e?.total}</span>} />
        );
      }
      case 'task': {
        const t = lookups.tasks.get(item.id);
        return (
          <Row key={key} {...props} icon={<span className="dot" style={{ background: t ? colors.status(t.status) : undefined }} />}
            extra={<span className="key">{t?.key}</span>} />
        );
      }
      case 'file': {
        const f = lookups.files.get(item.id);
        return <Row key={key} {...props} extra={<span className="tiny muted">{f ? formatBytes(f.size) : ''}</span>} />;
      }
    }
  };

  /** Right-click on the empty part of the tree (rows handle their own). */
  const areaMenu = (target: Target) => (e: MouseEvent<HTMLElement>) => events.context(e, target, null);
  const pasteWhere = clip?.items.every((i) => i.kind === 'task') ? 'a folder, an epoch or the Inbox' : 'a folder or Root';
  const clipLabel = clip && (clip.items.length === 1 ? `${ICONS[clip.items[0].kind]} ${clip.items[0].name}` : `${clip.items.length} items (${describeKinds(clip.items)})`);

  return (
    <>
      <PageHeader title="Explorer">
        <button type="button" className={cx('btn btn-sm select-toggle', selection.mode && 'on')} aria-pressed={selection.mode}
          title={`Pick several items, to move, copy or delete them at once (or ${SHORTCUTS.select} them)`}
          onClick={() => (selection.mode ? selection.clear() : selection.setMode(true))}>
          Select
        </button>
        <button className="btn btn-sm" aria-haspopup="menu" onClick={(e) => events.more(e, { kind: 'root' })}>+ New</button>
      </PageHeader>
      <div className="content flush">
        {/* "selecting" also shows the rows' checkboxes on phones (on desktop they always show). */}
        <div className={cx('explorer-scroll', selection.active && 'selecting')}>
          <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
            <div className="stack">
              <p className="small muted" style={{ margin: 0 }}>
                <span className="hide-mobile">Right-click an item, or use its <b>⋯</b>,</span>
                <span className="hide-desktop">Tap the <b>⋯</b> on an item</span> to add, cut, copy, paste, duplicate, rename or delete. Drag the{' '}
                <b>⠿</b> handle to move it onto a folder, an epoch (tasks only) or “Root”.{' '}
                <span className="hide-mobile">Tick the boxes (or <b>{SHORTCUTS.select}</b> / <b>Shift+click</b> items) to select several.</span>
                <span className="hide-desktop">Tap <b>Select</b> to pick several.</span>
              </p>
              {clip && (
                <div className="clip-chip" role="status">
                  <span aria-hidden="true">{clip.mode === 'cut' ? '✂' : '📋'}</span>
                  <span className="grow clip-text">
                    {clip.mode === 'cut' ? 'Cut' : 'Copied'}: <b>{clipLabel}</b>
                    <span className="muted hide-mobile"> · right-click {pasteWhere} → Paste, or pick it and press {SHORTCUTS.paste}</span>
                    <span className="muted hide-desktop"> · ⋯ on {pasteWhere} → Paste</span>
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClip(null)} title="Esc">Clear</button>
                </div>
              )}
              <RootRow events={events}>
                <div className="tree card" style={{ padding: 4 }} onContextMenu={areaMenu({ kind: 'root' })}>
                  {rows.map(renderRow)}
                  {!tree.folders.length && !tree.epochs.length && !tree.files.length && (
                    <div className="empty">Empty. Create a folder, epoch or upload files with “+ New”.</div>
                  )}
                </div>
              </RootRow>
              <div>
                <div className="row">
                  <div className="section-title grow">Inbox — unfiled tasks ({inbox.length})</div>
                  <MoreButton label="Actions for the Inbox" target={{ kind: 'inbox' }} events={events} />
                </div>
                <div className="tree card" style={{ padding: 4 }} onContextMenu={areaMenu({ kind: 'inbox' })}>
                  {inbox.map(renderRow)}
                  {!inbox.length && <div className="empty small">Nothing here.</div>}
                </div>
              </div>
            </div>
            <DragOverlay>
              {dragging && (
                <div className={cx('drag-stack tree-drag', dragging.items.length > 1 && 'many')}>
                  <div className="tree-row card drag-overlay">
                    <span className="ico">{ICONS[dragging.lead.kind]}</span>
                    <span className="name">{dragging.lead.name}</span>
                  </div>
                  {dragging.items.length > 1 && <span className="drag-count" aria-hidden>+{dragging.items.length - 1}</span>}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>
        <SelectionBar selection={selection} items={selected} total={orderedKeys.length}
          onAction={(id) => run(id, selected.length === 1 ? selected[0] : { kind: 'selection', items: selected })} />
      </div>

      <input ref={uploadRef} type="file" multiple hidden onChange={(e) => { void upload(e.target.files, uploadTarget); e.target.value = ''; }} />

      {menu && (
        <ContextMenu
          key={menu.id}
          label={`Actions for ${labelOf(menu.target)}`}
          nodes={actionsFor(menu.target)}
          at={menu.at}
          returnFocus={menu.returnFocus}
          toggleFrom={menu.toggleFrom}
          focusFirst={menu.focusFirst}
          onPick={(id) => run(id, menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
      {sheetFor && (
        <ActionSheet
          title={sheetFor.kind === 'root' ? 'Top level' : sheetFor.kind === 'inbox' ? 'Inbox' : sheetFor.kind === 'selection' ? `${sheetFor.items.length} selected` : sheetFor.name}
          nodes={actionsFor(sheetFor)}
          footer={sheetFor.kind === 'folder' ? <p className="tiny muted" style={{ margin: 0 }}>{folderPath(tree.folders, sheetFor.id)}</p> : undefined}
          onPick={(id) => run(id, sheetFor)}
          onClose={() => setSheetFor(null)}
        />
      )}
      {moving && (
        <MoveDialog items={moving} tree={tree} onClose={() => setMoving(null)}
          onPick={(dest) => { void (moving.length > 1 ? moveItems(moving, dest) : moveItem(moving[0], dest)); setMoving(null); }} />
      )}
      {preview && (
        <FilePreview
          key={preview.file.id}
          file={preview.file}
          hash={preview.hash}
          startEditing={preview.edit}
          onClose={() => setPreview(null)}
          onOpenFile={(id, hash) => {
            const file = tree.files.find((f) => f.id === id);
            if (file) setPreview({ file, edit: false, hash });
            else toast('That page is not in the explorer any more', 'error');
          }}
        />
      )}
      {newTask && <QuickAdd onClose={() => setNewTask(null)} defaults={newTask} onCreated={openTask} />}
      {newEpochIn && <EpochForm epoch={null} folderId={newEpochIn.folderId} onClose={() => setNewEpochIn(null)} />}
    </>
  );
}

/** The bar under the tree while items are selected: what can be done to all of them at once. */
function SelectionBar({ selection, items, total, onAction }: {
  selection: Selection<string>;
  /** The selected items, in the order shown. */
  items: Item[];
  /** How many rows are shown. */
  total: number;
  onAction: (id: ActionId) => void;
}) {
  if (!selection.active) return null;
  const n = items.length;
  const button = (id: ActionId, label: string, className = '') => (
    <button type="button" className={cx('btn btn-sm', className)} disabled={!n} onClick={() => onAction(id)}>{label}</button>
  );
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Act on the selected items">
      <div className="bulk-head">
        <b aria-live="polite">{n ? `${n} selected` : 'Click or tap items to select them'}</b>
        {n > 1 && <span className="small muted hide-mobile">{describeKinds(items)}</span>}
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
        {button('move', 'Move to…')}
        {button('cut', 'Cut')}
        {button('copy', 'Copy')}
        {button('duplicate', 'Duplicate')}
        {button('delete', 'Delete', 'btn-danger')}
      </div>
    </div>
  );
}

function MoreButton({ label, target, events }: { label: string; target: Target; events: RowEvents }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm more" aria-label={label} aria-haspopup="menu" onClick={(e) => events.more(e, target)}>
      ⋯
    </button>
  );
}

function RootRow({ events, children }: { events: RowEvents; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'drop-root' });
  const root: Target = { kind: 'root' };
  return (
    <div>
      <div
        ref={setNodeRef}
        className={cx('tree-row', isOver && 'drop-over')}
        data-row="root"
        style={{ background: 'transparent', minHeight: 36 }}
        tabIndex={0}
        aria-label="Root: the top level"
        onContextMenu={(e) => events.context(e, root, e.currentTarget)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget) events.keys(e, root);
        }}
      >
        <span className="ico">🏠</span><span className="name muted small">Root (drop here to move to top level)</span>
        <MoreButton label="Actions for the top level" target={root} events={events} />
      </div>
      {children}
    </div>
  );
}

function Row({ item, depth, twisty, onTwisty, droppableId, events, dragging, cut, selected, icon, extra }: {
  item: Item; depth: number; twisty?: string; onTwisty?: () => void; droppableId?: string;
  events: RowEvents;
  /** The rows being dragged. */
  dragging: ReadonlySet<string> | null;
  cut: boolean;
  selected: boolean;
  icon?: ReactNode; extra?: ReactNode;
}) {
  const key = keyOf(item);
  const drag = useDraggable({ id: key, data: { item } });
  const drop = useDroppable({ id: droppableId ?? `nodrop-${key}`, disabled: !droppableId });
  const isSelf = dragging?.has(key) ?? false;
  return (
    <div
      ref={drop.setNodeRef}
      className={cx('tree-row', drop.isOver && !isSelf && 'drop-over', isSelf && 'dragging', cut && 'cut', selected && 'selected')}
      data-row={key}
      onClick={(e) => events.click(e, item)}
      // Shift+click picks a range: don't let the browser select text as well.
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onContextMenu={(e) => events.context(e, item, e.currentTarget)}
      // Keyboard: Enter opens (folders expand), Space ticks the row's box (Shift+Space: a range) as in the List,
      // arrows expand/collapse, Shift+F10 or the menu key opens the menu, F2 renames, Delete deletes,
      // Ctrl+C / X / V copy, cut and paste.
      tabIndex={0}
      aria-expanded={twisty ? twisty === '▾' : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          events.open(item);
        } else if (e.key === ' ') {
          e.preventDefault();
          events.check(item, e.shiftKey);
        } else if (onTwisty && ((e.key === 'ArrowRight' && twisty === '▸') || (e.key === 'ArrowLeft' && twisty === '▾'))) {
          e.preventDefault();
          onTwisty();
        } else events.keys(e, item);
      }}
    >
      {/* The checkbox column, as in the List: always on desktop, on phones only while selecting (styles.css).
          The cell around the box ticks it too, an easier target than the box alone. It is ticked here, where
          Shift is known; React wants an onChange on a controlled box. */}
      <span className="select-cell" onClick={(e) => { e.stopPropagation(); events.check(item, e.shiftKey); }}>
        <input type="checkbox" className="select-box" checked={selected} aria-label={`Select ${item.name}`} onChange={noop} />
      </span>
      {/* Pointer/touch only (no keyboard drag sensor), so it is not a tab stop. The tree's indent goes here, after
          the checkbox column, so the boxes line up. */}
      <span ref={drag.setNodeRef} {...drag.listeners} className="drag-handle" style={{ marginLeft: depth * 18 }}
        onClick={(e) => e.stopPropagation()} aria-hidden="true">
        ⠿
      </span>
      <span className="twisty" onClick={(e) => { if (onTwisty) { e.stopPropagation(); onTwisty(); } }}>{twisty ?? ''}</span>
      <span className="ico">{icon ?? ICONS[item.kind]}</span>
      <span className="name">{item.name}</span>
      {extra}
      <MoreButton label={`Actions for ${item.name}`} target={item} events={events} />
    </div>
  );
}

function MoveDialog({ items, tree, onClose, onPick }: { items: Item[]; tree: Tree; onClose: () => void; onPick: (d: Dest) => void }) {
  // A folder cannot move into itself or a folder inside it.
  const blocked = useMemo(() => {
    const set = new Set<number>();
    const walk = (id: number) => {
      set.add(id);
      tree.folders.filter((f) => f.parentId === id).forEach((f) => walk(f.id));
    };
    for (const i of items) if (i.kind === 'folder') walk(i.id);
    return set;
  }, [items, tree.folders]);
  const folders = tree.folders.filter((f) => !blocked.has(f.id)).map((f) => ({ id: f.id, path: folderPath(tree.folders, f.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const tasksOnly = items.every((i) => i.kind === 'task');
  const someTasks = items.some((i) => i.kind === 'task');
  return (
    <Sheet title={`Move ${itemsName(items)}`} onClose={onClose} variant="center">
      <div className="stack" style={{ gap: 6 }}>
        <button className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => onPick({ folderId: null })}>
          {tasksOnly ? '📥 Inbox (unfiled)' : someTasks ? '🏠 Root (tasks go to the Inbox)' : '🏠 Root'}
        </button>
        {folders.map((f) => (
          <button key={f.id} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => onPick({ folderId: f.id })}>📁 {f.path}</button>
        ))}
        {tasksOnly && tree.epochs.length > 0 && <div className="section-title">Epochs</div>}
        {tasksOnly && tree.epochs.map((e) => (
          <button key={e.id} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => onPick({ epochId: e.id })}>
            <span style={{ color: e.color }}>◆</span> {e.name}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

interface FilePreviewProps {
  file: FileItem;
  onClose: () => void;
  startEditing?: boolean;
  /** Fragment to scroll an HTML preview to ("#install"). */
  hash?: string;
  /** A link in an HTML preview pointed at another uploaded page. */
  onOpenFile?: (id: number, hash: string) => void;
}

function FilePreview({ file, onClose, startEditing = false, hash = '', onOpenFile }: FilePreviewProps) {
  const url = `/api/v1/files/${file.id}/content`;
  const isImage = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(file.mime);
  const isPdf = file.mime === 'application/pdf';
  const isMedia = /^(audio|video)\//.test(file.mime);
  const isMarkdown = /\.(md|markdown)$/i.test(file.name);
  const isHtml = /\.html?$/i.test(file.name);
  const isSvg = /\.svg$/i.test(file.name);
  // HTML/SVG previews come from a sandboxed endpoint: scripts in the file can't reach the app or your login.
  const renderUrl = `/api/v1/files/${file.id}/render`;
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [frameVersion, setFrameVersion] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [isText, setIsText] = useState(false);
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const toast = useToast();
  const lastSaved = useRef<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Links between uploaded pages: the sandboxed page asks us to open the target (see PAGE_NAV_SCRIPT on the server).
  // Only messages from our own preview frame count, and they can only ask to show another file in this preview.
  useEffect(() => {
    if (!onOpenFile) return;
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { type?: unknown; id?: unknown; hash?: unknown } | null;
      if (d?.type !== 'pm-open-file' || typeof d.id !== 'number' || !Number.isInteger(d.id)) return;
      onOpenFile(d.id, typeof d.hash === 'string' && d.hash.startsWith('#') ? d.hash : '');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onOpenFile]);

  useEffect(() => {
    if (isImage || isPdf || isMedia || file.size > 2 * 1024 * 1024) return;
    let cancelled = false;
    fetch(url, { cache: 'no-store' }).then(async (r) => {
      if (!cancelled && r.headers.get('content-type')?.startsWith('text/plain')) {
        const body = await r.text();
        setIsText(true);
        setText(body);
        setDraft(body);
        lastSaved.current = body;
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [url, isImage, isPdf, isMedia, file.size]);

  const save = async (content: string) => {
    setSaveState('saving');
    try {
      await api.put(`${V1}/files/${file.id}/content`, { content });
      lastSaved.current = content;
      setText(content);
      setSaveState('saved');
      setFrameVersion((v) => v + 1); // reload the HTML/SVG preview with the saved content
    } catch (err) {
      setSaveState('error');
      toast(errorMessage(err), 'error');
    }
  };

  // Autosave while editing.
  useEffect(() => {
    if (!editing || lastSaved.current === null || draft === lastSaved.current) return;
    setSaveState('pending');
    const t = window.setTimeout(() => void save(draft), 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing]);

  const finishEditing = async () => {
    if (lastSaved.current !== null && draft !== lastSaved.current) await save(draft);
    setEditing(false);
  };

  const close = () => {
    if (editing && lastSaved.current !== null && draft !== lastSaved.current) void save(draft);
    onClose();
  };

  return (
    <Sheet
      title={file.name}
      onClose={close}
      actions={
        <>
          {isText && (editing ? (
            <>
              <span className="tiny muted">{saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : 'Saving…'}</span>
              <button className="btn btn-sm btn-primary" onClick={finishEditing}>Done</button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
          ))}
          <a className="btn btn-sm" href={`${url}?download=1`}>⬇</a>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">{file.mime} · {formatBytes(file.size)}</div>
        {isImage && <img src={url} alt={file.name} style={{ maxWidth: '100%', borderRadius: 8 }} />}
        {isPdf && <a className="btn" href={url} target="_blank" rel="noreferrer">Open PDF</a>}
        {file.mime.startsWith('audio/') && <audio controls src={url} style={{ width: '100%' }} />}
        {file.mime.startsWith('video/') && <video controls src={url} style={{ width: '100%' }} />}
        {isText && editing && (
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            rows={18}
            folderId={file.folderId}
            autoFocus
            minHeight={320}
            syntax={isHtml || isSvg ? 'html' : 'markdown'}
            placeholder={isHtml ? 'HTML. Drag, paste or add images.' : undefined}
          />
        )}
        {(isHtml || isSvg) && !editing && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="tabs" style={{ margin: 0 }}>
              <button className={view === 'preview' ? 'on' : ''} onClick={() => setView('preview')}>Preview</button>
              <button className={view === 'source' ? 'on' : ''} onClick={() => setView('source')}>Source</button>
            </div>
            <a className="btn btn-sm" href={renderUrl} target="_blank" rel="noopener noreferrer">Open full page ↗</a>
          </div>
        )}
        {isHtml && !editing && view === 'preview' && (
          <iframe
            key={frameVersion}
            ref={frameRef}
            className="html-frame"
            src={renderUrl + hash}
            title={`Preview of ${file.name}`}
            // No allow-same-origin: the page runs isolated from the app (the server's CSP enforces the same).
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          />
        )}
        {isSvg && !editing && view === 'preview' && (
          <img key={frameVersion} className="svg-preview" src={renderUrl} alt={file.name} />
        )}
        {isText && !editing && (!(isHtml || isSvg) || view === 'source') && (isMarkdown ? (
          <div className="card panel">{text ? <Markdown text={text} /> : <span className="muted">Empty document. Tap Edit to write.</span>}</div>
        ) : (
          <pre className="card panel" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.85rem', margin: 0 }}>{text}</pre>
        ))}
        {!isImage && !isPdf && !isMedia && !isText && <div className="muted">No preview available — use Download.</div>}
      </div>
    </Sheet>
  );
}

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
} from '@dnd-kit/core';
import { api, V1 } from '../api';
import { useColors, useEpochs, useTemplates, useTree } from '../hooks';
import { useMutate } from '../mutate';
import type { FileItem, Tree } from '../types';
import { cx, errorMessage, formatBytes, joinAnd, plural } from '../util';
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
import { EpochForm, epochDeleteQuestion } from './Epochs';
import {
  ICONS,
  SHORTCUTS,
  containerOf,
  copyNeedsConfirm,
  describeCounts,
  destName,
  explorerActions,
  findItem,
  isDeleteKey,
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
function loadClip(projectId: number): Clip | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(clipKey(projectId)) ?? 'null') as Clip | null;
    return v && (v.mode === 'cut' || v.mode === 'copy') && KINDS.includes(v.item?.kind) && Number.isInteger(v.item.id) ? v : null;
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

/** What rows hand up to the page: opening, the menus (right-click, ⋯, menu key) and shortcuts. */
interface RowEvents {
  open: (item: Item) => void;
  context: (e: MouseEvent<HTMLElement>, target: Target, row: HTMLElement | null) => void;
  more: (e: MouseEvent<HTMLButtonElement>, target: Target) => void;
  keys: (e: KeyboardEvent<HTMLElement>, target: Target) => void;
}

/**
 * After a row is deleted, the focus would fall back to the page: give it to the row that was next to it
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

const labelOf = (target: Target) =>
  target.kind === 'root' ? 'the top level' : target.kind === 'inbox' ? 'the Inbox' : `“${target.name}”`;

export function ExplorerPage() {
  const { data: tree, isLoading } = useTree();
  const { project } = useProject();
  const templates = useTemplates().data ?? [];
  const epochs = useEpochs().data ?? [];
  const mutate = useMutate();
  const toast = useToast();
  const navigate = useNavigate();
  const [, openTask] = useTaskParam();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [dragging, setDragging] = useState<Item | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sheetFor, setSheetFor] = useState<Target | null>(null);
  const [moving, setMoving] = useState<Item | null>(null);
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

  const setClip = useCallback(
    (next: Clip | null) => {
      setSavedClip(next);
      storeClip(project.id, next);
    },
    [project.id],
  );
  // The clipboard's item as it is now (renamed since?); nothing once it is deleted.
  const clip = useMemo(() => {
    if (!savedClip || !tree) return null;
    const item = findItem(tree, savedClip.item);
    return item ? { mode: savedClip.mode, item } : null;
  }, [savedClip, tree]);
  useEffect(() => {
    if (tree && savedClip && !clip) setClip(null);
  }, [tree, savedClip, clip, setClip]);

  // Esc empties the clipboard (menus and dialogs use Esc themselves first).
  useEffect(() => {
    if (!clip) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isSheetOpen()) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      setClip(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clip, setClip]);

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

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const item = e.active.data.current?.item as Item | undefined;
    const over = e.over?.id ? String(e.over.id) : null;
    if (!item || !over) return;
    if (over === 'drop-root') void moveItem(item, { folderId: null });
    else if (over.startsWith('drop-folder-')) {
      const folderId = Number(over.slice(12));
      if (item.kind === 'folder' && folderId === item.id) return;
      void moveItem(item, { folderId });
      expand(`folder-${folderId}`);
    } else if (over.startsWith('drop-epoch-')) void moveItem(item, { epochId: Number(over.slice(11)) });
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

  if (isLoading || !tree) return <><PageHeader title="Explorer" /><Spinner /></>;

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
      const e = epochs.find((x) => x.id === i.id) ?? tree.epochs.find((x) => x.id === i.id);
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
    const key = `${i.kind}-${i.id}`;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')].map((el) => el.dataset.row ?? '');
    const at = rows.indexOf(key);
    const neighbours = at < 0 ? [] : [rows[at + 1], rows[at - 1]].filter((k): k is string => !!k && k !== key);
    if ((await mutate(() => api.del(`${V1}/${url}`), ALL_KINDS)) !== undefined) refocusAfterRemoval(key, neighbours);
  };

  /** Copy and Duplicate: asks the server what a copy would make first, and asks before making a lot. */
  const copyItem = async (item: Item, dest: Dest, verb: 'Copy' | 'Duplicate') => {
    const where = destName(tree, dest, item.kind);
    const body = { item: { kind: item.kind, id: item.id }, to: dest };
    let counts: CopyCounts;
    try {
      counts = await api.post<CopyCounts>(`${V1}/copy`, { ...body, dryRun: true });
    } catch (err) {
      toast(errorMessage(err), 'error');
      return;
    }
    if (copyNeedsConfirm(counts)) {
      const n = counts.subtasksElsewhere;
      const parents = item.kind === 'task' ? 'the copy' : 'the copies';
      const except = !n
        ? ''
        : n === 1
          ? `, except one sub-task, which goes where its original is (as a sub-task of ${parents})`
          : `, except ${n} sub-tasks, which go where their originals are (as sub-tasks of ${parents})`;
      const ok = await askConfirm({
        title: `${verb} “${item.name}”?`,
        body:
          `This makes ${describeCounts(counts)}${counts.bytes ? ` (${formatBytes(counts.bytes)} of files)` : ''} in ${where}${except}.` +
          (counts.tasks ? ' The new tasks start in Open with their checklists unticked; logged time, comments and links stay with the originals.' : ''),
        confirmLabel: verb,
        danger: false,
      });
      if (!ok) return;
    }
    const made = await mutate(() => api.post<CopyCounts & { item: Item }>(`${V1}/copy`, body), ALL_KINDS);
    if (!made) return;
    expandDest(dest);
    const renamed = made.item.name !== item.name ? ` as “${made.item.name}”` : '';
    toast(verb === 'Copy' ? `Copied “${item.name}” to ${where}${renamed}` : `Duplicated “${item.name}”${renamed}`);
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
    if (clip.mode === 'copy') return copyItem(clip.item, dest, 'Copy');
    if ((await moveItem(clip.item, dest)) === undefined) return;
    setClip(null);
    expandDest(dest);
    toast(`Moved “${clip.item.name}” to ${destName(tree, dest, clip.item.kind)}`);
  };

  /** Runs a menu entry or a shortcut. */
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
    const item = target;
    switch (id) {
      case 'open':
        return open(item);
      case 'toggle':
        return toggle(`${item.kind}-${item.id}`);
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
      case 'cut':
      case 'copy':
        return setClip({ mode: id, item });
      case 'duplicate':
        return void copyItem(item, placeOf(tree, item), 'Duplicate');
      case 'move':
        return setMoving(item);
      case 'rename':
        return void rename(item);
      case 'delete':
        return void remove(item);
    }
  };

  /** A floating menu, or the sheet when the last tap was a finger. */
  const showActions = (target: Target, at: MenuPosition, returnFocus: HTMLElement | null, viaPointer: boolean, toggleFrom?: HTMLElement) => {
    if (viaPointer && lastPointer.current === 'touch') return setSheetFor(target);
    if (toggleFrom && menu?.toggleFrom === toggleFrom) return setMenu(null);
    setMenu({ id: ++menuSeq.current, target, at, returnFocus, toggleFrom, focusFirst: !viaPointer });
  };

  const events: RowEvents = {
    open,
    context: (e, target, row) => {
      if (e.shiftKey) return; // Shift+right-click: the browser's own menu
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - menuKeyAt.current < 600) return; // the menu key's own event, after the key opened ours
      row?.focus({ preventScroll: true });
      showActions(target, { x: e.clientX, y: e.clientY }, row, true);
    },
    more: (e, target) => {
      e.stopPropagation();
      const button = e.currentTarget;
      // detail is 0 for a press of Enter or Space, which is never a finger.
      showActions(target, { anchor: button, align: 'end' }, button, e.detail !== 0, button);
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
        showActions(target, { anchor: row.querySelector<HTMLElement>('.name') ?? row, align: 'start' }, row, false);
      } else run(id, target, true);
    },
  };

  const actionsFor = (target: Target) =>
    explorerActions(target, {
      tree,
      clip,
      expanded: (target.kind === 'folder' || target.kind === 'epoch') && expanded.has(`${target.kind}-${target.id}`),
      hasTemplates: templates.length > 0,
    });
  const isCut = (kind: Kind, id: number) => clip?.mode === 'cut' && clip.item.kind === kind && clip.item.id === id;

  const renderFolderContents = (folderId: number | null, depth: number): ReactNode => {
    const folders = tree.folders.filter((f) => f.parentId === folderId);
    const folderEpochs = tree.epochs.filter((e) => e.folderId === folderId);
    const tasks = tree.tasks.filter((t) => t.folderId === folderId && t.epochId === null && folderId !== null);
    const files = tree.files.filter((f) => f.folderId === folderId);
    return (
      <>
        {folders.map((f) => {
          const key = `folder-${f.id}`;
          const isOpen = expanded.has(key);
          return (
            <div key={key}>
              <Row item={{ kind: 'folder', id: f.id, name: f.name }} depth={depth} twisty={isOpen ? '▾' : '▸'} onTwisty={() => toggle(key)} droppableId={`drop-folder-${f.id}`}
                events={events} dragging={dragging} cut={isCut('folder', f.id)} />
              {isOpen && renderFolderContents(f.id, depth + 1)}
            </div>
          );
        })}
        {folderEpochs.map((e) => {
          const key = `epoch-${e.id}`;
          const isOpen = expanded.has(key);
          const epochTasks = tree.tasks.filter((t) => t.epochId === e.id);
          return (
            <div key={key}>
              <Row item={{ kind: 'epoch', id: e.id, name: e.name }} depth={depth} twisty={isOpen ? '▾' : '▸'} onTwisty={() => toggle(key)}
                droppableId={`drop-epoch-${e.id}`} events={events} dragging={dragging} cut={isCut('epoch', e.id)}
                icon={<span style={{ color: e.color }}>◆</span>} extra={<span className="tiny muted">{e.shipped}/{e.total}</span>} />
              {isOpen && epochTasks.map((t) => <TaskRow key={t.id} t={t} depth={depth + 1} events={events} dragging={dragging} cut={isCut('task', t.id)} />)}
              {isOpen && !epochTasks.length && <div className="tiny muted" style={{ paddingLeft: (depth + 1) * 18 + 40 }}>No tasks</div>}
            </div>
          );
        })}
        {tasks.map((t) => <TaskRow key={t.id} t={t} depth={depth} events={events} dragging={dragging} cut={isCut('task', t.id)} />)}
        {files.map((f) => (
          <Row key={`file-${f.id}`} item={{ kind: 'file', id: f.id, name: f.name }} depth={depth} events={events} dragging={dragging} cut={isCut('file', f.id)}
            extra={<span className="tiny muted">{formatBytes(f.size)}</span>} />
        ))}
      </>
    );
  };

  const inbox = tree.tasks.filter((t) => t.folderId === null && t.epochId === null);
  /** Right-click on the empty part of the tree (rows handle their own). */
  const areaMenu = (target: Target) => (e: MouseEvent<HTMLElement>) => events.context(e, target, null);
  const pasteWhere = clip?.item.kind === 'task' ? 'a folder, an epoch or the Inbox' : 'a folder or Root';

  return (
    <>
      <PageHeader title="Explorer">
        <button className="btn btn-sm" aria-haspopup="menu" onClick={(e) => events.more(e, { kind: 'root' })}>+ New</button>
      </PageHeader>
      <div className="content">
        <DndContext sensors={sensors} onDragStart={(e) => setDragging((e.active.data.current?.item as Item) ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              <span className="hide-mobile">Right-click an item, or use its <b>⋯</b>,</span>
              <span className="hide-desktop">Tap the <b>⋯</b> on an item</span> to add, cut, copy, paste, duplicate, rename or delete. Drag the{' '}
              <b>⠿</b> handle to move it onto a folder, an epoch (tasks only) or “Root”.
            </p>
            {clip && (
              <div className="clip-chip" role="status">
                <span aria-hidden="true">{clip.mode === 'cut' ? '✂' : '📋'}</span>
                <span className="grow clip-text">
                  {clip.mode === 'cut' ? 'Cut' : 'Copied'}: <b>{ICONS[clip.item.kind]} {clip.item.name}</b>
                  <span className="muted hide-mobile"> · right-click {pasteWhere} → Paste, or pick it and press {SHORTCUTS.paste}</span>
                  <span className="muted hide-desktop"> · ⋯ on {pasteWhere} → Paste</span>
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClip(null)} title="Esc">Clear</button>
              </div>
            )}
            <RootRow events={events}>
              <div className="tree card" style={{ padding: 4 }} onContextMenu={areaMenu({ kind: 'root' })}>
                {renderFolderContents(null, 0)}
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
                {inbox.map((t) => <TaskRow key={t.id} t={t} depth={0} events={events} dragging={dragging} cut={isCut('task', t.id)} />)}
                {!inbox.length && <div className="empty small">Nothing here.</div>}
              </div>
            </div>
          </div>
          <DragOverlay>
            {dragging && <div className="tree-row card drag-overlay"><span className="ico">{ICONS[dragging.kind]}</span><span className="name">{dragging.name}</span></div>}
          </DragOverlay>
        </DndContext>
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
          title={sheetFor.kind === 'root' ? 'Top level' : sheetFor.kind === 'inbox' ? 'Inbox' : sheetFor.name}
          nodes={actionsFor(sheetFor)}
          footer={sheetFor.kind === 'folder' ? <p className="tiny muted" style={{ margin: 0 }}>{folderPath(tree.folders, sheetFor.id)}</p> : undefined}
          onPick={(id) => run(id, sheetFor)}
          onClose={() => setSheetFor(null)}
        />
      )}
      {moving && <MoveDialog item={moving} tree={tree} onClose={() => setMoving(null)} onPick={(dest) => { void moveItem(moving, dest); setMoving(null); }} />}
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

function TaskRow({ t, depth, events, dragging, cut }: {
  t: Tree['tasks'][number]; depth: number; events: RowEvents; dragging: Item | null; cut: boolean;
}) {
  const colors = useColors();
  return (
    <Row item={{ kind: 'task', id: t.id, name: t.title }} depth={depth} events={events} dragging={dragging} cut={cut}
      icon={<span className="dot" style={{ background: colors.status(t.status) }} />}
      extra={<span className="key">{t.key}</span>} />
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

function Row({ item, depth, twisty, onTwisty, droppableId, events, dragging, cut, icon, extra }: {
  item: Item; depth: number; twisty?: string; onTwisty?: () => void; droppableId?: string;
  events: RowEvents; dragging: Item | null; cut: boolean; icon?: ReactNode; extra?: ReactNode;
}) {
  const drag = useDraggable({ id: `${item.kind}-${item.id}`, data: { item } });
  const drop = useDroppable({ id: droppableId ?? `nodrop-${item.kind}-${item.id}`, disabled: !droppableId });
  const isSelf = dragging?.kind === item.kind && dragging.id === item.id;
  return (
    <div
      ref={drop.setNodeRef}
      className={cx('tree-row', drop.isOver && !isSelf && 'drop-over', isSelf && 'dragging', cut && 'cut')}
      data-row={`${item.kind}-${item.id}`}
      style={{ paddingLeft: 8 + depth * 18 }}
      onClick={() => events.open(item)}
      onContextMenu={(e) => events.context(e, item, e.currentTarget)}
      // Keyboard: Enter/Space opens (folders expand), arrows expand/collapse, Shift+F10 or the menu key opens
      // the menu, F2 renames, Delete deletes, Ctrl+C / X / V copy, cut and paste.
      tabIndex={0}
      aria-expanded={twisty ? twisty === '▾' : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          events.open(item);
        } else if (onTwisty && ((e.key === 'ArrowRight' && twisty === '▸') || (e.key === 'ArrowLeft' && twisty === '▾'))) {
          e.preventDefault();
          onTwisty();
        } else events.keys(e, item);
      }}
    >
      {/* Pointer/touch only (no keyboard drag sensor), so it is not a tab stop. */}
      <span ref={drag.setNodeRef} {...drag.listeners} className="drag-handle" onClick={(e) => e.stopPropagation()} aria-hidden="true">
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

function MoveDialog({ item, tree, onClose, onPick }: {
  item: Item; tree: Tree; onClose: () => void; onPick: (d: { folderId: number | null } | { epochId: number }) => void;
}) {
  // A folder cannot move into itself or its descendants.
  const blocked = useMemo(() => {
    const set = new Set<number>();
    if (item.kind !== 'folder') return set;
    const walk = (id: number) => {
      set.add(id);
      tree.folders.filter((f) => f.parentId === id).forEach((f) => walk(f.id));
    };
    walk(item.id);
    return set;
  }, [item, tree.folders]);
  const folders = tree.folders.filter((f) => !blocked.has(f.id)).map((f) => ({ id: f.id, path: folderPath(tree.folders, f.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return (
    <Sheet title={`Move “${item.name}”`} onClose={onClose} variant="center">
      <div className="stack" style={{ gap: 6 }}>
        <button className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => onPick({ folderId: null })}>
          {item.kind === 'task' ? '📥 Inbox (unfiled)' : '🏠 Root'}
        </button>
        {folders.map((f) => (
          <button key={f.id} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => onPick({ folderId: f.id })}>📁 {f.path}</button>
        ))}
        {item.kind === 'task' && tree.epochs.length > 0 && <div className="section-title">Epochs</div>}
        {item.kind === 'task' && tree.epochs.map((e) => (
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

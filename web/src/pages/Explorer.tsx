import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useColors, useEpochs, useTree } from '../hooks';
import { useMutate } from '../mutate';
import type { FileItem, Tree } from '../types';
import { cx, errorMessage, formatBytes, joinAnd, plural } from '../util';
import { Markdown, Spinner } from '../components/Bits';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { folderPath } from '../components/Filters';
import { PageHeader, useTaskParam } from '../components/Layout';
import { QuickAdd } from '../components/QuickAdd';
import { askConfirm, type ConfirmOptions } from '../components/Confirm';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { EpochForm, epochDeleteQuestion } from './Epochs';

type Kind = 'folder' | 'epoch' | 'task' | 'file';
interface Item {
  kind: Kind;
  id: number;
  name: string;
}

const EXP_KEY = 'pm.explorer.expanded';
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXP_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

const ICONS: Record<Kind, string> = { folder: '📁', epoch: '◆', task: '▫', file: '📄' };

export function ExplorerPage() {
  const { data: tree, isLoading } = useTree();
  const mutate = useMutate();
  const toast = useToast();
  const navigate = useNavigate();
  const [, openTask] = useTaskParam();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [dragging, setDragging] = useState<Item | null>(null);
  const [menu, setMenu] = useState<Item | 'root' | null>(null);
  const [moving, setMoving] = useState<Item | null>(null);
  const [preview, setPreview] = useState<{ file: FileItem; edit: boolean; hash?: string } | null>(null);
  const [newTaskIn, setNewTaskIn] = useState<{ folderId: number | null } | null>(null);
  const [newEpochIn, setNewEpochIn] = useState<{ folderId: number | null } | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(EXP_KEY, JSON.stringify([...expanded]));
    } catch {
      /* storage unavailable */
    }
  }, [expanded]);

  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  /** Moves an item to a folder (null = root) or, for tasks, into an epoch. */
  const moveItem = async (item: Item, dest: { folderId: number | null } | { epochId: number }) => {
    const KINDS = ['folders', 'epochs', 'tasks', 'files'];
    if ('epochId' in dest) {
      if (item.kind !== 'task') return toast('Only tasks can go inside an epoch', 'error');
      return mutate(() => api.patch(`${V1}/tasks/${item.id}`, { epochId: dest.epochId }), KINDS);
    }
    const f = dest.folderId;
    switch (item.kind) {
      case 'folder':
        if (f === item.id) return;
        return mutate(() => api.patch(`${V1}/folders/${item.id}`, { parentId: f }), KINDS);
      case 'epoch':
        return mutate(() => api.patch(`${V1}/epochs/${item.id}`, { folderId: f }), KINDS);
      case 'task':
        return mutate(() => api.patch(`${V1}/tasks/${item.id}`, { folderId: f }), KINDS);
      case 'file':
        return mutate(() => api.patch(`${V1}/files/${item.id}`, { folderId: f }), KINDS);
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
      setExpanded((s) => new Set(s).add(`folder-${folderId}`));
    } else if (over.startsWith('drop-epoch-')) void moveItem(item, { epochId: Number(over.slice(11)) });
  };

  const upload = async (files: FileList | null, folderId: number | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    if (folderId !== null) fd.append('folderId', String(folderId));
    for (const f of Array.from(files)) fd.append('file', f, f.name);
    await mutate(() => api.post(`${V1}/files`, fd), ['files'], `Uploaded ${files.length} file(s)`);
    if (folderId !== null) setExpanded((s) => new Set(s).add(`folder-${folderId}`));
  };

  const createDoc = async (folderId: number | null) => {
    const name = window.prompt('Document name', 'Notes.md');
    if (!name?.trim()) return;
    try {
      const file = await api.post<FileItem>(`${V1}/docs`, { name: name.trim(), folderId, content: '' });
      if (folderId !== null) setExpanded((s) => new Set(s).add(`folder-${folderId}`));
      setPreview({ file, edit: true });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const createFolder = async (parentId: number | null) => {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    await mutate(() => api.post(`${V1}/folders`, { name: name.trim(), parentId }), ['folders']);
    if (parentId !== null) setExpanded((s) => new Set(s).add(`folder-${parentId}`));
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

  const renderFolderContents = (folderId: number | null, depth: number): ReactNode => {
    const folders = tree.folders.filter((f) => f.parentId === folderId);
    const epochs = tree.epochs.filter((e) => e.folderId === folderId);
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
                onOpen={open} onMenu={setMenu} dragging={dragging} />
              {isOpen && renderFolderContents(f.id, depth + 1)}
            </div>
          );
        })}
        {epochs.map((e) => {
          const key = `epoch-${e.id}`;
          const isOpen = expanded.has(key);
          const epochTasks = tree.tasks.filter((t) => t.epochId === e.id);
          return (
            <div key={key}>
              <Row item={{ kind: 'epoch', id: e.id, name: e.name }} depth={depth} twisty={isOpen ? '▾' : '▸'} onTwisty={() => toggle(key)}
                droppableId={`drop-epoch-${e.id}`} onOpen={open} onMenu={setMenu} dragging={dragging}
                icon={<span style={{ color: e.color }}>◆</span>} extra={<span className="tiny muted">{e.shipped}/{e.total}</span>} />
              {isOpen && epochTasks.map((t) => <TaskRow key={t.id} t={t} depth={depth + 1} open={open} setMenu={setMenu} dragging={dragging} />)}
              {isOpen && !epochTasks.length && <div className="tiny muted" style={{ paddingLeft: (depth + 1) * 18 + 40 }}>No tasks</div>}
            </div>
          );
        })}
        {tasks.map((t) => <TaskRow key={t.id} t={t} depth={depth} open={open} setMenu={setMenu} dragging={dragging} />)}
        {files.map((f) => (
          <Row key={`file-${f.id}`} item={{ kind: 'file', id: f.id, name: f.name }} depth={depth} onOpen={open} onMenu={setMenu} dragging={dragging}
            extra={<span className="tiny muted">{formatBytes(f.size)}</span>} />
        ))}
      </>
    );
  };

  const inbox = tree.tasks.filter((t) => t.folderId === null && t.epochId === null);

  return (
    <>
      <PageHeader title="Explorer">
        <button className="btn btn-sm" onClick={() => setMenu('root')}>+ New</button>
      </PageHeader>
      <div className="content">
        <DndContext sensors={sensors} onDragStart={(e) => setDragging((e.active.data.current?.item as Item) ?? null)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              Drag the <b>⠿</b> handle to move items. Drop on a folder, an epoch (tasks only) or “Root”. Or use <b>⋯</b> → Move to.
            </p>
            <RootDrop>
              <div className="tree card" style={{ padding: 4 }}>
                {renderFolderContents(null, 0)}
                {!tree.folders.length && !tree.epochs.length && !tree.files.length && (
                  <div className="empty">Empty. Create a folder, epoch or upload files with “+ New”.</div>
                )}
              </div>
            </RootDrop>
            <div>
              <div className="section-title">Inbox — unfiled tasks ({inbox.length})</div>
              <div className="tree card" style={{ padding: 4 }}>
                {inbox.map((t) => <TaskRow key={t.id} t={t} depth={0} open={open} setMenu={setMenu} dragging={dragging} />)}
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
        <ItemMenu
          item={menu}
          tree={tree}
          onClose={() => setMenu(null)}
          onMove={(item) => setMoving(item)}
          onNewFolder={createFolder}
          onNewTask={(folderId) => setNewTaskIn({ folderId })}
          onNewEpoch={(folderId) => setNewEpochIn({ folderId })}
          onUpload={(folderId) => { setUploadTarget(folderId); uploadRef.current?.click(); }}
          onNewDoc={createDoc}
          onOpen={open}
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
      {newTaskIn && <QuickAdd onClose={() => setNewTaskIn(null)} defaults={{ folderId: newTaskIn.folderId }} onCreated={openTask} />}
      {newEpochIn && <EpochForm epoch={null} folderId={newEpochIn.folderId} onClose={() => setNewEpochIn(null)} />}
    </>
  );
}

function TaskRow({ t, depth, open, setMenu, dragging }: {
  t: Tree['tasks'][number]; depth: number; open: (i: Item) => void; setMenu: (i: Item) => void; dragging: Item | null;
}) {
  const colors = useColors();
  return (
    <Row item={{ kind: 'task', id: t.id, name: t.title }} depth={depth} onOpen={open} onMenu={setMenu} dragging={dragging}
      icon={<span className="dot" style={{ background: colors.status(t.status) }} />}
      extra={<span className="key">{t.key}</span>} />
  );
}

function RootDrop({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'drop-root' });
  return (
    <div>
      <div ref={setNodeRef} className={cx('tree-row', isOver && 'drop-over')} style={{ background: 'transparent', minHeight: 36 }}>
        <span className="ico">🏠</span><span className="name muted small">Root (drop here to move to top level)</span>
      </div>
      {children}
    </div>
  );
}

function Row({ item, depth, twisty, onTwisty, droppableId, onOpen, onMenu, dragging, icon, extra }: {
  item: Item; depth: number; twisty?: string; onTwisty?: () => void; droppableId?: string;
  onOpen: (i: Item) => void; onMenu: (i: Item) => void; dragging: Item | null; icon?: ReactNode; extra?: ReactNode;
}) {
  const drag = useDraggable({ id: `${item.kind}-${item.id}`, data: { item } });
  const drop = useDroppable({ id: droppableId ?? `nodrop-${item.kind}-${item.id}`, disabled: !droppableId });
  const isSelf = dragging?.kind === item.kind && dragging.id === item.id;
  return (
    <div
      ref={drop.setNodeRef}
      className={cx('tree-row', drop.isOver && !isSelf && 'drop-over', isSelf && 'dragging')}
      style={{ paddingLeft: 8 + depth * 18 }}
      onClick={() => onOpen(item)}
      // Keyboard: Enter/Space opens (folders expand), arrows expand/collapse; "⋯ → Move to…" replaces dragging.
      tabIndex={0}
      aria-expanded={twisty ? twisty === '▾' : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item);
        } else if (onTwisty && ((e.key === 'ArrowRight' && twisty === '▸') || (e.key === 'ArrowLeft' && twisty === '▾'))) {
          e.preventDefault();
          onTwisty();
        }
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
      <button className="btn btn-ghost btn-sm more" onClick={(e) => { e.stopPropagation(); onMenu(item); }} aria-label="Actions">⋯</button>
    </div>
  );
}

function ItemMenu({ item, tree, onClose, onMove, onNewFolder, onNewTask, onNewEpoch, onUpload, onNewDoc, onOpen }: {
  item: Item | 'root'; tree: Tree; onClose: () => void; onMove: (i: Item) => void;
  onNewFolder: (parent: number | null) => void; onNewTask: (folder: number | null) => void;
  onNewEpoch: (folder: number | null) => void; onUpload: (folder: number | null) => void; onNewDoc: (folder: number | null) => void; onOpen: (i: Item) => void;
}) {
  const mutate = useMutate();
  const epochs = useEpochs().data ?? [];
  const folderId = item === 'root' ? null : item.kind === 'folder' ? item.id : undefined;
  const act = (fn: () => void) => () => { onClose(); fn(); };

  const urlOf = (i: Item) => (i.kind === 'folder' ? `folders/${i.id}` : i.kind === 'epoch' ? `epochs/${i.id}` : i.kind === 'file' ? `files/${i.id}` : `tasks/${i.id}`);
  const rename = async (i: Item) => {
    const name = window.prompt('New name', i.name);
    if (!name?.trim() || name === i.name) return;
    await mutate(() => api.patch(`${V1}/${urlOf(i)}`, i.kind === 'task' ? { title: name.trim() } : { name: name.trim() }), ['folders', 'epochs', 'tasks', 'files']);
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
    await mutate(() => api.del(`${V1}/${url}`), ['folders', 'epochs', 'tasks', 'files']);
  };

  const title = item === 'root' ? 'New at top level' : item.name;
  return (
    <Sheet title={title} onClose={onClose} variant="center">
      <div className="stack" style={{ gap: 6 }}>
        {folderId !== undefined && (
          <>
            <button className="btn" onClick={act(() => onNewFolder(folderId))}>📁 New folder</button>
            <button className="btn" onClick={act(() => onNewEpoch(folderId))}>◆ New epoch</button>
            {folderId !== null && <button className="btn" onClick={act(() => onNewTask(folderId))}>▫ New task here</button>}
            <button className="btn" onClick={act(() => onNewDoc(folderId))}>📝 New markdown document</button>
            <button className="btn" onClick={act(() => onUpload(folderId))}>⬆ Upload files</button>
          </>
        )}
        {item !== 'root' && (
          <>
            {item.kind !== 'folder' && <button className="btn" onClick={act(() => onOpen(item))}>Open</button>}
            {item.kind === 'file' && (
              <a className="btn" href={`/api/v1/files/${item.id}/content?download=1`} onClick={onClose}>⬇ Download</a>
            )}
            <button className="btn" onClick={act(() => onMove(item))}>Move to…</button>
            <button className="btn" onClick={act(() => void rename(item))}>Rename</button>
            <button className="btn btn-danger" onClick={act(() => void remove(item))}>Delete</button>
          </>
        )}
        {item !== 'root' && item.kind === 'folder' && (
          <p className="tiny muted" style={{ margin: 0 }}>{folderPath(tree.folders, item.id)}</p>
        )}
      </div>
    </Sheet>
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

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { api, V1 } from '../api';
import { tasksKey, useMeta, useTasks, type TaskFilters } from '../hooks';
import { useProjectId } from '../projectContext';
import { useMutate } from '../mutate';
import { useTaskSelection } from '../selection';
import type { Task } from '../types';
import { cx } from '../util';
import { readWidths, storeWidths, useResizeHandle } from '../resize';
import { BulkBar } from '../components/BulkBar';
import { FilterBar, useFilters } from '../components/Filters';
import { PageHeader, useTaskParam } from '../components/Layout';
import { TaskCard } from '../components/TaskCard';
import { QuickAdd, StatusPicker } from '../components/QuickAdd';
import { Spinner } from '../components/Bits';

/**
 * Drop target = what is under the pointer (not whatever the dragged card's rectangle overlaps most).
 * Inside a column but between cards, snap to the nearest card in that column; whether the card goes
 * before or after it is decided in onDragEnd from the pointer's half of that card.
 */
const boardCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return rectIntersection(args);
  const card = hits.find((h) => String(h.id).startsWith('before-'));
  if (card) return [card];
  const column = hits.find((h) => String(h.id).startsWith('col-'));
  if (!column) return hits.slice(0, 1);
  const status = String(column.id).slice(4);
  const cardsInColumn = args.droppableContainers.filter(
    (c) => String(c.id).startsWith('before-') && c.data.current?.status === status,
  );
  const nearest = cardsInColumn.length ? closestCenter({ ...args, droppableContainers: cardsInColumn }) : [];
  return nearest.length ? nearest.slice(0, 1) : [column];
};

/** True when the dragged card's centre is below the middle of the card it is over. */
function isLowerHalf(e: DragMoveEvent | DragEndEvent): boolean {
  const dragged = e.active.rect.current.translated;
  const over = e.over?.rect;
  return Boolean(dragged && over && dragged.top + dragged.height / 2 > over.top + over.height / 2);
}

/** A column's width on desktop, which people can drag. Saved per project and status in this browser. */
const COLUMN_WIDTH = { min: 200, max: 600, initial: 290 };
const columnWidthsKey = (projectId: number) => `pm.board.widths.${projectId}`;

const COL_KEY = 'pm.board.column';
/** The phone view shows one column at a time; remember the last one picked on this device. */
const readCol = (): string | null => {
  try {
    return localStorage.getItem(COL_KEY);
  } catch {
    return null;
  }
};

export function BoardPage() {
  return (
    <>
      <PageHeader title="Board" />
      <div className="content flush">
        <FilterBar hide={['status']} />
        <BoardView />
      </div>
    </>
  );
}

/** The Kanban board. `scope` adds fixed filters (e.g. an epoch). */
export function BoardView({ scope = {} }: { scope?: TaskFilters }) {
  const [urlFilters] = useFilters();
  const filters = useMemo(() => ({ ...urlFilters, ...scope, status: undefined }), [urlFilters, scope]);
  // An epoch's own board: every card is in that epoch, so the cards don't need to say so.
  const oneEpoch = Boolean(scope.epoch);
  const projectId = useProjectId();
  const queryKey = tasksKey(projectId, filters);
  const { data: tasks, isLoading } = useTasks(filters);
  const meta = useMeta().data;
  const qc = useQueryClient();
  const mutate = useMutate();
  const [, openTask] = useTaskParam();
  const [mobileCol, setMobileColState] = useState(readCol);
  const [dragging, setDragging] = useState<Task | null>(null);
  // Whether the dragged card is over the lower half of the card under the pointer (drop goes after it).
  const [dropAfter, setDropAfter] = useState(false);
  const [moving, setMoving] = useState<Task | null>(null);
  const [addingIn, setAddingIn] = useState<string | null>(null);
  // Read once: switching projects mounts the page afresh (project.tsx).
  const [columnWidths, setColumnWidths] = useState(() => readWidths(columnWidthsKey(projectId), COLUMN_WIDTH.min, COLUMN_WIDTH.max));

  /** Keeps a column's new width (`undefined`: back to the default) for this project's boards, epochs' included. */
  const resizeColumn = (status: string, px: number | undefined) => {
    const next = { ...columnWidths };
    if (px === undefined) delete next[status];
    else next[status] = px;
    setColumnWidths(next);
    storeWidths(columnWidthsKey(projectId), next);
  };

  const setMobileCol = (s: string) => {
    setMobileColState(s);
    try {
      localStorage.setItem(COL_KEY, s);
    } catch {
      /* storage unavailable */
    }
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const byStatus = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const s of meta?.statuses ?? []) map[s.id] = [];
    for (const t of tasks ?? []) (map[t.status] ??= []).push(t);
    for (const list of Object.values(map)) list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return map;
  }, [tasks, meta]);

  // Multi-select works in board order: column by column, top to bottom.
  const ordered = useMemo(() => (meta?.statuses ?? []).flatMap((s) => (byStatus[s.id] ?? []).map((t) => t.id)), [byStatus, meta]);
  const selection = useTaskSelection(ordered);
  const selectedTasks = useMemo(() => {
    const byId = new Map((tasks ?? []).map((t) => [t.id, t]));
    return selection.ids.flatMap((id) => byId.get(id) ?? []);
  }, [tasks, selection.ids]);
  /** What a drag of `task` carries: the whole selection when the card is part of it. */
  const dragGroup = (task: Task): Task[] => (selection.has(task.id) && selectedTasks.length > 1 ? selectedTasks : [task]);

  /**
   * Optimistically puts `group` (in that order) in `status`, before `beforeId` or at the end of the column,
   * then saves: one card through its own move route, several in one bulk request.
   */
  const moveTasks = async (group: Task[], status: string, beforeId: number | null) => {
    const moving = new Set(group.map((t) => t.id));
    const col = (byStatus[status] ?? []).filter((t) => !moving.has(t.id));
    const idx = beforeId === null ? -1 : col.findIndex((t) => t.id === beforeId);
    // Spread the cards evenly between their new neighbours.
    const lo = idx === -1 ? (col.at(-1)?.sortOrder ?? 0) : idx === 0 ? col[0].sortOrder - 1 : col[idx - 1].sortOrder;
    const hi = idx === -1 ? lo + 1 : col[idx].sortOrder;
    const order = new Map(group.map((t, i) => [t.id, lo + ((hi - lo) * (i + 1)) / (group.length + 1)]));
    const label = meta?.statuses.find((s) => s.id === status)?.label ?? status;
    // A refetch already in flight (e.g. from the previous move) would land after this and snap the cards back.
    await qc.cancelQueries({ queryKey: ['tasks'] });
    qc.setQueryData<Task[]>(queryKey, (old) =>
      old?.map((t) => (order.has(t.id) ? { ...t, status, statusLabel: label, sortOrder: order.get(t.id)! } : t)),
    );
    await mutate(
      () =>
        group.length === 1
          ? api.post(`${V1}/tasks/${group[0].id}/move`, { status, beforeId })
          : api.post(`${V1}/tasks/bulk`, { action: 'move', ids: group.map((t) => t.id), status, beforeId }),
      ['tasks'],
    );
  };

  /** Whether `group` already sits together, in that order, in `status`, right before `beforeId` (null: last). */
  const alreadyThere = (group: Task[], status: string, beforeId: number | null) => {
    const col = (byStatus[status] ?? []).map((t) => t.id);
    const first = col.indexOf(group[0].id);
    return first !== -1 && group.every((t, i) => col[first + i] === t.id) && (col[first + group.length] ?? null) === beforeId;
  };

  const step = (task: Task, dir: -1 | 1) => {
    const list = meta?.statuses ?? [];
    const i = list.findIndex((s) => s.id === task.status) + dir;
    if (i >= 0 && i < list.length) void moveTasks([task], list[i].id, null);
  };

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current?.task as Task) ?? null);
  const onDragMove = (e: DragMoveEvent) => {
    const after = isLowerHalf(e);
    if (after !== dropAfter) setDropAfter(after);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const task = e.active.data.current?.task as Task | undefined;
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!task || !overId) return;
    const group = dragGroup(task);
    const moving = new Set(group.map((t) => t.id));
    let status: string;
    let beforeId: number | null;
    if (overId.startsWith('before-')) {
      const targetId = Number(overId.slice(7));
      const target = tasks?.find((t) => t.id === targetId);
      if (!target) return;
      status = target.status;
      // Dropped on the lower half of a card: insert after it. Either way, before the first card from there
      // on that isn't being moved (or at the end).
      const col = byStatus[status] ?? [];
      const from = col.findIndex((t) => t.id === targetId) + (isLowerHalf(e) ? 1 : 0);
      beforeId = col.slice(from).find((t) => !moving.has(t.id))?.id ?? null;
    } else if (overId.startsWith('col-')) {
      status = overId.slice(4);
      beforeId = null;
    } else return;
    if (!alreadyThere(group, status, beforeId)) void moveTasks(group, status, beforeId);
  };

  if (!meta || isLoading) return <Spinner />;

  // First visit on this device: open the first column that has work in it.
  const activeCol = mobileCol ?? meta.statuses.find((s) => byStatus[s.id]?.length)?.id ?? meta.statuses[0].id;

  // The cards a drag carries look picked up; the overlay under the pointer says how many there are.
  const carried = dragging ? new Set(dragGroup(dragging).map((t) => t.id)) : null;

  return (
    <>
      {/* Phones: one column at a time, picked here; Select turns on tap-to-select (no hover or Ctrl there). */}
      <div className="board-top hide-desktop">
        <div className="col-tabs">
          {meta.statuses.map((s) => {
            const on = activeCol === s.id;
            return (
              <button key={s.id} className={cx('col-tab', on && 'on')} style={on ? { background: s.color, borderColor: s.color } : { borderColor: s.color + '88' }}
                onClick={() => setMobileCol(s.id)}>
                {s.label} <span className="count">{byStatus[s.id]?.length ?? 0}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className={cx('btn btn-sm select-toggle', selection.mode && 'on')} aria-pressed={selection.mode}
          onClick={() => (selection.mode ? selection.clear() : selection.setMode(true))}>
          Select
        </button>
      </div>
      <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className={cx('board', selection.active && 'selecting')}>
          {meta.statuses.map((s) => (
            <Column key={s.id} id={s.id} label={s.label} color={s.color} count={byStatus[s.id]?.length ?? 0} mobileHidden={activeCol !== s.id}
              width={columnWidths[s.id]} onResize={(px) => resizeColumn(s.id, px)} onAdd={() => setAddingIn(s.id)}>
              {(byStatus[s.id] ?? []).map((t) => (
                <DraggableCard key={t.id} task={t} isDragging={carried?.has(t.id) ?? false} dropAfter={dropAfter}>
                  <TaskCard task={t} onOpen={openTask} onStep={step} onMove={setMoving} hideEpoch={oneEpoch}
                    select={{ selected: selection.has(t.id), tapSelects: selection.mode, onToggle: (range) => selection.toggle(t.id, range) }} />
                </DraggableCard>
              ))}
            </Column>
          ))}
        </div>
        <DragOverlay>
          {dragging && carried && (
            <div className={cx('drag-stack', carried.size > 1 && 'many')}>
              <TaskCard task={dragging} onOpen={() => {}} className="drag-overlay" hideEpoch={oneEpoch} />
              {carried.size > 1 && <span className="drag-count" aria-hidden>+{carried.size - 1}</span>}
            </div>
          )}
        </DragOverlay>
      </DndContext>
      <BulkBar selection={selection} tasks={selectedTasks} total={ordered.length} />
      {moving && <StatusPicker current={moving.status} onClose={() => setMoving(null)} onPick={(s) => moveTasks([moving], s, null)} />}
      {addingIn && (
        <QuickAdd onClose={() => setAddingIn(null)} defaults={{ status: addingIn, epochId: scope.epoch ? Number(scope.epoch) : null }} onCreated={openTask} />
      )}
    </>
  );
}

function Column({ id, label, color, count, mobileHidden, width, onResize, onAdd, children }: {
  id: string; label: string; color: string; count: number; mobileHidden: boolean;
  /** The saved width, if it was changed. */
  width: number | undefined;
  onResize: (px: number | undefined) => void;
  onAdd: () => void; children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${id}` });
  // While the handle is dragged only this column re-renders; the board hears of the new width when it is let go.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const shown = dragWidth ?? width ?? COLUMN_WIDTH.initial;
  const resizer = useResizeHandle({
    ...COLUMN_WIDTH,
    width: shown,
    edge: 1,
    onChange: setDragWidth,
    onCommit: (px) => {
      setDragWidth(null);
      onResize(px === COLUMN_WIDTH.initial ? undefined : px);
    },
  });
  return (
    <section ref={setNodeRef} className={cx('column', isOver && 'drop-over', mobileHidden && 'mobile-hidden')}
      style={shown === COLUMN_WIDTH.initial ? undefined : ({ '--col-w': `${shown}px` } as CSSProperties)}>
      <div className="column-head" style={{ borderTopColor: color, background: color + '1a' }}>
        <span className="grow">{label}</span>
        <span className="muted small">{count}</span>
      </div>
      <div className="column-body">
        {children}
        {count === 0 && <div className="muted small" style={{ textAlign: 'center', padding: 12 }}>No tasks</div>}
      </div>
      <button className="btn btn-ghost btn-sm add-inline" onClick={onAdd}>+ Add task</button>
      {/* In the gap to the right of the column. Desktop only (styles.css). */}
      <div className="column-resizer" aria-label={`Resize the ${label} column`} {...resizer} />
    </section>
  );
}

function DraggableCard({ task, isDragging, dropAfter, children }: { task: Task; isDragging: boolean; dropAfter: boolean; children: ReactNode }) {
  const drag = useDraggable({ id: `task-${task.id}`, data: { task } });
  const drop = useDroppable({ id: `before-${task.id}`, data: { status: task.status } });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      className={cx(isDragging && 'dragging', drop.isOver && !isDragging && (dropAfter ? 'drop-after' : 'drop-before'))}
      style={{ borderRadius: 'var(--radius)' }}
    >
      {children}
    </div>
  );
}

import { useMemo, useState, type ReactNode } from 'react';
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
import type { Task } from '../types';
import { cx } from '../util';
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
  const queryKey = tasksKey(useProjectId(), filters);
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

  /** Optimistically re-orders the cached list, then persists. */
  const moveTask = async (task: Task, status: string, beforeId: number | null) => {
    const col = (byStatus[status] ?? []).filter((t) => t.id !== task.id);
    let order: number;
    const idx = beforeId === null ? -1 : col.findIndex((t) => t.id === beforeId);
    if (idx === -1) order = (col.at(-1)?.sortOrder ?? 0) + 1;
    else order = idx === 0 ? col[0].sortOrder - 1 : (col[idx - 1].sortOrder + col[idx].sortOrder) / 2;
    const label = meta?.statuses.find((s) => s.id === status)?.label ?? status;
    // A refetch already in flight (e.g. from the previous move) would land after this and snap the card back.
    await qc.cancelQueries({ queryKey: ['tasks'] });
    qc.setQueryData<Task[]>(queryKey, (old) =>
      old?.map((t) => (t.id === task.id ? { ...t, status, statusLabel: label, sortOrder: order } : t)),
    );
    await mutate(() => api.post(`${V1}/tasks/${task.id}/move`, { status, beforeId }), ['tasks']);
  };

  const step = (task: Task, dir: -1 | 1) => {
    const list = meta?.statuses ?? [];
    const i = list.findIndex((s) => s.id === task.status) + dir;
    if (i >= 0 && i < list.length) void moveTask(task, list[i].id, null);
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
    if (overId.startsWith('before-')) {
      const targetId = Number(overId.slice(7));
      if (targetId === task.id) return;
      const target = tasks?.find((t) => t.id === targetId);
      if (!target) return;
      // Dropped on the lower half of a card: insert after it (before the next card, or at the end).
      const below = isLowerHalf(e);
      const col = (byStatus[target.status] ?? []).filter((t) => t.id !== task.id);
      const beforeId = below ? (col[col.findIndex((t) => t.id === targetId) + 1]?.id ?? null) : targetId;
      // Already exactly there? Skip the request.
      const current = byStatus[task.status] ?? [];
      const nextInCurrent = current[current.findIndex((t) => t.id === task.id) + 1]?.id ?? null;
      if (task.status === target.status && beforeId === nextInCurrent) return;
      void moveTask(task, target.status, beforeId);
    } else if (overId.startsWith('col-')) {
      const status = overId.slice(4);
      const col = byStatus[status] ?? [];
      if (task.status === status && col.at(-1)?.id === task.id) return;
      void moveTask(task, status, null);
    }
  };

  if (!meta || isLoading) return <Spinner />;

  // First visit on this device: open the first column that has work in it.
  const activeCol = mobileCol ?? meta.statuses.find((s) => byStatus[s.id]?.length)?.id ?? meta.statuses[0].id;

  return (
    <>
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
      <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="board">
          {meta.statuses.map((s) => (
            <Column key={s.id} id={s.id} label={s.label} color={s.color} count={byStatus[s.id]?.length ?? 0} mobileHidden={activeCol !== s.id} onAdd={() => setAddingIn(s.id)}>
              {(byStatus[s.id] ?? []).map((t) => (
                <DraggableCard key={t.id} task={t} isDragging={dragging?.id === t.id} dropAfter={dropAfter}>
                  <TaskCard task={t} onOpen={openTask} onStep={step} onMove={setMoving} />
                </DraggableCard>
              ))}
            </Column>
          ))}
        </div>
        <DragOverlay>{dragging && <TaskCard task={dragging} onOpen={() => {}} className="drag-overlay" />}</DragOverlay>
      </DndContext>
      {moving && <StatusPicker current={moving.status} onClose={() => setMoving(null)} onPick={(s) => moveTask(moving, s, null)} />}
      {addingIn && (
        <QuickAdd onClose={() => setAddingIn(null)} defaults={{ status: addingIn, epochId: scope.epoch ? Number(scope.epoch) : null }} onCreated={openTask} />
      )}
    </>
  );
}

function Column({ id, label, color, count, mobileHidden, onAdd, children }: {
  id: string; label: string; color: string; count: number; mobileHidden: boolean; onAdd: () => void; children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${id}` });
  return (
    <section ref={setNodeRef} className={cx('column', isOver && 'drop-over', mobileHidden && 'mobile-hidden')}>
      <div className="column-head" style={{ borderTopColor: color, background: color + '1a' }}>
        <span className="grow">{label}</span>
        <span className="muted small">{count}</span>
      </div>
      <div className="column-body">
        {children}
        {count === 0 && <div className="muted small" style={{ textAlign: 'center', padding: 12 }}>No tasks</div>}
      </div>
      <button className="btn btn-ghost btn-sm add-inline" onClick={onAdd}>+ Add task</button>
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

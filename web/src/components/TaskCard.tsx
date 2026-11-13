import type { MouseEvent } from 'react';
import type { Task } from '../types';
import { CategoryChip, PriorityBadge, TypeBadge } from './Bits';
import { contrastText, cx, formatMinutes } from '../util';

/** Multi-select (selection.ts): the card's checkbox, and what a click does while selecting. */
export interface CardSelect {
  selected: boolean;
  /** Select mode on a phone: a tap ticks the card instead of opening it. */
  tapSelects: boolean;
  /** `range`: Shift was held (tick everything from the last ticked card to this one). */
  onToggle: (range: boolean) => void;
}

interface Props {
  task: Task;
  onOpen: (id: number) => void;
  /** Mobile-friendly status buttons (prev / move / next). */
  onStep?: (task: Task, dir: -1 | 1) => void;
  onMove?: (task: Task) => void;
  className?: string;
  /** Leave out the epoch label, e.g. on a board that only shows one epoch. */
  hideEpoch?: boolean;
  select?: CardSelect;
}

// The checkbox is ticked in onClick, which also knows about Shift; React wants an onChange on a controlled box.
const noop = () => {};
// Keeps a press on the checkbox from starting a card drag (dnd-kit listens on the card's wrapper).
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function TaskCard({ task, onOpen, onStep, onMove, className = '', hideEpoch = false, select }: Props) {
  const epochColor = task.epochColor ?? '#6366f1';
  const click = (e: MouseEvent) => {
    if (select && (select.tapSelects || e.shiftKey || e.ctrlKey || e.metaKey)) select.onToggle(e.shiftKey);
    else onOpen(task.id);
  };
  return (
    <div
      className={cx('card task-card', select?.selected && 'selected', className)}
      style={{ borderLeftColor: task.epochColor ?? 'var(--border)' }}
      title={task.epochName ? `Epoch: ${task.epochName}` : undefined}
      onClick={click}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        // Keys pressed on the buttons inside the card are theirs.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') onOpen(task.id);
        else if (e.key === ' ' && select) {
          e.preventDefault();
          select.onToggle(e.shiftKey);
        }
      }}
    >
      {task.epochName && !hideEpoch && (
        // The epoch's name, filled with its colour (the same colour as the card's left edge).
        <span className="epoch-chip" style={{ background: epochColor, color: contrastText(epochColor) }}>
          ◆ {task.epochName}
        </span>
      )}
      <div className="row nowrap">
        {select && (
          <input
            type="checkbox"
            className="select-box"
            checked={select.selected}
            aria-label={`Select ${task.key}`}
            onChange={noop}
            onClick={(e) => {
              e.stopPropagation();
              select.onToggle(e.shiftKey);
            }}
            onMouseDown={stop}
            onTouchStart={stop}
            onPointerDown={stop}
            onKeyDown={stop}
          />
        )}
        <span className="key grow">{task.key}</span>
        <TypeBadge type={task.type} />
      </div>
      {task.parent && (
        <button
          type="button"
          className="parent-chip"
          title={`Sub-task of ${task.parent.key} "${task.parent.title}". Click to open it.`}
          aria-label={`Open the parent task, ${task.parent.key} ${task.parent.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(task.parent!.id);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          ↳ <span className="key">{task.parent.key}</span> {task.parent.title}
        </button>
      )}
      <div className="title">{task.title}</div>
      {task.categories.length > 0 && (
        <div className="row" style={{ gap: 4 }}>
          {task.categories.map((c) => (
            <CategoryChip key={c.id} category={c} />
          ))}
        </div>
      )}
      <div className="meta">
        {task.openBlockers > 0 && (
          <span className="blocked-chip" title={`Blocked by ${task.openBlockers} task${task.openBlockers > 1 ? 's' : ''} not yet Alpha Complete`}>
            ⛔ Blocked
          </span>
        )}
        <PriorityBadge priority={task.priority} />
        {task.subtasks.total > 0 && (
          <span className="subtask-count" title="Sub-tasks at Alpha Complete or later">
            Sub-tasks {task.subtasks.done}/{task.subtasks.total}
          </span>
        )}
        {task.checklist.total > 0 && (
          <span title="Checklist">
            ☑ {task.checklist.done}/{task.checklist.total}
          </span>
        )}
        {(task.loggedMinutes > 0 || task.estimateMinutes) && (
          <span title="Logged / estimate">
            ⏱ {formatMinutes(task.loggedMinutes)}
            {task.estimateMinutes ? ` / ${formatMinutes(task.estimateMinutes)}` : ''}
          </span>
        )}
        {task.timerRunning && <span className="dot" style={{ background: '#16a34a' }} title="Timer running" />}
        {/^claude\b/i.test(task.createdBy) && <span title={`Created by ${task.createdBy}`}>🤖</span>}
      </div>
      {(onStep || onMove) && (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          {onStep && (
            <button className="btn btn-sm" onClick={() => onStep(task, -1)} disabled={task.status === 'open'} aria-label="Previous status">
              ◀
            </button>
          )}
          {onMove && (
            <button className="btn btn-sm grow" onClick={() => onMove(task)}>
              Move to…
            </button>
          )}
          {onStep && (
            <button className="btn btn-sm" onClick={() => onStep(task, 1)} disabled={task.status === 'ready_to_ship'} aria-label="Next status">
              ▶
            </button>
          )}
        </div>
      )}
    </div>
  );
}

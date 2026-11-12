import type { Task } from '../types';
import { CategoryChip, PriorityBadge, TypeBadge } from './Bits';
import { contrastText, formatMinutes } from '../util';

interface Props {
  task: Task;
  onOpen: (id: number) => void;
  /** Mobile-friendly status buttons (prev / move / next). */
  onStep?: (task: Task, dir: -1 | 1) => void;
  onMove?: (task: Task) => void;
  className?: string;
  /** Leave out the epoch label, e.g. on a board that only shows one epoch. */
  hideEpoch?: boolean;
}

export function TaskCard({ task, onOpen, onStep, onMove, className = '', hideEpoch = false }: Props) {
  const epochColor = task.epochColor ?? '#6366f1';
  return (
    <div
      className={`card task-card ${className}`}
      style={{ borderLeftColor: task.epochColor ?? 'var(--border)' }}
      title={task.epochName ? `Epoch: ${task.epochName}` : undefined}
      onClick={() => onOpen(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(task.id)}
    >
      {task.epochName && !hideEpoch && (
        // The epoch's name, filled with its colour (the same colour as the card's left edge).
        <span className="epoch-chip" style={{ background: epochColor, color: contrastText(epochColor) }}>
          ◆ {task.epochName}
        </span>
      )}
      <div className="row nowrap" style={{ justifyContent: 'space-between' }}>
        <span className="key">{task.key}</span>
        <TypeBadge type={task.type} />
      </div>
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

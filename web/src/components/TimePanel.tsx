import { useState } from 'react';
import { api, V1 } from '../api';
import { useRunningTimer, useTime } from '../hooks';
import { useMutate } from '../mutate';
import { formatMinutes, timeAgo } from '../util';
import { askConfirm } from './Confirm';

interface Props {
  taskId?: number;
  epochId?: number;
  loggedMinutes: number;
  estimateMinutes: number | null;
  /** Extra line under the totals (e.g. sum of task estimates for an epoch). */
  extra?: string;
}

const TIME_KINDS = ['time'];

export function TimePanel({ taskId, epochId, loggedMinutes, estimateMinutes, extra }: Props) {
  const mutate = useMutate();
  const running = useRunningTimer().data;
  const entries = useTime(taskId ? { taskId } : { epochId }).data;
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const target = taskId ? { taskId } : { epochId };
  const runningHere = !!running && (taskId ? running.taskId === taskId : running.target === 'epoch' && running.epochId === epochId);
  const pct = estimateMinutes ? Math.min(100, Math.round((loggedMinutes / estimateMinutes) * 100)) : null;

  const addEntry = async () => {
    if (!duration.trim()) return;
    const ok = await mutate(() => api.post(`${V1}/time`, { ...target, duration: duration.trim(), note }), TIME_KINDS, 'Time logged');
    if (ok) {
      setDuration('');
      setNote('');
    }
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>
            {formatMinutes(loggedMinutes)}
            <span className="muted small" style={{ fontWeight: 400 }}>
              {' '}
              logged{estimateMinutes ? ` of ${formatMinutes(estimateMinutes)}` : ''}
            </span>
          </div>
          {extra && <div className="small muted">{extra}</div>}
        </div>
        {runningHere ? (
          <button className="btn btn-danger" onClick={() => mutate(() => api.post(`${V1}/time/stop`, {}), TIME_KINDS)}>
            ■ Stop timer
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => mutate(() => api.post(`${V1}/time/start`, target), TIME_KINDS)}>
            ▶ Start timer
          </button>
        )}
      </div>
      {pct !== null && (
        <div className="progress" title={`${pct}% of estimate`}>
          <span style={{ width: `${pct}%`, background: loggedMinutes > (estimateMinutes ?? 0) ? 'var(--danger)' : 'var(--success)' }} />
        </div>
      )}
      <div className="row nowrap">
        <input style={{ width: 110, flex: 'none' }} placeholder="1h30m" value={duration} onChange={(e) => setDuration(e.target.value)} aria-label="Duration" />
        <input className="grow" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addEntry()} />
        <button className="btn" onClick={addEntry} disabled={!duration.trim()}>
          Log
        </button>
      </div>
      {entries && entries.entries.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {entries.entries.map((e) => (
            <div key={e.id} className="row nowrap small">
              <strong style={{ width: 64, flex: 'none' }}>{e.running ? '● ' : ''}{formatMinutes(e.minutes)}</strong>
              <span className="grow ellipsis">
                {epochId && e.taskKey ? <span className="key">{e.taskKey} </span> : null}
                {e.note || <span className="muted">{e.running ? 'running…' : 'no note'}</span>}
              </span>
              <span className="muted tiny" style={{ flex: 'none' }}>
                {e.actor} · {timeAgo(e.startedAt)}
              </span>
              {!e.running && (
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label={`Delete the ${formatMinutes(e.minutes)} entry`}
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: 'Delete time entry?',
                      body: `${formatMinutes(e.minutes)} logged by ${e.actor} ${timeAgo(e.startedAt)}${e.note ? ` ("${e.note}")` : ''} will be removed from the totals. This can't be undone.`,
                      confirmLabel: 'Delete entry',
                    });
                    if (ok) await mutate(() => api.del(`${V1}/time/${e.id}`), TIME_KINDS);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

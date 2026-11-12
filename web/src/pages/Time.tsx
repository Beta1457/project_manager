import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useEpochs, useTime } from '../hooks';
import { formatMinutes } from '../util';
import { Spinner } from '../components/Bits';
import { PageHeader, useTaskParam } from '../components/Layout';

const RANGES = {
  today: 'Today',
  week: 'Last 7 days',
  month: 'Last 30 days',
  all: 'All time',
} as const;
type Range = keyof typeof RANGES;

function rangeStart(r: Range): string | undefined {
  const d = new Date();
  if (r === 'all') return undefined;
  if (r === 'today') d.setHours(0, 0, 0, 0);
  else d.setDate(d.getDate() - (r === 'week' ? 7 : 30));
  return d.toISOString();
}

export function TimePage() {
  const [range, setRange] = useState<Range>('week');
  const [epoch, setEpoch] = useState('');
  const epochs = useEpochs().data ?? [];
  const from = useMemo(() => rangeStart(range), [range]);
  const { data, isLoading } = useTime({ from, epochId: epoch ? Number(epoch) : undefined });
  const [, openTask] = useTaskParam();

  const byDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of data?.entries ?? []) {
      const day = new Date(e.startedAt).toLocaleDateString();
      map.set(day, (map.get(day) ?? 0) + e.minutes);
    }
    return [...map.entries()];
  }, [data]);

  const byTarget = useMemo(() => {
    const map = new Map<string, { label: string; minutes: number; taskId: number | null }>();
    for (const e of data?.entries ?? []) {
      const key = e.taskId ? `t${e.taskId}` : `e${e.epochId}`;
      const label = e.taskId ? `${e.taskKey} ${e.taskTitle}` : `◆ ${e.epochName}`;
      const cur = map.get(key) ?? { label, minutes: 0, taskId: e.taskId };
      cur.minutes += e.minutes;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.minutes - a.minutes);
  }, [data]);

  const maxDay = Math.max(1, ...byDay.map(([, m]) => m));

  return (
    <>
      <PageHeader title="Time" />
      <div className="content">
        <div className="stack">
          <div className="row">
            <select value={range} onChange={(e) => setRange(e.target.value as Range)} style={{ width: 'auto' }}>
              {Object.entries(RANGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={epoch} onChange={(e) => setEpoch(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All epochs & tasks</option>
              {epochs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          {isLoading || !data ? <Spinner /> : (
            <>
              <div className="card panel">
                <div className="section-title">Total</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 800 }}>{formatMinutes(data.totalMinutes)}</div>
                <div className="small muted">{data.entries.length} entries</div>
              </div>
              {byDay.length > 0 && (
                <div className="card panel stack" style={{ gap: 6 }}>
                  <div className="section-title">By day</div>
                  {byDay.map(([day, m]) => (
                    <div key={day} className="row nowrap small">
                      <span style={{ width: 90, flex: 'none' }}>{day}</span>
                      <div className="grow progress" style={{ height: 14 }}><span style={{ width: `${(m / maxDay) * 100}%`, background: 'var(--primary)' }} /></div>
                      <span style={{ width: 64, textAlign: 'right', flex: 'none' }}>{formatMinutes(m)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="card panel stack" style={{ gap: 6 }}>
                <div className="section-title">By task / epoch</div>
                {!byTarget.length && <div className="muted">No time logged in this range.</div>}
                {byTarget.map((t) => (
                  <div key={t.label} className="row nowrap small">
                    {t.taskId ? (
                      <a className="grow ellipsis" href={`?task=${t.taskId}`} onClick={(ev) => { ev.preventDefault(); openTask(t.taskId!); }}>{t.label}</a>
                    ) : <span className="grow ellipsis">{t.label}</span>}
                    <strong>{formatMinutes(t.minutes)}</strong>
                  </div>
                ))}
              </div>
              <div className="card panel stack" style={{ gap: 6 }}>
                <div className="section-title">Entries</div>
                {data.entries.map((e) => (
                  <div key={e.id} className="row nowrap small">
                    <strong style={{ width: 64, flex: 'none' }}>{e.running ? '● ' : ''}{formatMinutes(e.minutes)}</strong>
                    <span className="grow ellipsis">
                      {e.taskId ? <a href={`?task=${e.taskId}`} onClick={(ev) => { ev.preventDefault(); openTask(e.taskId!); }}>{e.taskKey}</a> : e.epochId ? <Link to={`/epochs/${e.epochId}`}>◆ {e.epochName}</Link> : null}{' '}
                      {e.note}
                    </span>
                    <span className="tiny muted" style={{ flex: 'none' }}>{e.actor} · {new Date(e.startedAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

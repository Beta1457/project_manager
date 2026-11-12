import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, V1 } from '../api';
import { useEpoch, useEpochs, useFolders } from '../hooks';
import { useMutate } from '../mutate';
import type { Epoch, Folder } from '../types';
import { formatMinutes, plural } from '../util';
import { askConfirm, type ConfirmOptions } from '../components/Confirm';
import { Markdown, ProgressBar, Spinner } from '../components/Bits';
import { FilterBar, folderPath } from '../components/Filters';
import { PageHeader } from '../components/Layout';
import { Sheet } from '../components/Sheet';
import { TimePanel } from '../components/TimePanel';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { BoardView } from './Board';

export function EpochsPage() {
  const { data: epochs, isLoading } = useEpochs();
  const folders = useFolders().data ?? [];
  const [editing, setEditing] = useState<Epoch | 'new' | null>(null);

  return (
    <>
      <PageHeader title="Epochs">
        <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>+ Epoch</button>
      </PageHeader>
      <div className="content">
        {isLoading ? (
          <Spinner />
        ) : !epochs?.length ? (
          <div className="empty">No epochs yet. Epochs group related tasks — e.g. “Version 1.0” or “Sign-up flow”.</div>
        ) : (
          <div className="epoch-grid">
            {epochs.map((e) => (
              <Link key={e.id} to={`/epochs/${e.id}`} className="card epoch-card" style={{ borderTopColor: e.color }}>
                <div className="row nowrap">
                  <h3 className="grow ellipsis">{e.name}</h3>
                  <span className="small muted">{e.shipped}/{e.total} shipped</span>
                </div>
                <ProgressBar counts={e.counts} total={e.total} />
                <div className="row small muted" style={{ justifyContent: 'space-between' }}>
                  <span>⏱ {formatMinutes(e.loggedMinutes)}{e.estimateMinutes ? ` / ${formatMinutes(e.estimateMinutes)}` : ''}</span>
                  {e.targetDate && <span>🎯 {e.targetDate}</span>}
                  {e.folderId && <span>📁 {folderPath(folders, e.folderId)}</span>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      {editing && <EpochForm epoch={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

export function EpochDetailPage() {
  const id = Number(useParams().id);
  const { data: epoch, error } = useEpoch(id);
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<'board' | 'overview'>('board');
  const scope = useMemo(() => ({ epoch: String(id) }), [id]);

  if (error) return <div className="empty">{(error as Error).message} <Link to="/epochs">Back</Link></div>;
  if (!epoch) return <Spinner />;

  return (
    <>
      <PageHeader title={<span><Link to="/epochs" className="muted">Epochs</Link> / {epoch.name}</span>}>
        <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
      </PageHeader>
      <div className="content flush">
        <div className="filterbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div className="row nowrap">
            <span className="dot" style={{ background: epoch.color, width: 14, height: 14 }} />
            <div className="grow"><ProgressBar counts={epoch.counts} total={epoch.total} /></div>
            <span className="small muted">{epoch.shipped}/{epoch.total}</span>
          </div>
          <div className="tabs">
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button>
            <button className={view === 'overview' ? 'on' : ''} onClick={() => setView('overview')}>Overview & time</button>
          </div>
        </div>
        {view === 'board' ? (
          <>
            <FilterBar hide={['status', 'epoch']} />
            <BoardView scope={scope} />
          </>
        ) : (
          <div style={{ overflow: 'auto', padding: 12 }} className="stack">
            <div className="card panel">
              <div className="section-title">Description</div>
              {epoch.description ? <Markdown text={epoch.description} /> : <span className="muted">No description.</span>}
              {epoch.targetDate && <p className="small muted">Target date: {epoch.targetDate}</p>}
            </div>
            <div className="card panel">
              <div className="section-title">Time tracking</div>
              <TimePanel
                epochId={epoch.id}
                loggedMinutes={epoch.loggedMinutes}
                estimateMinutes={epoch.estimateMinutes ?? (epoch.taskEstimateMinutes || null)}
                extra={`Includes time on tasks. ${formatMinutes(epoch.loggedDirectMinutes)} logged on the epoch itself.` +
                  (epoch.taskEstimateMinutes ? ` Task estimates total ${formatMinutes(epoch.taskEstimateMinutes)}.` : '')}
              />
            </div>
          </div>
        )}
      </div>
      {editing && <EpochForm epoch={epoch} onClose={() => setEditing(false)} />}
    </>
  );
}

/** Exact, re-parseable estimate text: 85 -> "1h25m" (never a rounded "1.4h"). */
const fmtEstimate = (m: number | null) => (!m ? '' : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}` : `${m}m`);

/**
 * The question asked before an epoch is deleted, from its form or from the Explorer. The server keeps the
 * tasks and moves them to the epoch's folder, but deletes time logged directly on the epoch. Without
 * `loggedDirectMinutes` (not known yet) the text covers that case anyway.
 */
export function epochDeleteQuestion(
  epoch: { name: string; total: number; folderId: number | null; loggedDirectMinutes?: number },
  folders: Folder[],
): ConfirmOptions {
  const dest = epoch.folderId === null ? 'the Inbox (unfiled tasks)' : `the folder "${folderPath(folders, epoch.folderId)}"`;
  const direct =
    epoch.loggedDirectMinutes === undefined
      ? 'Any time logged directly on the epoch is deleted with it.'
      : epoch.loggedDirectMinutes > 0
        ? `The ${formatMinutes(epoch.loggedDirectMinutes)} logged directly on the epoch is deleted with it.`
        : '';
  return {
    title: 'Delete epoch?',
    body: [
      `"${epoch.name}" will be deleted.`,
      epoch.total ? `Its ${plural(epoch.total, 'task')} and their logged time are kept and move to ${dest}.` : '',
      direct,
    ]
      .filter(Boolean)
      .join(' '),
    confirmLabel: 'Delete epoch',
  };
}

export function EpochForm({ epoch, onClose, folderId }: { epoch: Epoch | null; onClose: () => void; folderId?: number | null }) {
  const mutate = useMutate();
  const navigate = useNavigate();
  const folders = useFolders().data ?? [];
  // Starting values; on save only fields that differ are sent (re-sending folderId would reset the
  // epoch's position in its folder, and a rounded estimate would silently change it).
  const [initial] = useState(() => ({
    name: epoch?.name ?? '',
    description: epoch?.description ?? '',
    color: epoch?.color ?? '#6366f1',
    targetDate: epoch?.targetDate ?? '',
    estimate: fmtEstimate(epoch?.estimateMinutes ?? null),
    folder: String(epoch?.folderId ?? folderId ?? ''),
  }));
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [color, setColor] = useState(initial.color);
  const [targetDate, setTargetDate] = useState(initial.targetDate);
  const [estimate, setEstimate] = useState(initial.estimate);
  const [folder, setFolder] = useState<string>(initial.folder);
  const current = { name, description, color, targetDate, estimate, folder };
  const dirty = (Object.keys(initial) as Array<keyof typeof initial>).some((k) => current[k] !== initial[k]);

  const save = async () => {
    const full: Record<string, unknown> = {
      name,
      description,
      color,
      targetDate: targetDate || null,
      estimate: estimate.trim() || null,
      folderId: folder ? Number(folder) : null,
    };
    const fieldOf = { name: 'name', description: 'description', color: 'color', targetDate: 'targetDate', estimate: 'estimate', folder: 'folderId' } as const;
    const body = epoch
      ? Object.fromEntries((Object.keys(fieldOf) as Array<keyof typeof fieldOf>).filter((k) => current[k] !== initial[k]).map((k) => [fieldOf[k], full[fieldOf[k]]]))
      : full;
    if (epoch && !Object.keys(body).length) return onClose();
    const ok = epoch
      ? await mutate(() => api.patch(`${V1}/epochs/${epoch.id}`, body), ['epochs'], 'Epoch saved')
      : await mutate(() => api.post(`${V1}/epochs`, body), ['epochs'], 'Epoch created');
    if (ok) onClose();
  };
  const remove = async () => {
    if (!epoch) return;
    if (!(await askConfirm(epochDeleteQuestion(epoch, folders)))) return;
    if (await mutate(() => api.del(`${V1}/epochs/${epoch.id}?deleteTime=true`), ['epochs', 'tasks'], 'Epoch deleted')) {
      onClose();
      navigate('/epochs');
    }
  };

  return (
    <Sheet title={epoch ? 'Edit epoch' : 'New epoch'} onClose={onClose} variant="center" confirmClose={() => !dirty || askConfirm({ title: 'Discard your changes?', body: 'Your edits to this epoch will be lost.', confirmLabel: 'Discard' })}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <div className="field" style={{ display: 'grid', gap: 4 }}><span className="small muted" style={{ fontWeight: 600 }}>Description</span><MarkdownEditor value={description} onChange={setDescription} rows={4} /></div>
        <div className="grid-2">
          <label className="field">Color<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
          <label className="field">Target date<input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></label>
          <label className="field">Estimate<input value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="e.g. 20h" /></label>
          <label className="field">Folder
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">(root)</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{folderPath(folders, f.id)}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <button className="btn btn-primary grow" type="submit" disabled={!name.trim()}>Save</button>
          {epoch && <button type="button" className="btn btn-danger" onClick={remove}>Delete</button>}
        </div>
      </form>
    </Sheet>
  );
}

import { memo, useEffect, useRef, useState } from 'react';
import { api, V1 } from '../api';
import { useDock, useOpenFile, usePanel } from '../dock/context';
import { PanelFrame } from '../dock/PanelFrame';
import { useFile } from '../hooks';
import type { FileItem } from '../types';
import { errorMessage, formatBytes } from '../util';
import { Markdown, Spinner } from './Bits';
import { MarkdownEditor } from './MarkdownEditor';
import { useToast } from './Toast';

/** Text files bigger than this are offered as a download only. */
const MAX_TEXT = 2 * 1024 * 1024;

/**
 * A file in a dock panel: images, PDFs, audio and video; markdown and text to read and edit (autosaved); HTML
 * pages and SVGs from the sandboxed render endpoint. Links between uploaded pages open in the same panel.
 */
export const FilePanel = memo(function FilePanel() {
  const panel = usePanel();
  const dock = useDock();
  const id = Number(panel.item.ref);
  // Loaded by id, so a doc can stay open while you move around the app. Minimized: no refresh until shown.
  const { data: file, error } = useFile(id, panel.shown || !panel.item.label);
  useEffect(() => {
    if (file) dock.setLabel(panel.key, { title: file.name });
  }, [dock, panel.key, file?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!file) {
    return (
      <PanelFrame title={panel.item.label?.title ?? 'File'}>
        {error ? <div className="empty">{errorMessage(error)}</div> : <Spinner />}
      </PanelFrame>
    );
  }
  return <FileView key={file.id} file={file} />;
});

function FileView({ file }: { file: FileItem }) {
  const panel = usePanel();
  const openFile = useOpenFile();
  const request = panel.item.request;
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
  const [editing, setEditing] = useState(Boolean(request?.edit));
  /** The part of an HTML page to show ("#install"). */
  const [hash, setHash] = useState(request?.hash ?? '');
  const [draft, setDraft] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  /** Bumped to read the file again (shown again after being minimized, changed elsewhere). */
  const [reads, setReads] = useState(0);
  const toast = useToast();
  const lastSaved = useRef<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ editing, draft });
  latest.current = { editing, draft };

  // Asked again while open (Edit once more, a link to another part of this page).
  const handled = useRef(request?.n);
  useEffect(() => {
    if (!request || request.n === handled.current) return;
    handled.current = request.n;
    if (request.edit) setEditing(true);
    if (request.hash !== undefined) setHash(request.hash);
  }, [request]);

  // Links between uploaded pages: the sandboxed page asks us to open the target (see PAGE_NAV_SCRIPT on the server).
  // Only messages from our own preview frame count, and they can only ask to show another file, here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { type?: unknown; id?: unknown; hash?: unknown } | null;
      if (d?.type !== 'pm-open-file' || typeof d.id !== 'number' || !Number.isInteger(d.id) || d.id <= 0) return;
      const target = typeof d.hash === 'string' && d.hash.startsWith('#') ? d.hash : '';
      openFile(d.id, target ? { hash: target } : undefined);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [openFile]);

  useEffect(() => {
    if (isImage || isPdf || isMedia || file.size > MAX_TEXT) return;
    let cancelled = false;
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        if (cancelled || !r.headers.get('content-type')?.startsWith('text/plain')) return;
        const body = await r.text();
        if (cancelled) return;
        setIsText(true);
        setText(body);
        // Edits not saved yet stay as they are.
        if (lastSaved.current === null || latest.current.draft === lastSaved.current) {
          setDraft(body);
          lastSaved.current = body;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Not on every change of size: saving here changes it too. The effect below asks for a new read instead.
  }, [url, isImage, isPdf, isMedia, reads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shown again after being minimized, or changed elsewhere (the size is all a file's details say): read it
  // again, unless it is being edited here.
  const seen = useRef({ shown: panel.shown, size: file.size });
  useEffect(() => {
    const was = seen.current;
    seen.current = { shown: panel.shown, size: file.size };
    if (editing) return;
    if ((panel.shown && !was.shown) || file.size !== was.size) setReads((n) => n + 1);
  }, [panel.shown, file.size, editing]);

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

  // Autosave while editing (minimized too).
  useEffect(() => {
    if (!editing || lastSaved.current === null || draft === lastSaved.current) return;
    setSaveState('pending');
    const t = window.setTimeout(() => void save(draft), 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing]);

  // Closed mid-sentence (✕, Esc, Back): the last words are saved anyway.
  useEffect(
    () => () => {
      const { editing: wasEditing, draft: last } = latest.current;
      if (wasEditing && lastSaved.current !== null && last !== lastSaved.current) {
        api.put(`${V1}/files/${file.id}/content`, { content: last }).catch((err) => toast(`${file.name} not saved: ${errorMessage(err)}`, 'error'));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const finishEditing = async () => {
    if (lastSaved.current !== null && draft !== lastSaved.current) await save(draft);
    setEditing(false);
  };

  return (
    <PanelFrame
      title={file.name}
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
          <a className="btn btn-sm" href={`${url}?download=1`} aria-label={`Download ${file.name}`} title="Download">⬇</a>
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
        {/* A minimized panel lets go of its page: it would keep running out of sight. It reloads when shown. */}
        {isHtml && !editing && view === 'preview' && panel.shown && (
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
    </PanelFrame>
  );
}

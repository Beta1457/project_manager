import { useEffect, useRef, useState } from 'react';
import { api, V1 } from '../api';
import type { FileItem } from '../types';
import { useToast } from './Toast';
import { errorMessage } from '../util';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /** Where uploaded images go. Omit to use the root "Attachments" folder. */
  folderId?: number | null;
  minHeight?: number;
  /** How uploaded files are inserted: markdown image/link syntax, or HTML tags (for editing .html files). */
  syntax?: 'markdown' | 'html';
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Markdown textarea that accepts images (and other files) by drag & drop, paste,
 * or the "Add image" button (which opens the camera/gallery on phones).
 * Uploads go to the file store and are inserted as markdown at the cursor.
 */
export function MarkdownEditor({ value, onChange, placeholder, rows = 8, autoFocus, folderId, minHeight, syntax = 'markdown' }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const toast = useToast();

  // When opened for editing, put the cursor at the end so new content/images append.
  useEffect(() => {
    const el = ref.current;
    if (autoFocus && el) el.selectionStart = el.selectionEnd = el.value.length;
  }, [autoFocus]);

  const insertAtCursor = (text: string) => {
    const el = ref.current;
    const v = valueRef.current;
    const start = el?.selectionStart ?? v.length;
    const end = el?.selectionEnd ?? v.length;
    const before = v.slice(0, start);
    const pad = before && !before.endsWith('\n') ? '\n' : '';
    const next = before + pad + text + '\n' + v.slice(end);
    valueRef.current = next;
    onChange(next);
    const caret = start + pad.length + text.length + 1;
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = caret;
    });
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading((n) => n + files.length);
    try {
      const fd = new FormData();
      if (folderId != null) fd.append('folderId', String(folderId));
      else fd.append('purpose', 'attachment');
      for (const f of files) fd.append('file', f, f.name || `pasted-${Date.now()}.png`);
      const res = await api.post<{ files: FileItem[] }>(`${V1}/files`, fd);
      const md = res.files
        .map((f) => {
          // SVGs only display as images from the sandboxed render URL; /content serves them as plain text.
          const isSvg = /\.svg$/i.test(f.name);
          const url = `/api/v1/files/${f.id}/${isSvg ? 'render' : 'content'}`;
          const isImage = isSvg || f.mime.startsWith('image/');
          if (syntax === 'html') {
            const name = escapeAttr(f.name);
            return isImage ? `<img src="${url}" alt="${name}">` : `<a href="${url}">${name}</a>`;
          }
          const alt = f.name.replace(/[[\]]/g, '');
          return isImage ? `![${alt}](${url})` : `[${alt}](${url})`;
        })
        .join('\n');
      insertAtCursor(md);
    } catch (err) {
      toast(`Upload failed: ${errorMessage(err)}`, 'error');
    } finally {
      setUploading((n) => n - files.length);
    }
  };

  return (
    <div className={`md-editor ${dragOver ? 'drag-over' : ''}`}>
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder ?? 'Markdown supported. Drag, paste or add images.'}
        style={minHeight ? { minHeight } : undefined}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            void upload(files);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) {
            e.preventDefault();
            void upload(files);
          }
        }}
      />
      <div className="md-toolbar">
        <button type="button" className="btn btn-sm btn-ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>
          🖼 Add image
        </button>
        {uploading > 0 && <span className="small muted">Uploading {uploading}…</span>}
        <span className="grow" />
        <span className="tiny muted hide-mobile">Drop or paste images here</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void upload(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}

import { api, V1 } from './api';
import type { FileItem, Folder } from './types';
import { uploadFiles, type UploadResult } from './upload';

// Importing Markdown documents whose images are inside the file, as Google Docs' "Download → Markdown (.md)"
// writes them: "![][image1]" in the text and "[image1]: <data:image/png;base64,…>" at the bottom. The images
// become files of their own, next to the document, and the document links to them, so it stays small and
// pleasant to edit (and to read for an agent).

/** A base64 image written into the text. Stops at the first character that can't be base64 (">", ")", a quote). */
const DATA_IMAGE = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)/g;

const EXT: Record<string, string> = { jpeg: 'jpg', pjpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico', tiff: 'tif' };

export interface ImportNames {
  /** The document's name ("Design notes.md"). */
  doc: string;
  /** The folder its images go in, next to it ("Design notes images"). */
  imagesFolder: string;
}

export interface ImportResult {
  doc: FileItem;
  /** Images stored as files. */
  images: number;
  failed: UploadResult['failed'];
}

function decode(base64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null; // not valid base64: left as it is
  }
}

/** "image1" from a line like `[image1]: <data:…`, so the files keep Google's names. */
function referenceLabel(text: string, at: number): string | null {
  const head = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  const label = /^ {0,3}\[([^\]]{1,80})\]:\s*<?$/.exec(head)?.[1];
  const safe = label?.replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return safe || null;
}

/** Imports one Markdown file into `folderId`, its embedded images into a new folder beside it. */
export async function importMarkdown(file: File, folderId: number | null, names: ImportNames): Promise<ImportResult> {
  const text = await file.text();
  // Each distinct image once, in order, with a file name unique in this document.
  const images = new Map<string, File>();
  const used = new Set<string>();
  for (const m of text.matchAll(DATA_IMAGE)) {
    if (images.has(m[0])) continue;
    const bytes = decode(m[2]);
    if (!bytes) continue;
    const type = m[1].toLowerCase();
    const ext = EXT[type] ?? type.replace(/[^a-z0-9]/g, '');
    let stem = referenceLabel(text, m.index) ?? `image${images.size + 1}`;
    for (let n = 2; used.has(`${stem}.${ext}`.toLowerCase()); n++) stem = `${stem}-${n}`;
    used.add(`${stem}.${ext}`.toLowerCase());
    images.set(m[0], new File([bytes], `${stem}.${ext}`, { type: `image/${type}` }));
  }

  let content = text;
  let stored: FileItem[] = [];
  let failed: UploadResult['failed'] = [];
  let folder: Folder | null = null;
  if (images.size) {
    folder = await api.post<Folder>(`${V1}/folders`, { name: names.imagesFolder, parentId: folderId });
    ({ files: stored, failed } = await uploadFiles([...images.values()], { folderId: folder.id }));
    const byName = new Map(stored.map((f) => [f.name.toLowerCase(), f]));
    content = text.replace(DATA_IMAGE, (whole) => {
      const image = images.get(whole);
      if (!image) return whole;
      const f = byName.get(image.name.toLowerCase());
      // Not stored: a broken image named after the file is better than megabytes of base64 in the text.
      if (!f) return image.name;
      // SVGs only display as images from the sandboxed render URL; /content serves them as plain text.
      return `/api/v1/files/${f.id}/${/\.svg$/i.test(f.name) ? 'render' : 'content'}`;
    });
  }
  try {
    const doc = await api.post<FileItem>(`${V1}/docs`, { name: names.doc, folderId, content });
    return { doc, images: stored.length, failed };
  } catch (err) {
    // No document: take its images back out rather than leave an orphaned folder.
    await Promise.allSettled(stored.map((f) => api.del(`${V1}/files/${f.id}`)));
    if (folder) await api.del(`${V1}/folders/${folder.id}`).catch(() => {});
    throw err;
  }
}

/** `name` or, if taken (ignoring case), "name (2)", "name (3)", … keeping the extension at the end. */
export function freeName(name: string, taken: Set<string>, ext = ''): string {
  const base = ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
  let candidate = base + ext;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

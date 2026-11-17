import { ApiError, api, V1 } from './api';
import type { FileItem } from './types';
import { errorMessage, joinAnd, plural } from './util';

// The server takes at most 20 files per request (server/app.ts). Smaller batches also show progress sooner and
// lose less when one fails, since a request is all or nothing.
const BATCH_FILES = 10;
const BATCH_BYTES = 40 * 1024 * 1024;

/** Where uploads go: a folder, or (with no folder) the root "Attachments" folder for purpose "attachment". */
export interface UploadTarget {
  folderId?: number | null;
  purpose?: 'attachment';
}

export interface UploadResult {
  /** Stored files, in the order given. */
  files: FileItem[];
  failed: Array<{ name: string; error: string }>;
}

/** Name order as a file manager shows it ("shot 2" before "shot 10"): a drop of many files has no order of its own. */
export function byName(files: File[]): File[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function batches(files: File[]): File[][] {
  const out: File[][] = [];
  let batch: File[] = [];
  let bytes = 0;
  for (const f of files) {
    if (batch.length && (batch.length >= BATCH_FILES || bytes + f.size > BATCH_BYTES)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(f);
    bytes += f.size;
  }
  if (batch.length) out.push(batch);
  return out;
}

async function send(files: File[], target: UploadTarget): Promise<FileItem[]> {
  const fd = new FormData();
  // Fields go before the files: the server reads them first.
  if (target.folderId != null) fd.append('folderId', String(target.folderId));
  else if (target.purpose) fd.append('purpose', target.purpose);
  for (const f of files) fd.append('file', f, f.name || `pasted-${Date.now()}.png`);
  return (await api.post<{ files: FileItem[] }>(`${V1}/files`, fd)).files;
}

/**
 * Uploads any number of files, a few per request, in the order given. When a request is refused (a file too big,
 * say), its files are tried one at a time, so only the files that can't be stored are left out.
 * `onStored` gets each request's files as they arrive; `onProgress` how many have been dealt with so far.
 */
export async function uploadFiles(
  files: File[],
  target: UploadTarget,
  on: { stored?: (files: FileItem[]) => void; progress?: (done: number, total: number) => void } = {},
): Promise<UploadResult> {
  const result: UploadResult = { files: [], failed: [] };
  const keep = (stored: FileItem[]) => {
    result.files.push(...stored);
    on.stored?.(stored);
  };
  let done = 0;
  for (const batch of batches(files)) {
    try {
      keep(await send(batch, target));
    } catch (err) {
      // Refused for one of its files: find which. Anything else (server down, signed out) fails the whole batch.
      const refused = err instanceof ApiError && (err.status === 400 || err.status === 413);
      if (batch.length > 1 && refused) {
        for (const f of batch) {
          try {
            keep(await send([f], target));
          } catch (e) {
            result.failed.push({ name: f.name, error: errorMessage(e) });
          }
        }
      } else {
        for (const f of batch) result.failed.push({ name: f.name, error: errorMessage(err) });
      }
    }
    done += batch.length;
    on.progress?.(done, files.length);
  }
  return result;
}

/** "Couldn't upload 2 of 35 files: a.png and b.png (File "a.png" exceeds the upload size limit)". */
export function failedMessage(failed: UploadResult['failed'], total: number): string {
  const names = failed.slice(0, 3).map((f) => f.name);
  if (failed.length > 3) names.push(plural(failed.length - 3, 'other'));
  const what = total === 1 ? 'the file' : `${failed.length} of ${plural(total, 'file')}`;
  return `Couldn't upload ${what}: ${joinAnd(names)} (${failed[0].error})`;
}

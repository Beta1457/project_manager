import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { has, nonEmpty, parseId } from '../lib/util.ts';

interface FileRow {
  id: number;
  project_id: number;
  folder_id: number | null;
  name: string;
  stored_name: string;
  mime: string;
  size: number;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
}

const dto = (r: FileRow) => ({
  id: r.id,
  folderId: r.folder_id,
  name: r.name,
  mime: r.mime,
  size: r.size,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Types safe to render inline on our own origin (no HTML/SVG, which could run scripts). */
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|audio\/.*|video\/.*)$/;
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.xml',
  '.cs', '.gd', '.js', '.ts', '.tsx', '.jsx', '.py', '.lua', '.c', '.h', '.cpp', '.hpp', '.java', '.shader',
  '.hlsl', '.glsl', '.css', '.html', '.htm', '.svg', '.sh', '.ps1', '.bat', '.sql', '.tscn', '.tres', '.godot',
]);

const MAX_DOC_BYTES = 2 * 1024 * 1024;

/**
 * Common types by extension, for clients (like curl or the pm CLI) that upload without a MIME type.
 * The stored type is only a label and a hint: /content never serves HTML or SVG as anything but text.
 */
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.zip': 'application/zip', '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml', '.css': 'text/css',
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
};

/** The stored MIME type, or one inferred from the file name when the uploader didn't say. */
function effectiveMime(name: string, mime: string | undefined): string {
  if (mime && mime !== 'application/octet-stream') return mime;
  return EXT_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// ---- HTML / SVG preview ---------------------------------------------------------------

const RENDER_EXT = new Set(['.html', '.htm', '.svg']);
const MAX_RENDER_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_ONE = 10 * 1024 * 1024;
const MAX_INLINE_TOTAL = 25 * 1024 * 1024;

/**
 * Uploaded HTML/SVG is previewed in a sandbox. The CSP `sandbox` directive (without allow-same-origin) gives
 * the document its own opaque origin, even when opened directly in a tab. Its scripts can run, but they can't
 * read this app's cookies, call its API as the user, submit forms, or navigate the app's window. That
 * boundary is what keeps previews safe; the resource inlining below is only a convenience.
 */
const SANDBOX_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  "default-src 'none'",
  "img-src data: blob: https:",
  "style-src 'unsafe-inline' data: https:",
  "font-src data: https:",
  "script-src 'unsafe-inline' data: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** Types for inlined resources: stylesheets and scripts are rejected by browsers under the wrong type. */
const RESOURCE_MIME: Record<string, string> = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon',
};

/** src/href/poster on resource tags (not <a>), with a quoted value. */
const RESOURCE_RE = /(<(?:img|script|link|source|video|audio|track)\b[^>]*?\s(?:src|href|poster)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
/** href on links, with a quoted value. */
const LINK_RE = /(<a\b[^>]*?\shref\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Added to pages whose links were pointed at other uploaded pages. A sandboxed preview frame can't send the
 * login cookie when it navigates itself, so inside the app it asks the parent window to open the page instead.
 * Opened as a full page (a top-level tab) the link simply navigates, and the browser sends the cookie.
 */
const PAGE_NAV_SCRIPT =
  '<script>(function(){document.addEventListener("click",function(e){' +
  'var a=e.target&&e.target.closest?e.target.closest("a[data-pm-file]"):null;' +
  'if(!a||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;' +
  'if((a.target&&a.target!=="_self")||window.parent===window)return;' +
  'e.preventDefault();' +
  'window.parent.postMessage({type:"pm-open-file",id:Number(a.getAttribute("data-pm-file")),hash:a.hash},location.protocol+"//"+location.host);' +
  '});})();</script>';

function isTextFile(row: { name: string; mime: string }): boolean {
  return TEXT_EXT.has(path.extname(row.name).toLowerCase()) || row.mime.startsWith('text/');
}

/** Writes a stored file atomically (temp + rename) so a backup never mirrors a half-written copy. */
async function writeStored(dir: string, stored: string, content: string): Promise<void> {
  const dest = path.join(dir, stored);
  await fsp.writeFile(`${dest}.part`, content, 'utf8');
  await fsp.rename(`${dest}.part`, dest);
}

function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return base.slice(0, 255) || 'file';
}

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, filesDir, access } = ctx;
  const get = (id: number) => db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow;
  /** A file the caller may see. */
  const fileIn = (req: FastifyRequest, raw: string): FileRow => {
    const id = parseId(raw, 'file');
    access.of(req, 'files', id, `File ${id}`);
    return get(id);
  };
  const assertFolder = (folderId: number, projectId: number) => access.inProject('folders', folderId, projectId, `Folder ${folderId}`);

  app.get<{ Querystring: { folder?: string; project?: string } }>('/api/v1/files', async (req) => {
    const pid = access.current(req).id;
    const f = req.query.folder;
    const rows = (
      f === undefined
        ? db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY name').all(pid)
        : f === 'root'
          ? db.prepare('SELECT * FROM files WHERE project_id = ? AND folder_id IS NULL ORDER BY name').all(pid)
          : db.prepare('SELECT * FROM files WHERE project_id = ? AND folder_id = ? ORDER BY name').all(pid, parseId(f, 'folder'))
    ) as unknown as FileRow[];
    return { files: rows.map(dto) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/files/:id', async (req) => dto(fileIn(req, req.params.id)));

  /** Images pasted into markdown (task/epoch descriptions) are stored in the project's root "Attachments" folder. */
  const attachmentsFolder = (projectId: number): number => {
    const row = db.prepare("SELECT id FROM folders WHERE project_id = ? AND parent_id IS NULL AND name = 'Attachments'").get(projectId) as
      | { id: number }
      | undefined;
    if (row) return row.id;
    const res = db.prepare("INSERT INTO folders (project_id, name, parent_id, sort_order) VALUES (?, 'Attachments', NULL, 9999)").run(projectId);
    bus.emit({ kind: 'folders' });
    return Number(res.lastInsertRowid);
  };

  // Multipart upload. Optional fields must come before the file part(s):
  //   folderId   – destination folder
  //   purpose    – "attachment" puts the file in the root "Attachments" folder (when no folderId)
  app.post('/api/v1/files', async (req, reply) => {
    const { actor } = requireAuth(req);
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data');
    const pid = access.current(req).id;
    let folderId: number | null = null;
    const created: Array<{ id: number; stored: string }> = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'folderId' && part.value !== '' && part.value !== 'null') {
            folderId = parseId(String(part.value), 'folder');
            assertFolder(folderId, pid);
          } else if (part.fieldname === 'purpose' && part.value === 'attachment' && folderId === null) {
            folderId = attachmentsFolder(pid);
          }
          continue;
        }
        const stored = crypto.randomUUID();
        const dest = path.join(filesDir, stored);
        // Stream into a ".part" file and rename once complete, so the backup mirror never copies a half-written upload.
        const partial = `${dest}.part`;
        try {
          await pipeline(part.file, fs.createWriteStream(partial));
          if (part.file.truncated) throw badRequest(`File "${part.filename}" exceeds the upload size limit`);
          await fsp.rename(partial, dest);
        } catch (err) {
          await fsp.rm(partial, { force: true });
          throw err;
        }
        const size = (await fsp.stat(dest)).size;
        const name = sanitizeName(part.filename);
        const res = db
          .prepare('INSERT INTO files (project_id, folder_id, name, stored_name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(pid, folderId, name, stored, effectiveMime(name, part.mimetype), size, actor);
        created.push({ id: Number(res.lastInsertRowid), stored });
      }
    } catch (err) {
      // All or nothing: if a later file fails (e.g. too large), drop the ones already stored from this request.
      if (created.length) {
        tx(db, () => {
          for (const c of created) db.prepare('DELETE FROM files WHERE id = ?').run(c.id);
        });
        await Promise.all(created.map((c) => fsp.rm(path.join(filesDir, c.stored), { force: true })));
      }
      throw err;
    }
    if (!created.length) throw badRequest('No file received');
    bus.emit({ kind: 'files', actor });
    reply.code(201);
    return { files: created.map((c) => dto(get(c.id))) };
  });

  /** Creates a markdown/text document from JSON. */
  app.post<{ Body: { name: string; folderId?: number | null; content?: string } }>(
    '/api/v1/docs',
    {
      bodyLimit: MAX_DOC_BYTES + 64 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', maxLength: 255 }, folderId: { type: ['integer', 'null'], minimum: 1 }, content: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = access.current(req).id;
      let name = sanitizeName(nonEmpty(req.body.name, 'Name', 255));
      if (!path.extname(name)) name += '.md';
      const ext = path.extname(name).toLowerCase();
      if (!TEXT_EXT.has(ext)) throw badRequest('Documents must be a text type such as .md or .txt');
      const folderId = req.body.folderId ?? null;
      if (folderId !== null) assertFolder(folderId, pid);
      const content = req.body.content ?? '';
      const stored = crypto.randomUUID();
      await writeStored(filesDir, stored, content);
      const res = db
        .prepare('INSERT INTO files (project_id, folder_id, name, stored_name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(pid, folderId, name, stored, EXT_MIME[ext] ?? 'text/plain', Buffer.byteLength(content), actor);
      const id = Number(res.lastInsertRowid);
      bus.emit({ kind: 'files', id, actor });
      reply.code(201);
      return dto(get(id));
    },
  );

  /**
   * Replaces the content of a text document. Stored files are treated as immutable
   * (backups mirror them by name), so the new content goes to a new stored file.
   */
  app.put<{ Params: { id: string }; Body: { content: string } }>(
    '/api/v1/files/:id/content',
    {
      bodyLimit: MAX_DOC_BYTES + 64 * 1024,
      schema: { body: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const row = fileIn(req, req.params.id);
      if (!isTextFile(row)) throw badRequest('Only text documents can be edited');
      const content = req.body.content;
      if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw badRequest('Document is too large to edit in the browser (max 2 MB)');
      const stored = crypto.randomUUID();
      await writeStored(filesDir, stored, content);
      db.prepare('UPDATE files SET stored_name = ?, size = ?, updated_at = ? WHERE id = ?').run(stored, Buffer.byteLength(content), nowIso(), row.id);
      await fsp.rm(path.join(filesDir, row.stored_name), { force: true });
      bus.emit({ kind: 'files', id: row.id, actor });
      return dto(get(row.id));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/api/v1/files/:id/content', async (req, reply) => {
    const row = fileIn(req, req.params.id);
    const filePath = path.join(filesDir, row.stored_name);
    if (!fs.existsSync(filePath)) throw notFound('File content');
    const ext = path.extname(row.name).toLowerCase();
    const forceDownload = req.query.download === '1';
    let type = effectiveMime(row.name, row.mime);
    let inline = INLINE_SAFE.test(type);
    if (TEXT_EXT.has(ext) || row.mime.startsWith('text/')) {
      type = 'text/plain; charset=utf-8'; // never let uploaded HTML/SVG execute on this origin
      inline = true;
    }
    if (forceDownload || !inline) type = inline ? type : 'application/octet-stream';
    const disposition = forceDownload || !inline ? 'attachment' : 'inline';
    reply
      .header('Content-Type', type)
      .header('Content-Length', row.size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', type.startsWith('text/') ? 'no-cache' : 'private, max-age=3600')
      .header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    return reply.send(fs.createReadStream(filePath));
  });

  // ---- HTML / SVG preview (sandboxed; see SANDBOX_CSP) ---------------------------------

  /**
   * Finds the file a page refers to: "/api/v1/files/12/content" or ".../render" (images pasted in the editor)
   * or a path relative to the page's own explorer folder ("images/shot.png", "../shared/style.css").
   */
  const resolveResource = (url: string, page: FileRow): FileRow | undefined => {
    const pid = page.project_id; // only ever files from the page's own project
    const byId = /^\/api\/v1\/files\/(\d+)\/(?:content|render)(?:[?#].*)?$/.exec(url);
    if (byId) return db.prepare('SELECT * FROM files WHERE id = ? AND project_id = ?').get(Number(byId[1]), pid) as FileRow | undefined;
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.split(/[?#]/)[0]);
    } catch {
      return undefined;
    }
    const parts = decoded.split(/[\\/]/).filter((p) => p && p !== '.');
    const name = parts.pop();
    if (!name) return undefined;
    let folder = page.folder_id;
    for (const part of parts) {
      if (part === '..') {
        if (folder === null) return undefined;
        folder = (db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(folder) as { parent_id: number | null }).parent_id;
        continue;
      }
      const next = db
        .prepare('SELECT id FROM folders WHERE project_id = ? AND parent_id IS ? AND name = ? COLLATE NOCASE')
        .get(pid, folder, part) as { id: number } | undefined;
      if (!next) return undefined;
      folder = next.id;
    }
    return db
      .prepare('SELECT * FROM files WHERE project_id = ? AND folder_id IS ? AND name = ? COLLATE NOCASE')
      .get(pid, folder, name) as FileRow | undefined;
  };

  /**
   * Requests made from inside the sandbox carry no login cookie, so images, stylesheets and scripts the page
   * loads from the explorer are embedded into it as data: URIs (within size limits). Works on a latin1 view
   * of the bytes so the page's own encoding is preserved; `toText` recovers each URL's real characters.
   */
  const inlineResources = (html: string, page: FileRow, toText: (s: string) => string): string => {
    let budget = MAX_INLINE_TOTAL;
    const cache = new Map<number, string | null>();
    return html.replace(RESOURCE_RE, (whole, prefix: string, dq: string | undefined, sq: string | undefined) => {
      const target = resolveResource(toText((dq ?? sq ?? '').trim()), page);
      if (!target || target.id === page.id) return whole;
      let uri = cache.get(target.id);
      if (uri === undefined) {
        uri = null;
        const file = path.join(filesDir, target.stored_name);
        if (target.size <= MAX_INLINE_ONE && target.size <= budget && fs.existsSync(file)) {
          budget -= target.size;
          const ext = path.extname(target.name).toLowerCase();
          const mime = RESOURCE_MIME[ext] ?? effectiveMime(target.name, target.mime);
          uri = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
        }
        cache.set(target.id, uri);
      }
      if (!uri) return whole;
      const q = dq !== undefined ? '"' : "'";
      return `${prefix}${q}${uri}${q}`;
    });
  };

  /**
   * Points links to other uploaded pages (relative paths like "guide/setup.html#install", or
   * /api/v1/files/N/content|render) at their preview, and links to the page itself at just the #fragment.
   * Other links are left alone. Same latin1 view as inlineResources.
   */
  const rewritePageLinks = (html: string, page: FileRow, toText: (s: string) => string): string => {
    let linked = false;
    const out = html.replace(LINK_RE, (whole, prefix: string, dq: string | undefined, sq: string | undefined) => {
      const raw = (dq ?? sq ?? '').trim();
      const target = resolveResource(toText(raw), page);
      if (!target || !RENDER_EXT.has(path.extname(target.name).toLowerCase())) return whole;
      const hashAt = raw.indexOf('#');
      const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
      const q = dq !== undefined ? '"' : "'";
      if (target.id === page.id) return `${prefix}${q}${hash || '#'}${q}`;
      linked = true;
      return `${prefix}${q}/api/v1/files/${target.id}/render${hash}${q} data-pm-file="${target.id}"`;
    });
    if (!linked) return out;
    const bodyEnd = out.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
    return bodyEnd >= 0 ? out.slice(0, bodyEnd) + PAGE_NAV_SCRIPT + out.slice(bodyEnd) : out + PAGE_NAV_SCRIPT;
  };

  app.get<{ Params: { id: string } }>('/api/v1/files/:id/render', async (req, reply) => {
    const row = fileIn(req, req.params.id);
    const ext = path.extname(row.name).toLowerCase();
    if (!RENDER_EXT.has(ext)) throw badRequest('Only .html, .htm and .svg files can be previewed');
    if (row.size > MAX_RENDER_BYTES) throw badRequest('File is too large to preview (max 5 MB); download it instead');
    const filePath = path.join(filesDir, row.stored_name);
    if (!fs.existsSync(filePath)) throw notFound('File content');
    const raw = await fsp.readFile(filePath);
    let utf8 = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      utf8 = false; // e.g. an older Windows-1252 page: let its <meta charset> (or the browser) decide
    }
    const isSvg = ext === '.svg';
    const toText = (s: string) => (utf8 ? Buffer.from(s, 'latin1').toString('utf8') : s);
    const body = isSvg
      ? raw
      : Buffer.from(rewritePageLinks(inlineResources(raw.toString('latin1'), row, toText), row, toText), 'latin1');
    return reply
      .header('Content-Type', `${isSvg ? 'image/svg+xml' : 'text/html'}${utf8 ? '; charset=utf-8' : ''}`)
      .header('Content-Security-Policy', SANDBOX_CSP)
      .header('X-Frame-Options', 'SAMEORIGIN') // the app shows previews in an iframe
      .header('Cache-Control', 'no-cache')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      .send(body);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; folderId?: number | null } }>(
    '/api/v1/files/:id',
    {
      schema: {
        body: { type: 'object', properties: { name: { type: 'string', maxLength: 255 }, folderId: { type: ['integer', 'null'], minimum: 1 } } },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, project_id: pid } = fileIn(req, req.params.id);
      // Validate everything before writing anything, so a bad folder doesn't leave a half-applied rename.
      const name = req.body.name !== undefined ? sanitizeName(nonEmpty(req.body.name, 'Name', 255)) : undefined;
      const moving = has(req.body, 'folderId');
      const folderId = req.body.folderId ?? null;
      if (moving && folderId !== null) assertFolder(folderId, pid);
      tx(db, () => {
        if (name !== undefined) db.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), id);
        if (moving) db.prepare('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ?').run(folderId, nowIso(), id);
      });
      bus.emit({ kind: 'files', id, actor });
      return dto(get(id));
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/files/:id', async (req) => {
    const { actor } = requireAuth(req);
    const row = fileIn(req, req.params.id);
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    // Backups keep their own copy, so removing the live file is safe.
    await fsp.rm(path.join(filesDir, row.stored_name), { force: true });
    bus.emit({ kind: 'files', id: row.id, actor });
    return { ok: true };
  });
}

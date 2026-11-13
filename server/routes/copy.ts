import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { ProjectTable } from '../access.ts';
import type { DB } from '../db.ts';
import { tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { isTextFile } from './files.ts';
import { isDescendant } from './structure.ts';
import { createTask, keyOf } from './tasks.ts';

/**
 * Copies a folder (with everything in it), an epoch (with its tasks), a task (with its sub-tasks) or a file
 * into a folder, or a task into an epoch. Used by the Explorer's Copy / Paste and Duplicate.
 *
 * - Copied tasks get new keys and start in the first status, checklists unticked; time, comments, links and
 *   activity stay with the originals. A sub-task copied with its parent goes under the copy; one copied
 *   without it keeps its parent. Sub-tasks living in other epochs are copied too, into those epochs.
 * - Every file gets its own copy of the stored content. Links to /api/v1/files/<id> in copied documents and
 *   descriptions are pointed at the copies when the file they point at was copied too.
 * - Only the item copied is renamed, to "Name (copy)", and only when the name is taken where it lands.
 * - All or nothing: the stored files are copied first, the rows in one transaction, and the new stored files
 *   are removed again if anything fails.
 */

export const COPY_LIMITS = { items: 2000, bytes: 500 * 1024 * 1024 };

type Kind = 'folder' | 'epoch' | 'task' | 'file';
const TABLE: Record<Kind, ProjectTable> = { folder: 'folders', epoch: 'epochs', task: 'tasks', file: 'files' };
const LABEL: Record<Kind, string> = { folder: 'Folder', epoch: 'Epoch', task: 'Task', file: 'File' };

interface CopyBody {
  item: { kind: Kind; id: number };
  /** A folder (null: the top level; for tasks, the Inbox), or for tasks an epoch. */
  to: { folderId?: number | null; epochId?: number };
  /** Only count what would be created. */
  dryRun?: boolean;
}

interface FolderRow { id: number; parent_id: number | null; name: string; sort_order: number }
interface EpochRow {
  id: number; folder_id: number | null; name: string; description: string; color: string;
  target_date: string | null; estimate_minutes: number | null; sort_order: number;
}
interface TaskRow {
  id: number; epoch_id: number | null; folder_id: number | null; parent_id: number | null; title: string;
  description: string; type: string; priority: string; estimate_minutes: number | null;
}
interface FileRow { id: number; folder_id: number | null; name: string; stored_name: string; mime: string; size: number }

/** Where a task lives: an epoch, else a folder, else the Inbox. */
interface Place { epochId: number | null; folderId: number | null }

interface Plan { folders: FolderRow[]; epochs: EpochRow[]; tasks: TaskRow[]; files: FileRow[]; bytes: number }

const TASK_COLS = 'id, epoch_id, folder_id, parent_id, title, description, type, priority, estimate_minutes';
const FILE_COLS = 'id, folder_id, name, stored_name, mime, size';
/** Text files up to this size are read so their links to other copied files can be updated. */
const MAX_REWRITE_BYTES = 5 * 1024 * 1024;
const FILE_LINK = /(\/api\/v1\/files\/)(\d+)(?=[/?#"')\s\]]|$)/g;

const count = (p: Plan) => p.folders.length + p.epochs.length + p.tasks.length + p.files.length;

/** Everything a copy of `item` creates, parents before what is inside them. */
function collect(db: DB, pid: number, item: CopyBody['item']): Plan {
  const plan: Plan = { folders: [], epochs: [], tasks: [], files: [], bytes: 0 };
  const taskIds = new Set<number>();
  const addTasks = (rows: TaskRow[]) => {
    for (const t of rows) {
      if (taskIds.has(t.id)) continue;
      taskIds.add(t.id);
      plan.tasks.push(t);
    }
  };
  const tasksIn = (sql: string, id: number) =>
    db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE project_id = ? AND ${sql} ORDER BY sort_order, id`).all(pid, id) as unknown as TaskRow[];
  const epochsIn = (folderId: number) =>
    db.prepare('SELECT * FROM epochs WHERE project_id = ? AND folder_id = ? ORDER BY sort_order, id').all(pid, folderId) as unknown as EpochRow[];
  const tooMany = () => {
    if (count(plan) > COPY_LIMITS.items) {
      throw badRequest(`That is more than ${COPY_LIMITS.items.toLocaleString('en-US')} items, the most one copy can make. Copy a part of it at a time.`);
    }
  };

  if (item.kind === 'folder') {
    const queue = [db.prepare('SELECT id, parent_id, name, sort_order FROM folders WHERE id = ?').get(item.id) as unknown as FolderRow];
    while (queue.length) {
      const f = queue.shift()!;
      plan.folders.push(f);
      queue.push(
        ...(db.prepare('SELECT id, parent_id, name, sort_order FROM folders WHERE project_id = ? AND parent_id = ? ORDER BY sort_order, id').all(pid, f.id) as unknown as FolderRow[]),
      );
      for (const e of epochsIn(f.id)) {
        plan.epochs.push(e);
        addTasks(tasksIn('epoch_id = ?', e.id));
      }
      addTasks(tasksIn('epoch_id IS NULL AND folder_id = ?', f.id));
      plan.files.push(...(db.prepare(`SELECT ${FILE_COLS} FROM files WHERE project_id = ? AND folder_id = ? ORDER BY name, id`).all(pid, f.id) as unknown as FileRow[]));
      tooMany();
    }
  } else if (item.kind === 'epoch') {
    plan.epochs.push(db.prepare('SELECT * FROM epochs WHERE id = ?').get(item.id) as unknown as EpochRow);
    addTasks(tasksIn('epoch_id = ?', item.id));
  } else if (item.kind === 'task') {
    addTasks([db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).get(item.id) as unknown as TaskRow]);
  } else {
    plan.files.push(db.prepare(`SELECT ${FILE_COLS} FROM files WHERE id = ?`).get(item.id) as unknown as FileRow);
  }

  // Sub-tasks come along with their parents (one level only, so no deeper search).
  for (const t of [...plan.tasks]) addTasks(tasksIn('parent_id = ?', t.id));
  // Parents first: a sub-task copied with its parent is created after the parent's copy.
  plan.tasks.sort((a, b) => Number(a.parent_id !== null && taskIds.has(a.parent_id)) - Number(b.parent_id !== null && taskIds.has(b.parent_id)));
  tooMany();
  plan.bytes = plan.files.reduce((sum, f) => sum + f.size, 0);
  if (plan.bytes > COPY_LIMITS.bytes) {
    throw badRequest(`Its files add up to ${mb(plan.bytes)}, more than the ${mb(COPY_LIMITS.bytes)} one copy can hold. Copy a part of it at a time.`);
  }
  return plan;
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;

/** `name`, or "name (copy)", "name (copy 2)"… if `taken`. Files keep their extension at the end. */
function freeName(name: string, taken: (candidate: string) => boolean, max: number, keepExt = false): string {
  if (!taken(name)) return name;
  const ext = keepExt ? path.extname(name) : '';
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const suffix = ` (copy${i > 1 ? ` ${i}` : ''})${ext}`;
    const candidate = base.slice(0, Math.max(1, max - suffix.length)) + suffix;
    if (!taken(candidate)) return candidate;
  }
}

export function registerCopyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access, filesDir } = ctx;
  const deps = { db, access };

  app.post<{ Body: CopyBody }>(
    '/api/v1/copy',
    {
      schema: {
        body: {
          type: 'object',
          required: ['item', 'to'],
          properties: {
            item: {
              type: 'object',
              required: ['kind', 'id'],
              properties: { kind: { type: 'string', enum: ['folder', 'epoch', 'task', 'file'] }, id: { type: 'integer', minimum: 1 } },
            },
            to: { type: 'object', properties: { folderId: { type: ['integer', 'null'], minimum: 1 }, epochId: { type: 'integer', minimum: 1 } } },
            dryRun: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { item, to, dryRun } = req.body;
      const pid = access.of(req, TABLE[item.kind], item.id, `${LABEL[item.kind]} ${item.id}`).id;

      if ((to.epochId === undefined) === (to.folderId === undefined)) {
        throw badRequest('Say where the copy goes: "to": {"folderId": a folder id, or null for the top level} or, for a task, {"epochId": id}');
      }
      let dest: Place;
      if (to.epochId !== undefined) {
        if (item.kind !== 'task') throw badRequest('Only tasks can go inside an epoch');
        access.inProject('epochs', to.epochId, pid, `Epoch ${to.epochId}`);
        dest = { epochId: to.epochId, folderId: null };
      } else {
        const folderId = to.folderId ?? null;
        if (folderId !== null) access.inProject('folders', folderId, pid, `Folder ${folderId}`);
        if (item.kind === 'folder' && folderId !== null && isDescendant(db, item.id, folderId)) {
          throw badRequest("A folder can't be copied into itself or into a folder inside it");
        }
        dest = { epochId: null, folderId };
      }

      const plan = collect(db, pid, item);
      const taskById = new Map(plan.tasks.map((t) => [t.id, t]));
      const epochIds = new Set(plan.epochs.map((e) => e.id));
      const folderIds = new Set(plan.folders.map((f) => f.id));
      /** A sub-task in the same epoch or folder as its parent, which is copied too. */
      const withParent = (t: TaskRow) => {
        const parent = t.parent_id === null ? undefined : taskById.get(t.parent_id);
        return !!parent && parent.epoch_id === t.epoch_id && parent.folder_id === t.folder_id;
      };
      const inCopy = (t: TaskRow) => (t.epoch_id !== null ? epochIds.has(t.epoch_id) : t.folder_id !== null && folderIds.has(t.folder_id));
      const counts = {
        folders: plan.folders.length,
        epochs: plan.epochs.length,
        tasks: plan.tasks.length,
        files: plan.files.length,
        bytes: plan.bytes,
        // Sub-tasks living in another epoch or folder: their copies go there, under the parent's copy.
        subtasksElsewhere: plan.tasks.filter((t) => !(item.kind === 'task' && item.id === t.id) && !inCopy(t) && !withParent(t)).length,
      };
      if (dryRun) return { ok: true, dryRun: true, ...counts };

      // 1. Stored files, before any row exists. Text files that link to other copied files are written in the
      //    transaction instead, once the copies' ids are known.
      const created: string[] = [];
      const stored = new Map<number, string>();
      const relink = new Map<number, string>();
      const target = (name: string) => path.join(filesDir, name);
      try {
        for (const f of plan.files) {
          const name = crypto.randomUUID();
          created.push(name);
          stored.set(f.id, name);
          const src = target(f.stored_name);
          if (!fs.existsSync(src)) throw conflict(`The stored content of "${f.name}" is missing, so it can't be copied`);
          if (isTextFile(f) && f.size <= MAX_REWRITE_BYTES) {
            // Read as latin1, one character per byte, so every byte survives whatever the file's encoding
            // (a page saved as Windows-1252, say): the links themselves are plain ASCII.
            const text = (await fsp.readFile(src)).toString('latin1');
            if (new RegExp(FILE_LINK.source).test(text)) {
              relink.set(f.id, text);
              continue;
            }
          }
          // Under a temporary name until complete, so a backup never mirrors half a file.
          await fsp.copyFile(src, `${target(name)}.part`);
          await fsp.rename(`${target(name)}.part`, target(name));
        }

        // 2. Rows, all in one transaction.
        const top = tx(db, () => {
          // Checked again: the destination may have been deleted (and its id reused) while files were copied.
          if (dest.folderId !== null) access.inProject('folders', dest.folderId, pid, `Folder ${dest.folderId}`);
          if (dest.epochId !== null) access.inProject('epochs', dest.epochId, pid, `Epoch ${dest.epochId}`);
          const folders = new Map<number, number>();
          const epochs = new Map<number, number>();
          const files = new Map<number, number>();
          const tasks = new Map<number, number>();
          const places = new Map<number, Place>();
          const repoint = (text: string) =>
            text.replace(FILE_LINK, (m, prefix: string, id: string) => (files.has(Number(id)) ? `${prefix}${files.get(Number(id))}` : m));
          const isTop = (kind: Kind, id: number) => item.kind === kind && item.id === id;
          const nextOrder = (table: 'folders' | 'epochs', col: string, parent: number | null) =>
            ((db.prepare(`SELECT MAX(sort_order) AS m FROM ${table} WHERE project_id = ? AND ${col} IS ?`).get(pid, parent) as { m: number | null }).m ?? 0) + 1;
          let topItem = { kind: item.kind, id: 0, name: '' };

          for (const f of plan.folders) {
            const first = isTop('folder', f.id);
            const parent = first ? dest.folderId : folders.get(f.parent_id!)!;
            const name = first
              ? freeName(f.name, (n) => !!db.prepare('SELECT 1 FROM folders WHERE project_id = ? AND parent_id IS ? AND name = ? COLLATE NOCASE').get(pid, parent, n), 200)
              : f.name;
            const res = db
              .prepare('INSERT INTO folders (project_id, name, parent_id, sort_order) VALUES (?, ?, ?, ?)')
              .run(pid, name, parent, first ? nextOrder('folders', 'parent_id', parent) : f.sort_order);
            folders.set(f.id, Number(res.lastInsertRowid));
            if (first) topItem = { kind: 'folder', id: Number(res.lastInsertRowid), name };
          }

          for (const f of plan.files) {
            const first = isTop('file', f.id);
            const folder = first ? dest.folderId : folders.get(f.folder_id!)!;
            const name = first
              ? freeName(f.name, (n) => !!db.prepare('SELECT 1 FROM files WHERE project_id = ? AND folder_id IS ? AND name = ? COLLATE NOCASE').get(pid, folder, n), 255, true)
              : f.name;
            const res = db
              .prepare('INSERT INTO files (project_id, folder_id, name, stored_name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(pid, folder, name, stored.get(f.id)!, f.mime, f.size, actor);
            files.set(f.id, Number(res.lastInsertRowid));
            if (first) topItem = { kind: 'file', id: Number(res.lastInsertRowid), name };
          }
          // Now that every copy has an id, write the documents whose links point at other copies.
          for (const [id, text] of relink) {
            const content = Buffer.from(repoint(text), 'latin1');
            const file = target(stored.get(id)!);
            fs.writeFileSync(`${file}.part`, content);
            fs.renameSync(`${file}.part`, file);
            db.prepare('UPDATE files SET size = ? WHERE id = ?').run(content.length, files.get(id)!);
          }

          for (const e of plan.epochs) {
            const first = isTop('epoch', e.id);
            const folder = first ? dest.folderId : folders.get(e.folder_id!)!;
            const name = first
              ? freeName(e.name, (n) => !!db.prepare('SELECT 1 FROM epochs WHERE project_id = ? AND folder_id IS ? AND name = ? COLLATE NOCASE').get(pid, folder, n), 200)
              : e.name;
            const res = db
              .prepare(
                `INSERT INTO epochs (project_id, name, description, color, folder_id, target_date, estimate_minutes, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(pid, name, repoint(e.description), e.color, folder, e.target_date, e.estimate_minutes, first ? nextOrder('epochs', 'folder_id', folder) : e.sort_order);
            epochs.set(e.id, Number(res.lastInsertRowid));
            if (first) topItem = { kind: 'epoch', id: Number(res.lastInsertRowid), name };
          }

          const checklistOf = db.prepare('SELECT text FROM checklist_items WHERE task_id = ? ORDER BY sort_order, id');
          const categoriesOf = db.prepare('SELECT category_id FROM task_categories WHERE task_id = ?');
          for (const t of plan.tasks) {
            const first = isTop('task', t.id);
            const parentCopy = t.parent_id !== null ? tasks.get(t.parent_id) : undefined;
            let place: Place;
            if (t.epoch_id !== null && epochs.has(t.epoch_id)) place = { epochId: epochs.get(t.epoch_id)!, folderId: null };
            else if (t.epoch_id === null && t.folder_id !== null && folders.has(t.folder_id)) place = { epochId: null, folderId: folders.get(t.folder_id)! };
            else if (first) place = dest;
            // A sub-task that came with its parent: with the parent's copy if it lived with its parent, else where it was.
            else place = withParent(t) ? places.get(t.parent_id!)! : { epochId: t.epoch_id, folderId: t.folder_id };
            const title = first
              ? freeName(
                  t.title,
                  (n) =>
                    !!(place.epochId !== null
                      ? db.prepare('SELECT 1 FROM tasks WHERE project_id = ? AND epoch_id = ? AND title = ?').get(pid, place.epochId, n)
                      : db.prepare('SELECT 1 FROM tasks WHERE project_id = ? AND epoch_id IS NULL AND folder_id IS ? AND title = ?').get(pid, place.folderId, n)),
                  500,
                )
              : t.title;
            const id = createTask(
              deps,
              pid,
              actor,
              {
                title,
                description: repoint(t.description),
                type: t.type,
                priority: t.priority,
                epochId: place.epochId,
                folderId: place.folderId,
                estimateMinutes: t.estimate_minutes,
                categories: categoriesOf.all(t.id).map((r) => r.category_id as number),
                checklist: checklistOf.all(t.id).map((r) => r.text as string),
                // Under the parent's copy if that was copied too; otherwise the same parent as the original.
                parentId: parentCopy ?? t.parent_id,
              },
              // The parent's copy already says it is a copy; an original parent hears about its new sub-task.
              { how: `as a copy of ${keyOf(db, t.id)}`, noteOnParent: parentCopy === undefined },
            );
            tasks.set(t.id, id);
            places.set(t.id, place);
            if (first) topItem = { kind: 'task', id, name: title };
          }
          return topItem;
        });

        for (const [kind, n] of [['folders', counts.folders], ['files', counts.files], ['epochs', counts.epochs], ['tasks', counts.tasks]] as const) {
          if (n) bus.emit({ kind, actor, projectId: pid });
        }
        reply.code(201);
        return { ok: true, ...counts, item: top };
      } catch (err) {
        await Promise.all(created.flatMap((name) => [fsp.rm(target(name), { force: true }), fsp.rm(`${target(name)}.part`, { force: true })]));
        throw err;
      }
    },
  );
}

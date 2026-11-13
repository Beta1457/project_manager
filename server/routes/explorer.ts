import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { ProjectTable } from '../access.ts';
import type { DB } from '../db.ts';
import { tx } from '../db.ts';
import type { ChangeKind } from '../events.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { deleteFileRow, moveFile } from './files.ts';
import { deleteEpoch, deleteFolder, directTimeEntries, isDescendant, moveEpoch, moveFolder } from './structure.ts';
import { deleteTasks, updateTask } from './tasks.ts';

/**
 * Several Explorer items at once, of any kinds (folders, epochs, tasks and files): move them or delete them.
 * All or nothing: every item and the destination are checked before anything changes, and the changes run in
 * one transaction, so a refused or failed request changes nothing. Copying several at once is
 * POST /api/v1/copy with "items" (copy.ts), which shares the helpers here.
 */

export type Kind = 'folder' | 'epoch' | 'task' | 'file';
export interface ItemRef {
  kind: Kind;
  id: number;
}
/** An item and where it is. */
export interface Located extends ItemRef {
  name: string;
  /** Folders: their parent. Epochs and files: their folder. Tasks: their folder, when they aren't in an epoch. */
  folderId: number | null;
  /** Tasks: their epoch. */
  epochId: number | null;
  /** Tasks: their parent task. */
  parentId: number | null;
}

export const EXPLORER_MAX_ITEMS = 500;
const KINDS: Kind[] = ['folder', 'epoch', 'task', 'file'];
const TABLE: Record<Kind, ProjectTable> = { folder: 'folders', epoch: 'epochs', task: 'tasks', file: 'files' };
const LABEL: Record<Kind, string> = { folder: 'Folder', epoch: 'Epoch', task: 'Task', file: 'File' };
const EVENT: Record<Kind, ChangeKind> = { folder: 'folders', epoch: 'epochs', task: 'tasks', file: 'files' };

export const itemSchema = {
  type: 'object',
  required: ['kind', 'id'],
  properties: { kind: { type: 'string', enum: KINDS }, id: { type: 'integer', minimum: 1 } },
};
export const itemsSchema = { type: 'array', minItems: 1, maxItems: EXPLORER_MAX_ITEMS, items: itemSchema };

function locate(db: DB, { kind, id }: ItemRef): Located {
  if (kind === 'task') {
    const r = db.prepare('SELECT title, epoch_id, folder_id, parent_id FROM tasks WHERE id = ?').get(id) as {
      title: string; epoch_id: number | null; folder_id: number | null; parent_id: number | null;
    };
    return { kind, id, name: r.title, epochId: r.epoch_id, folderId: r.epoch_id === null ? r.folder_id : null, parentId: r.parent_id };
  }
  const sql =
    kind === 'folder' ? 'SELECT name, parent_id AS f FROM folders WHERE id = ?' : `SELECT name, folder_id AS f FROM ${TABLE[kind]} WHERE id = ?`;
  const r = db.prepare(sql).get(id) as { name: string; f: number | null };
  return { kind, id, name: r.name, folderId: r.f, epochId: null, parentId: null };
}

/** The items, each checked (it exists and the caller may see it), all in one project. Repeats are dropped. */
export function resolveItems(req: FastifyRequest, { db, access }: Pick<AppContext, 'db' | 'access'>, refs: ItemRef[]): { pid: number; items: Located[] } {
  const seen = new Set<string>();
  const items: Located[] = [];
  let pid: number | null = null;
  for (const ref of refs) {
    const key = `${ref.kind}-${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const project = access.of(req, TABLE[ref.kind], ref.id, `${LABEL[ref.kind]} ${ref.id}`);
    if (pid !== null && project.id !== pid) throw badRequest('All the items must be in one project');
    pid = project.id;
    items.push(locate(db, ref));
  }
  if (pid === null) throw badRequest('Send at least one item');
  return { pid, items };
}

/**
 * The items that aren't inside another of them. A folder takes everything in it along, and an epoch its tasks,
 * so what is inside them is left out (else a move would take it out of its folder, and a copy make it twice).
 * With `subtasks`, a task takes its sub-tasks along too: copies do, moves don't (a sub-task lives where it likes).
 */
export function outermost(db: DB, pid: number, items: Located[], opts: { subtasks: boolean }): Located[] {
  const folders = new Set(items.filter((i) => i.kind === 'folder').map((i) => i.id));
  const epochs = new Set(items.filter((i) => i.kind === 'epoch').map((i) => i.id));
  const tasks = new Set(items.filter((i) => i.kind === 'task').map((i) => i.id));
  if (!folders.size && !epochs.size && !(opts.subtasks && tasks.size > 1)) return items;
  const parentOf = new Map(
    (db.prepare('SELECT id, parent_id FROM folders WHERE project_id = ?').all(pid) as Array<{ id: number; parent_id: number | null }>).map(
      (r) => [r.id, r.parent_id],
    ),
  );
  const folderOfEpoch = new Map(
    (db.prepare('SELECT id, folder_id FROM epochs WHERE project_id = ?').all(pid) as Array<{ id: number; folder_id: number | null }>).map(
      (r) => [r.id, r.folder_id],
    ),
  );
  /** Whether folder `id`, or a folder it is in, is one of the items. */
  const inFolders = (id: number | null): boolean => {
    // At most one step per folder, so a loop in the data can't hang this.
    for (let cur = id, steps = 0; cur !== null && steps <= parentOf.size; cur = parentOf.get(cur) ?? null, steps++) {
      if (folders.has(cur)) return true;
    }
    return false;
  };
  /** Whether a task living here goes along with one of the items. */
  const taskCovered = (epochId: number | null, folderId: number | null) =>
    epochId !== null ? epochs.has(epochId) || inFolders(folderOfEpoch.get(epochId) ?? null) : inFolders(folderId);
  const placeOfTask = db.prepare('SELECT epoch_id, folder_id FROM tasks WHERE id = ?');
  return items.filter((i) => {
    if (i.kind !== 'task') return !inFolders(i.folderId);
    if (taskCovered(i.epochId, i.folderId)) return false;
    if (!opts.subtasks || i.parentId === null) return true;
    if (tasks.has(i.parentId)) return false;
    const parent = placeOfTask.get(i.parentId) as { epoch_id: number | null; folder_id: number | null } | undefined;
    return !parent || !taskCovered(parent.epoch_id, parent.epoch_id === null ? parent.folder_id : null);
  });
}

/** `"Art"`, `"Art" and "notes.md"`, `"Art", "notes.md" and 3 more`. */
function names(items: Array<{ name: string }>): string {
  const shown = items.slice(0, items.length > 3 ? 2 : 3).map((i) => `"${i.name}"`);
  if (items.length > shown.length) shown.push(`${items.length - shown.length} more`);
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

interface MoveBody {
  items: ItemRef[];
  /** A folder (null: the top level; for tasks, the Inbox), or for tasks only an epoch. */
  to: { folderId?: number | null; epochId?: number };
}

interface DeleteBody {
  items: ItemRef[];
  /** Also delete the sub-tasks of the tasks deleted (else those become top-level tasks). */
  withSubtasks?: boolean;
  /** Needed when an epoch has time logged directly on it, which is deleted with it. */
  deleteTime?: boolean;
}

export function registerExplorerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access, filesDir } = ctx;
  const emit = (kinds: Iterable<ChangeKind>, actor: string, projectId: number) => {
    for (const kind of new Set(kinds)) bus.emit({ kind, actor, projectId });
  };

  // Moves the items into one folder or, for tasks, one epoch. What is inside a folder or epoch that moves goes
  // with it; items already there stay where they are in the list.
  app.post<{ Body: MoveBody }>(
    '/api/v1/explorer/move',
    {
      schema: {
        body: {
          type: 'object',
          required: ['items', 'to'],
          properties: {
            items: itemsSchema,
            to: { type: 'object', properties: { folderId: { type: ['integer', 'null'], minimum: 1 }, epochId: { type: 'integer', minimum: 1 } } },
          },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { pid, items } = resolveItems(req, ctx, req.body.items);
      const { to } = req.body;
      if ((to.epochId === undefined) === (to.folderId === undefined)) {
        throw badRequest('Say where they go: "to": {"folderId": a folder id, or null for the top level} or, for tasks only, {"epochId": id}');
      }
      const epochId = to.epochId ?? null;
      const folderId = to.folderId ?? null;
      if (epochId !== null) {
        const others = items.filter((i) => i.kind !== 'task');
        if (others.length) throw badRequest(`Only tasks can go inside an epoch: ${names(others)} ${others.length === 1 ? "isn't a task" : "aren't tasks"}`);
        access.inProject('epochs', epochId, pid, `Epoch ${epochId}`);
      } else if (folderId !== null) access.inProject('folders', folderId, pid, `Folder ${folderId}`);

      const there = (i: Located) => (epochId !== null ? i.epochId === epochId : i.epochId === null && i.folderId === folderId);
      const moving = outermost(db, pid, items, { subtasks: false }).filter((i) => !there(i));
      for (const f of moving) {
        if (f.kind === 'folder' && folderId !== null && isDescendant(db, f.id, folderId)) {
          throw badRequest(`"${f.name}" can't go inside itself or a folder inside it`);
        }
      }
      tx(db, () => {
        for (const i of moving) {
          if (i.kind === 'folder') moveFolder(db, pid, i.id, folderId);
          else if (i.kind === 'epoch') moveEpoch(db, pid, i.id, folderId);
          else if (i.kind === 'file') moveFile(db, i.id, folderId);
          // Through the task code, so each task's activity says where it went.
          else updateTask(ctx, pid, i.id, actor, epochId !== null ? { epochId } : { folderId });
        }
      });
      emit(moving.map((i) => EVENT[i.kind]), actor, pid);
      return { ok: true, moved: moving.length };
    },
  );

  // Deletes the items, as deleting each one would: tasks and files for good; a folder's other contents move up to
  // its parent and an epoch's other tasks to its folder.
  app.post<{ Body: DeleteBody }>(
    '/api/v1/explorer/delete',
    {
      schema: {
        body: {
          type: 'object',
          required: ['items'],
          properties: { items: itemsSchema, withSubtasks: { type: 'boolean' }, deleteTime: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { pid, items } = resolveItems(req, ctx, req.body.items);
      const of = (kind: Kind) => items.filter((i) => i.kind === kind);
      const timed = of('epoch').filter((e) => directTimeEntries(db, e.id) > 0);
      if (timed.length && req.body.deleteTime !== true) {
        const one = timed.length === 1;
        throw conflict(
          `${one ? 'Epoch' : 'Epochs'} ${names(timed)} ${one ? 'has' : 'have'} time logged directly on ${one ? 'it' : 'them'}, ` +
            'which would be deleted too. Retry with "deleteTime": true to confirm.',
        );
      }

      const stored: string[] = [];
      const deleted = { folders: 0, epochs: 0, tasks: 0, files: 0 };
      const kinds = new Set<ChangeKind>();
      tx(db, () => {
        const taskIds = of('task').map((t) => t.id);
        if (taskIds.length) {
          deleted.tasks = deleteTasks(db, taskIds, actor, { withSubtasks: req.body.withSubtasks ?? false }).deleted.length;
          kinds.add('tasks');
        }
        for (const f of of('file')) {
          stored.push(deleteFileRow(db, f.id));
          deleted.files++;
          kinds.add('files');
        }
        for (const e of of('epoch')) {
          deleteEpoch(db, e.id);
          deleted.epochs++;
          kinds.add('epochs').add('tasks');
        }
        for (const f of of('folder')) {
          deleteFolder(db, f.id);
          deleted.folders++;
          for (const kind of ['folders', 'epochs', 'tasks', 'files'] as const) kinds.add(kind);
        }
      });
      if (timed.length) kinds.add('time');
      // The stored files go once the rows are gone for good.
      await Promise.all(stored.map((name) => fsp.rm(path.join(filesDir, name), { force: true })));
      emit(kinds, actor, pid);
      return { ok: true, deleted };
    },
  );
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DB } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { assertColor, has, nonEmpty, parseDuration, parseId } from '../lib/util.ts';
import { STATUSES } from '../lib/constants.ts';

const LOGGED_EXPR = `COALESCE(te.minutes, MAX(0, CAST(ROUND((julianday('now') - julianday(te.started_at)) * 1440) AS INTEGER)))`;

interface EpochRow {
  id: number;
  folder_id: number | null;
  name: string;
  description: string;
  color: string;
  target_date: string | null;
  estimate_minutes: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function epochDto(db: DB, row: EpochRow) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s.id, 0])) as Record<string, number>;
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE epoch_id = ? GROUP BY status').all(row.id)) {
    counts[r.status as string] = r.n as number;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const time = db
    .prepare(
      `SELECT
        (SELECT COALESCE(SUM(${LOGGED_EXPR}), 0) FROM time_entries te WHERE te.epoch_id = ?) AS direct,
        (SELECT COALESCE(SUM(${LOGGED_EXPR}), 0) FROM time_entries te JOIN tasks t ON t.id = te.task_id WHERE t.epoch_id = ?) AS tasks,
        (SELECT SUM(estimate_minutes) FROM tasks WHERE epoch_id = ?) AS task_estimates`,
    )
    .get(row.id, row.id, row.id) as { direct: number; tasks: number; task_estimates: number | null };
  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    description: row.description,
    color: row.color,
    targetDate: row.target_date,
    estimateMinutes: row.estimate_minutes,
    taskEstimateMinutes: time.task_estimates ?? 0,
    /** Time logged directly on the epoch plus time logged on its tasks. */
    loggedMinutes: time.direct + time.tasks,
    loggedDirectMinutes: time.direct,
    counts,
    total,
    shipped: counts.ready_to_ship,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getEpoch(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM epochs WHERE id = ?').get(id) as EpochRow | undefined;
  if (!row) throw notFound(`Epoch ${id}`);
  return epochDto(db, row);
}

/** True if `candidate` is `folderId` or one of its descendants. */
export function isDescendant(db: DB, folderId: number, candidate: number): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id)
       SELECT 1 FROM sub WHERE id = ?`,
    )
    .get(folderId, candidate);
  return !!row;
}

function nextOrder(db: DB, projectId: number, table: 'folders' | 'epochs', col: 'parent_id' | 'folder_id', parent: number | null): number {
  const r = db.prepare(`SELECT MAX(sort_order) AS m FROM ${table} WHERE project_id = ? AND ${col} IS ?`).get(projectId, parent) as {
    m: number | null;
  };
  return (r.m ?? 0) + 1;
}

// Moving and deleting folders and epochs: the routes here and the Explorer's bulk routes (explorer.ts) share
// these, so both follow the same rules. Callers check that the ids are in the project first.

/** Moves a folder into `parentId` (null: the top level), last in the list there. Not into itself or a folder inside it. */
export function moveFolder(db: DB, projectId: number, id: number, parentId: number | null): void {
  if (parentId !== null && isDescendant(db, id, parentId)) {
    throw badRequest('A folder cannot be moved into itself or one of its sub-folders');
  }
  db.prepare('UPDATE folders SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(
    parentId,
    nextOrder(db, projectId, 'folders', 'parent_id', parentId),
    nowIso(),
    id,
  );
}

/** Moves an epoch into `folderId` (null: the top level), last in the list there. */
export function moveEpoch(db: DB, projectId: number, id: number, folderId: number | null): void {
  db.prepare('UPDATE epochs SET folder_id = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(
    folderId,
    nextOrder(db, projectId, 'epochs', 'folder_id', folderId),
    nowIso(),
    id,
  );
}

/** Deletes a folder but nothing in it: what was inside moves up to its parent (tasks at the top level go to the Inbox). */
export function deleteFolder(db: DB, id: number): void {
  tx(db, () => {
    const { parent_id: parent } = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(id) as { parent_id: number | null };
    db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').run(parent, id);
    db.prepare('UPDATE epochs SET folder_id = ? WHERE folder_id = ?').run(parent, id);
    db.prepare('UPDATE tasks SET folder_id = ? WHERE folder_id = ?').run(parent, id);
    db.prepare('UPDATE files SET folder_id = ? WHERE folder_id = ?').run(parent, id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  });
}

/** How many time entries are logged directly on an epoch (not on its tasks): deleting the epoch deletes them. */
export function directTimeEntries(db: DB, epochId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE epoch_id = ?').get(epochId) as { n: number }).n;
}

/** Deletes an epoch but not its tasks: they move to the epoch's folder (or the Inbox). Time logged directly on it goes with it. */
export function deleteEpoch(db: DB, id: number): void {
  tx(db, () => {
    const { folder_id: folderId } = db.prepare('SELECT folder_id FROM epochs WHERE id = ?').get(id) as { folder_id: number | null };
    db.prepare('UPDATE tasks SET epoch_id = NULL, folder_id = ?, updated_at = ? WHERE epoch_id = ?').run(folderId, nowIso(), id);
    db.prepare('DELETE FROM epochs WHERE id = ?').run(id);
  });
}

interface EpochBody {
  name?: string;
  description?: string;
  color?: string;
  folderId?: number | null;
  targetDate?: string | null;
  estimateMinutes?: number | null;
  estimate?: string | number | null;
}

const epochProps = {
  name: { type: 'string', maxLength: 200 },
  description: { type: 'string', maxLength: 100000 },
  color: { type: 'string' },
  folderId: { type: ['integer', 'null'], minimum: 1 },
  targetDate: { type: ['string', 'null'] },
  estimateMinutes: { type: ['integer', 'null'], minimum: 0 },
  estimate: { type: ['string', 'number', 'null'] },
};

function parseDate(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest('targetDate must be YYYY-MM-DD');
  return v;
}

function estimateFrom(b: EpochBody): number | null {
  if (b.estimate != null && b.estimate !== '') return parseDuration(b.estimate);
  if (has(b, 'estimate')) return null;
  return b.estimateMinutes ?? null;
}

export function registerStructureRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access } = ctx;
  /** Folder ids in request bodies must be in the same project (null = the project's root). */
  const assertFolder = (id: number | null, projectId: number) => {
    if (id !== null) access.inProject('folders', id, projectId, `Folder ${id}`);
  };
  const epochIn = (req: FastifyRequest, raw: string) => {
    const id = parseId(raw, 'epoch');
    return { id, project: access.of(req, 'epochs', id, `Epoch ${id}`) };
  };
  const folderIn = (req: FastifyRequest, raw: string) => {
    const id = parseId(raw, 'folder');
    return { id, project: access.of(req, 'folders', id, `Folder ${id}`) };
  };

  // ---- Epochs ---------------------------------------------------------------

  app.get('/api/v1/epochs', async (req) => {
    const pid = access.current(req).id;
    const rows = db.prepare('SELECT * FROM epochs WHERE project_id = ? ORDER BY sort_order, id').all(pid) as unknown as EpochRow[];
    return { epochs: rows.map((r) => epochDto(db, r)) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/epochs/:id', async (req) => getEpoch(db, epochIn(req, req.params.id).id));

  app.post<{ Body: EpochBody }>(
    '/api/v1/epochs',
    { schema: { body: { type: 'object', required: ['name'], properties: epochProps } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = access.current(req).id;
      const b = req.body;
      const name = nonEmpty(b.name ?? '', 'Name', 200);
      const folderId = b.folderId ?? null;
      assertFolder(folderId, pid);
      const res = db
        .prepare(
          `INSERT INTO epochs (project_id, name, description, color, folder_id, target_date, estimate_minutes, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pid,
          name,
          b.description ?? '',
          b.color ? assertColor(b.color) : '#6366f1',
          folderId,
          parseDate(b.targetDate),
          estimateFrom(b),
          nextOrder(db, pid, 'epochs', 'folder_id', folderId),
        );
      const id = Number(res.lastInsertRowid);
      bus.emit({ kind: 'epochs', id, actor });
      reply.code(201);
      return getEpoch(db, id);
    },
  );

  app.patch<{ Params: { id: string }; Body: EpochBody }>(
    '/api/v1/epochs/:id',
    { schema: { body: { type: 'object', properties: epochProps } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, project } = epochIn(req, req.params.id);
      const b = req.body;
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      const set = (c: string, v: string | number | null) => {
        sets.push(`${c} = ?`);
        vals.push(v);
      };
      if (b.name !== undefined) set('name', nonEmpty(b.name, 'Name', 200));
      if (b.description !== undefined) set('description', b.description);
      if (b.color !== undefined) set('color', assertColor(b.color));
      if (has(b, 'targetDate')) set('target_date', parseDate(b.targetDate));
      if (has(b, 'estimate') || has(b, 'estimateMinutes')) set('estimate_minutes', estimateFrom(b));
      const moving = has(b, 'folderId');
      const folderId = b.folderId ?? null;
      if (moving) assertFolder(folderId, project.id);
      if (sets.length || moving) {
        tx(db, () => {
          if (sets.length) {
            set('updated_at', nowIso());
            db.prepare(`UPDATE epochs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
          }
          if (moving) moveEpoch(db, project.id, id, folderId);
        });
        bus.emit({ kind: 'epochs', id, actor });
      }
      return getEpoch(db, id);
    },
  );

  // Deleting an epoch never deletes tasks: they move to the epoch's folder.
  app.delete<{ Params: { id: string }; Querystring: { deleteTime?: string } }>('/api/v1/epochs/:id', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = epochIn(req, req.params.id);
    const epoch = getEpoch(db, id);
    // Tasks survive (they move to the epoch's folder), but time logged directly on the epoch has
    // nowhere to go and is deleted with it, so that must be asked for explicitly.
    const direct = directTimeEntries(db, id);
    if (direct > 0 && req.query.deleteTime !== 'true') {
      throw conflict(
        `Epoch "${epoch.name}" has ${direct} time entr${direct === 1 ? 'y' : 'ies'} (${epoch.loggedDirectMinutes} min) logged directly on it, ` +
          'which would be deleted too. Retry with ?deleteTime=true to confirm.',
      );
    }
    deleteEpoch(db, id);
    bus.emit({ kind: 'epochs', id, actor });
    bus.emit({ kind: 'tasks', actor });
    if (direct > 0) bus.emit({ kind: 'time', actor });
    return { ok: true };
  });

  // ---- Folders --------------------------------------------------------------

  const folderDto = (r: Record<string, unknown>) => ({
    id: r.id as number,
    parentId: r.parent_id as number | null,
    name: r.name as string,
    sortOrder: r.sort_order as number,
  });

  app.get('/api/v1/folders', async (req) => ({
    folders: db.prepare('SELECT * FROM folders WHERE project_id = ? ORDER BY sort_order, name').all(access.current(req).id).map(folderDto),
  }));

  app.post<{ Body: { name: string; parentId?: number | null } }>(
    '/api/v1/folders',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', maxLength: 200 }, parentId: { type: ['integer', 'null'], minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = access.current(req).id;
      const parentId = req.body.parentId ?? null;
      assertFolder(parentId, pid);
      const res = db
        .prepare('INSERT INTO folders (project_id, name, parent_id, sort_order) VALUES (?, ?, ?, ?)')
        .run(pid, nonEmpty(req.body.name, 'Name', 200), parentId, nextOrder(db, pid, 'folders', 'parent_id', parentId));
      const id = Number(res.lastInsertRowid);
      bus.emit({ kind: 'folders', id, actor });
      reply.code(201);
      return folderDto(db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>);
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; parentId?: number | null } }>(
    '/api/v1/folders/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: { name: { type: 'string', maxLength: 200 }, parentId: { type: ['integer', 'null'], minimum: 1 } },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, project } = folderIn(req, req.params.id);
      const b = req.body;
      // One transaction: a rejected move must not leave the rename half-applied.
      tx(db, () => {
        if (b.name !== undefined) {
          db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(nonEmpty(b.name, 'Name', 200), nowIso(), id);
        }
        if (has(b, 'parentId')) {
          const parentId = b.parentId ?? null;
          assertFolder(parentId, project.id);
          moveFolder(db, project.id, id, parentId);
        }
      });
      bus.emit({ kind: 'folders', id, actor });
      return folderDto(db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Record<string, unknown>);
    },
  );

  // Deleting a folder never deletes content: children move up to the parent folder.
  app.delete<{ Params: { id: string } }>('/api/v1/folders/:id', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = folderIn(req, req.params.id);
    deleteFolder(db, id);
    for (const kind of ['folders', 'epochs', 'tasks', 'files'] as const) bus.emit({ kind, actor });
    return { ok: true };
  });

  // ---- Tree (everything the explorer needs, in one request) ----------------

  app.get('/api/v1/tree', async (req) => {
    const pid = access.current(req).id;
    return {
      folders: db.prepare('SELECT * FROM folders WHERE project_id = ? ORDER BY sort_order, name').all(pid).map(folderDto),
      epochs: db
        .prepare(
          `SELECT e.id, e.name, e.color, e.folder_id AS folderId,
             (SELECT COUNT(*) FROM tasks t WHERE t.epoch_id = e.id) AS total,
             (SELECT COUNT(*) FROM tasks t WHERE t.epoch_id = e.id AND t.status = 'ready_to_ship') AS shipped
           FROM epochs e WHERE e.project_id = ? ORDER BY e.sort_order, e.id`,
        )
        .all(pid),
      tasks: db
        .prepare(
          `SELECT t.id, p.key || '-' || t.number AS key, t.title, t.status, t.type, t.folder_id AS folderId, t.epoch_id AS epochId, t.parent_id AS parentId
           FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.project_id = ? ORDER BY t.sort_order, t.id`,
        )
        .all(pid),
      files: db
        .prepare('SELECT id, name, mime, size, folder_id AS folderId, created_at AS createdAt FROM files WHERE project_id = ? ORDER BY name')
        .all(pid),
    };
  });
}

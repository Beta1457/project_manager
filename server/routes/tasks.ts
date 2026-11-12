import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DB } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { STATUSES, nextStatus, normalizePriority, normalizeStatus, statusLabel } from '../lib/constants.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { csv, has, nonEmpty, parseDuration, parseId, taskKey } from '../lib/util.ts';

// ---------------------------------------------------------------------------
// Data access. Nothing here checks who is asking: routes resolve tasks through ctx.access first.
// ---------------------------------------------------------------------------

interface TaskRow {
  id: number;
  project_id: number;
  project_key: string;
  number: number;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  epoch_id: number | null;
  epoch_name: string | null;
  epoch_color: string | null;
  folder_id: number | null;
  estimate_minutes: number | null;
  logged_minutes: number | null;
  timer_running: number;
  checklist_total: number;
  checklist_done: number;
  category_ids: string | null;
  open_blockers: number;
  sort_order: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CategoryRef {
  id: number;
  name: string;
  color: string;
}

// Running timers count elapsed time so far (never negative, even if the clock or a start time is off).
const LOGGED_EXPR = `COALESCE(minutes, MAX(0, CAST(ROUND((julianday('now') - julianday(started_at)) * 1440) AS INTEGER)))`;

/**
 * A blocker stops blocking once it reaches Alpha Complete (implemented and through alpha QA).
 * Status ids are fixed constants, so inlining them in SQL is safe.
 */
const UNRESOLVED_STATUSES = STATUSES.slice(0, STATUSES.findIndex((s) => s.id === 'alpha_complete'))
  .map((s) => `'${s.id}'`)
  .join(', ');

const TASK_SELECT = `
  SELECT t.*, p.key AS project_key, e.name AS epoch_name, e.color AS epoch_color,
    (SELECT COUNT(*) FROM task_links l JOIN tasks b ON b.id = l.source_id
      WHERE l.target_id = t.id AND l.kind = 'blocks' AND b.status IN (${UNRESOLVED_STATUSES})) AS open_blockers,
    (SELECT SUM(${LOGGED_EXPR}) FROM time_entries WHERE task_id = t.id) AS logged_minutes,
    EXISTS (SELECT 1 FROM time_entries WHERE task_id = t.id AND ended_at IS NULL AND minutes IS NULL) AS timer_running,
    (SELECT COUNT(*) FROM checklist_items WHERE task_id = t.id) AS checklist_total,
    (SELECT COUNT(*) FROM checklist_items WHERE task_id = t.id AND done = 1) AS checklist_done,
    (SELECT group_concat(category_id) FROM task_categories WHERE task_id = t.id) AS category_ids
  FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN epochs e ON e.id = t.epoch_id`;

function categoryMap(db: DB, projectId: number): Map<number, CategoryRef> {
  const rows = db.prepare('SELECT id, name, color FROM categories WHERE project_id = ?').all(projectId) as unknown as CategoryRef[];
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, color: r.color }]));
}

/** "BH-12" for a task id (for activity messages). */
export function keyOf(db: DB, id: number): string {
  const r = db.prepare('SELECT p.key, t.number FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(id) as
    | { key: string; number: number }
    | undefined;
  return r ? taskKey(r.key, r.number) : `#${id}`;
}

function toDto(row: TaskRow, cats: Map<number, CategoryRef>) {
  const categories = (row.category_ids ? row.category_ids.split(',').map(Number) : [])
    .map((id) => cats.get(id))
    .filter((c): c is CategoryRef => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: row.id,
    key: taskKey(row.project_key, row.number),
    number: row.number,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    statusLabel: statusLabel(row.status),
    priority: row.priority,
    epochId: row.epoch_id,
    epochName: row.epoch_name,
    epochColor: row.epoch_color,
    folderId: row.folder_id,
    estimateMinutes: row.estimate_minutes,
    loggedMinutes: row.logged_minutes ?? 0,
    timerRunning: !!row.timer_running,
    checklist: { done: row.checklist_done, total: row.checklist_total },
    /** Tasks that block this one and haven't reached Alpha Complete yet. */
    openBlockers: row.open_blockers,
    categories,
    sortOrder: row.sort_order,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type TaskDto = ReturnType<typeof toDto>;

export function getTask(db: DB, id: number): TaskDto {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  if (!row) throw notFound(`Task ${id}`);
  return toDto(row, categoryMap(db, row.project_id));
}

function getTaskDetail(db: DB, id: number) {
  const task = getTask(db, id);
  const checklist = db
    .prepare('SELECT id, text, done FROM checklist_items WHERE task_id = ? ORDER BY sort_order, id')
    .all(id)
    .map((r) => ({ id: r.id as number, text: r.text as string, done: !!r.done }));
  const activity = db
    .prepare('SELECT id, actor, kind, message, created_at AS createdAt FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 200')
    .all(id);
  return { ...task, checklistItems: checklist, links: getLinks(db, id), activity };
}

// ---- Task links ---------------------------------------------------------------

export type LinkKind = 'relates' | 'blocks' | 'duplicates';

/** How a link reads from one side: "T-3 blocks T-9" is "blocks T-9" on T-3 and "blocked by T-3" on T-9. */
function linkLabel(kind: LinkKind, outgoing: boolean): string {
  if (kind === 'blocks') return outgoing ? 'blocks' : 'blocked by';
  if (kind === 'duplicates') return outgoing ? 'duplicates' : 'duplicated by';
  return 'relates to';
}

const LINK_KINDS: Record<string, { kind: LinkKind; reverse: boolean }> = {
  relates: { kind: 'relates', reverse: false },
  relates_to: { kind: 'relates', reverse: false },
  related: { kind: 'relates', reverse: false },
  blocks: { kind: 'blocks', reverse: false },
  blocked_by: { kind: 'blocks', reverse: true },
  duplicates: { kind: 'duplicates', reverse: false },
  duplicated_by: { kind: 'duplicates', reverse: true },
};

/** Accepts "blocks", "blocked by", "Blocked-By", "relates to", ... */
function parseLinkKind(raw: string | undefined): { kind: LinkKind; reverse: boolean } {
  const k = (raw ?? 'relates').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const found = LINK_KINDS[k];
  if (!found) throw badRequest(`Unknown link type "${raw}". Use: relates, blocks, blocked_by, duplicates, duplicated_by`);
  return found;
}

function getLinks(db: DB, id: number) {
  const rows = db
    .prepare(
      `SELECT l.id, l.kind, l.source_id AS sourceId, o.id AS otherId, o.number, p.key AS projectKey, o.title, o.status, o.type
       FROM task_links l JOIN tasks o ON o.id = CASE WHEN l.source_id = ? THEN l.target_id ELSE l.source_id END
       JOIN projects p ON p.id = o.project_id
       WHERE l.source_id = ? OR l.target_id = ?
       ORDER BY CASE l.kind WHEN 'blocks' THEN 0 WHEN 'duplicates' THEN 1 ELSE 2 END, l.id`,
    )
    .all(id, id, id) as Array<{
    id: number;
    kind: LinkKind;
    sourceId: number;
    otherId: number;
    number: number;
    projectKey: string;
    title: string;
    status: string;
    type: string;
  }>;
  return rows.map((r) => {
    const outgoing = r.kind === 'relates' || r.sourceId === id;
    return {
      id: r.id,
      kind: r.kind,
      /** True when this task is the subject ("blocks", "duplicates"); always true for "relates". */
      outgoing,
      label: linkLabel(r.kind, outgoing),
      task: {
        id: r.otherId,
        key: taskKey(r.projectKey, r.number),
        title: r.title,
        status: r.status,
        statusLabel: statusLabel(r.status),
        type: r.type,
      },
    };
  });
}

export function logActivity(db: DB, taskId: number, actor: string, kind: string, message: string): void {
  db.prepare('INSERT INTO activity (task_id, actor, kind, message) VALUES (?, ?, ?, ?)').run(taskId, actor, kind, message);
}

const DESC_EDIT = 'updated description';
const MERGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Logs a field edit. The web editor autosaves the description every second or so while typing, so a
 * run of description-only saves by the same person collapses into one entry (its time is refreshed).
 */
function logEdit(db: DB, taskId: number, actor: string, message: string): void {
  if (message === DESC_EDIT) {
    const last = db
      .prepare('SELECT id, actor, kind, message, created_at FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as { id: number; actor: string; kind: string; message: string; created_at: string } | undefined;
    if (last && last.actor === actor && last.kind === 'edit' && last.message === DESC_EDIT && Date.now() - Date.parse(last.created_at) < MERGE_WINDOW_MS) {
      db.prepare('UPDATE activity SET created_at = ? WHERE id = ?').run(nowIso(), last.id);
      return;
    }
  }
  logActivity(db, taskId, actor, 'edit', message);
}

function touch(db: DB, id: number): void {
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

function resolveCategories(db: DB, projectId: number, input: Array<string | number>): number[] {
  const all = db.prepare('SELECT id, name FROM categories WHERE project_id = ?').all(projectId) as Array<{ id: number; name: string }>;
  const ids = new Set<number>();
  const unknown: string[] = [];
  for (const raw of input) {
    const s = String(raw).trim();
    if (!s) continue;
    const match = /^\d+$/.test(s)
      ? all.find((c) => c.id === Number(s))
      : all.find((c) => c.name.toLowerCase() === s.toLowerCase());
    if (match) ids.add(match.id);
    else unknown.push(s);
  }
  if (unknown.length) {
    throw badRequest(
      `Unknown categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}. ` +
        `Valid: ${all.map((c) => c.name).join(', ') || '(none yet)'}. Create new ones via POST /api/v1/categories.`,
    );
  }
  return [...ids];
}

function resolveType(db: DB, projectId: number, input: string): string {
  const row = db.prepare('SELECT name FROM task_types WHERE project_id = ? AND name = ?').get(projectId, input.trim()) as
    | { name: string }
    | undefined;
  if (!row) {
    const valid = db.prepare('SELECT name FROM task_types WHERE project_id = ? ORDER BY sort_order').all(projectId).map((r) => r.name);
    throw badRequest(`Unknown type "${input}". Valid: ${valid.join(', ')}`);
  }
  return row.name;
}

/** Type for tasks created without one: "Feature" if it still exists, else the first type in Settings order. */
function defaultType(db: DB, projectId: number): string {
  const row = (db.prepare("SELECT name FROM task_types WHERE project_id = ? AND name = 'Feature'").get(projectId) ??
    db.prepare('SELECT name FROM task_types WHERE project_id = ? ORDER BY sort_order, name LIMIT 1').get(projectId)) as
    | { name: string }
    | undefined;
  if (!row) throw badRequest('No task types exist. Add one in Settings first.');
  return row.name;
}

function resolveStatus(input: string): string {
  const s = normalizeStatus(input);
  if (!s) throw badRequest(`Unknown status "${input}". Valid: ${STATUSES.map((x) => x.label).join(', ')}`);
  return s;
}

function resolvePriority(input: string): string {
  const p = normalizePriority(input);
  if (!p) throw badRequest(`Unknown priority "${input}". Valid: low, medium, high, critical`);
  return p;
}

// Board order is kept per project and column.
function endOfColumn(db: DB, projectId: number, status: string, excludeId = 0): number {
  const r = db
    .prepare('SELECT MAX(sort_order) AS m FROM tasks WHERE project_id = ? AND status = ? AND id != ?')
    .get(projectId, status, excludeId) as { m: number | null };
  return (r.m ?? 0) + 1;
}

function renormalize(db: DB, projectId: number, status: string): void {
  const rows = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND status = ? ORDER BY sort_order, id').all(projectId, status);
  const upd = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(i + 1, r.id as number));
}

/** Places task `id` in `status`, directly before `beforeId` (or at the end). `beforeId` must be in the same project. */
function positionTask(db: DB, projectId: number, id: number, status: string, beforeId: number | null): void {
  let order: number;
  const before =
    beforeId && beforeId !== id
      ? (db.prepare('SELECT sort_order FROM tasks WHERE id = ? AND status = ? AND project_id = ?').get(beforeId, status, projectId) as
          | { sort_order: number }
          | undefined)
      : undefined;
  if (before) {
    const prev = db
      .prepare('SELECT MAX(sort_order) AS m FROM tasks WHERE project_id = ? AND status = ? AND sort_order < ? AND id != ?')
      .get(projectId, status, before.sort_order, id) as { m: number | null };
    order = prev.m === null ? before.sort_order - 1 : (prev.m + before.sort_order) / 2;
    if (prev.m !== null && before.sort_order - prev.m < 1e-6) {
      renormalize(db, projectId, status);
      return positionTask(db, projectId, id, status, beforeId);
    }
  } else {
    order = endOfColumn(db, projectId, status, id);
  }
  db.prepare('UPDATE tasks SET status = ?, sort_order = ? WHERE id = ?').run(status, order, id);
}

function changeStatus(db: DB, projectId: number, id: number, actor: string, status: string, note?: string): void {
  const cur = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string } | undefined;
  if (!cur) throw notFound(`Task ${id}`);
  if (cur.status !== status) {
    positionTask(db, projectId, id, status, null);
    logActivity(db, id, actor, 'status', `${statusLabel(cur.status)} → ${statusLabel(status)}${note ? `: ${note}` : ''}`);
  } else if (note) {
    logActivity(db, id, actor, 'comment', note);
  }
  touch(db, id);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface TaskBody {
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  epochId?: number | null;
  folderId?: number | null;
  estimateMinutes?: number | null;
  estimate?: string | number | null;
  categories?: Array<string | number>;
  checklist?: string[];
  note?: string;
}

const nullableInt = { type: ['integer', 'null'], minimum: 0 };
/** Optional reference to another row: positive id or null (0 would slip past truthiness checks). */
const nullableId = { type: ['integer', 'null'], minimum: 1 };
const taskBodyProps = {
  title: { type: 'string', maxLength: 500 },
  description: { type: 'string', maxLength: 200000 },
  type: { type: 'string' },
  status: { type: 'string' },
  priority: { type: 'string' },
  epochId: nullableId,
  folderId: nullableId,
  estimateMinutes: nullableInt,
  estimate: { type: ['string', 'number', 'null'] },
  categories: { type: 'array', items: { type: ['string', 'integer'] } },
  checklist: { type: 'array', items: { type: 'string' } },
  note: { type: 'string', maxLength: 20000 },
};

interface ListQuery {
  q?: string;
  status?: string;
  type?: string;
  category?: string;
  priority?: string;
  epoch?: string;
  folder?: string;
  createdBy?: string;
  limit?: number;
  /** "1" leaves out descriptions (the board and list never show them; saves re-downloading every task's markdown). */
  summary?: string;
}

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access } = ctx;
  const changed = (id: number, actor: string) => bus.emit({ kind: 'tasks', id, actor });

  app.get<{ Querystring: ListQuery }>('/api/v1/tasks', async (req) => {
    const project = access.current(req);
    const q = req.query;
    const where: string[] = ['t.project_id = ?'];
    const params: Array<string | number> = [project.id];
    let prefix = '';

    if (q.q) {
      const m = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(q.q.trim());
      if (m) {
        // A key from another project matches nothing here.
        where.push(m[1].toUpperCase() === project.key.toUpperCase() ? 't.number = ?' : '0 = ?');
        params.push(Number(m[2]));
      } else {
        where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')");
        const like = `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
        params.push(like, like);
      }
    }
    const inList = (col: string, values: string[]) => {
      where.push(`${col} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    };
    const statuses = csv(q.status).map(resolveStatus);
    if (statuses.length) inList('t.status', statuses);
    const types = csv(q.type);
    if (types.length) inList('t.type', types.map((t) => resolveType(db, project.id, t)));
    const priorities = csv(q.priority).map(resolvePriority);
    if (priorities.length) inList('t.priority', priorities);
    const creators = csv(q.createdBy);
    if (creators.length) inList('t.created_by', creators);
    const cats = csv(q.category);
    if (cats.length) {
      const ids = resolveCategories(db, project.id, cats);
      where.push(`EXISTS (SELECT 1 FROM task_categories tc WHERE tc.task_id = t.id AND tc.category_id IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    }
    if (q.epoch) {
      if (q.epoch === 'none') where.push('t.epoch_id IS NULL');
      else {
        where.push('t.epoch_id = ?');
        params.push(parseId(q.epoch, 'epoch'));
      }
    }
    if (q.folder) {
      if (q.folder === 'inbox') where.push('t.folder_id IS NULL AND t.epoch_id IS NULL');
      else {
        // Includes tasks in sub-folders and in epochs that live in those folders.
        prefix = 'WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) ';
        params.unshift(parseId(q.folder, 'folder'));
        where.push('(t.folder_id IN (SELECT id FROM sub) OR e.folder_id IN (SELECT id FROM sub))');
      }
    }
    const limit = Math.min(Math.max(Number(q.limit) || 1000, 1), 5000);
    const sql = `${prefix}${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.sort_order, t.id LIMIT ${limit}`;
    const rows = db.prepare(sql).all(...params) as unknown as TaskRow[];
    const map = categoryMap(db, project.id);
    const tasks = rows.map((r) => toDto(r, map));
    if (q.summary === '1') for (const t of tasks) (t as { description?: string }).description = undefined;
    return { tasks };
  });

  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id', async (req) => getTaskDetail(db, access.task(req, req.params.id).id));

  app.post<{ Body: TaskBody }>(
    '/api/v1/tasks',
    { schema: { body: { type: 'object', required: ['title'], properties: taskBodyProps } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = access.current(req).id;
      const b = req.body;
      const id = tx(db, () => {
        const title = nonEmpty(b.title ?? '', 'Title');
        const type = b.type ? resolveType(db, pid, b.type) : defaultType(db, pid);
        const status = b.status ? resolveStatus(b.status) : 'open';
        const priority = b.priority ? resolvePriority(b.priority) : 'medium';
        const epochId = b.epochId ?? null;
        const folderId = epochId ? null : (b.folderId ?? null);
        if (epochId) access.inProject('epochs', epochId, pid, `Epoch ${epochId}`);
        if (folderId) access.inProject('folders', folderId, pid, `Folder ${folderId}`);
        const estimate =
          b.estimate != null && b.estimate !== '' ? parseDuration(b.estimate) : (b.estimateMinutes ?? null);
        const catIds = b.categories ? resolveCategories(db, pid, b.categories) : [];
        // Ids and numbers come from counters that never go down (migrations v3 and v5): task keys are quoted in
        // commits and notes, so a deleted task's key must not come back. The MAX() guards also cover rows that
        // arrived some other way, e.g. a database restored from an older backup.
        const { last: id } = db
          .prepare(
            `UPDATE id_counters SET last = MAX(last, (SELECT COALESCE(MAX(id), 0) FROM tasks)) + 1
             WHERE name = 'tasks' RETURNING last`,
          )
          .get() as { last: number };
        const counter = `tasks:${pid}`;
        db.prepare('INSERT INTO id_counters (name, last) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(counter);
        const { last: number } = db
          .prepare(
            `UPDATE id_counters SET last = MAX(last, (SELECT COALESCE(MAX(number), 0) FROM tasks WHERE project_id = ?)) + 1
             WHERE name = ? RETURNING last`,
          )
          .get(pid, counter) as { last: number };
        db.prepare(
          `INSERT INTO tasks (id, project_id, number, title, description, type, status, priority, epoch_id, folder_id, estimate_minutes, sort_order, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, pid, number, title, b.description ?? '', type, status, priority, epochId, folderId, estimate, endOfColumn(db, pid, status), actor);
        const addCat = db.prepare('INSERT INTO task_categories (task_id, category_id) VALUES (?, ?)');
        for (const c of catIds) addCat.run(id, c);
        const addItem = db.prepare('INSERT INTO checklist_items (task_id, text, sort_order) VALUES (?, ?, ?)');
        (b.checklist ?? []).forEach((text, i) => {
          if (text.trim()) addItem.run(id, text.trim(), i + 1);
        });
        logActivity(db, id, actor, 'created', `Created in ${statusLabel(status)}${b.note ? `: ${b.note}` : ''}`);
        return id;
      });
      changed(id, actor);
      reply.code(201);
      return getTaskDetail(db, id);
    },
  );

  app.patch<{ Params: { id: string }; Body: TaskBody }>(
    '/api/v1/tasks/:id',
    { schema: { body: { type: 'object', properties: taskBodyProps } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, project } = access.task(req, req.params.id);
      const pid = project.id;
      const b = req.body;
      tx(db, () => {
        const cur = getTask(db, id);
        const sets: string[] = [];
        const vals: Array<string | number | null> = [];
        const changes: string[] = [];
        const set = (col: string, val: string | number | null) => {
          sets.push(`${col} = ?`);
          vals.push(val);
        };

        if (b.title !== undefined) {
          const title = nonEmpty(b.title, 'Title');
          if (title !== cur.title) {
            set('title', title);
            changes.push(`renamed to "${title}"`);
          }
        }
        if (b.description !== undefined && b.description !== cur.description) {
          set('description', b.description);
          changes.push(DESC_EDIT);
        }
        if (b.type !== undefined) {
          const type = resolveType(db, pid, b.type);
          if (type !== cur.type) {
            set('type', type);
            changes.push(`type ${cur.type} → ${type}`);
          }
        }
        if (b.priority !== undefined) {
          const p = resolvePriority(b.priority);
          if (p !== cur.priority) {
            set('priority', p);
            changes.push(`priority ${cur.priority} → ${p}`);
          }
        }
        if (has(b, 'estimate') || has(b, 'estimateMinutes')) {
          const est =
            b.estimate != null && b.estimate !== ''
              ? parseDuration(b.estimate)
              : has(b, 'estimate')
                ? null
                : (b.estimateMinutes ?? null);
          if (est !== cur.estimateMinutes) {
            set('estimate_minutes', est);
            changes.push(est == null ? 'cleared estimate' : `estimate ${est}m`);
          }
        }
        // Location: an epoch takes precedence; setting a folder removes the task from its epoch.
        if (has(b, 'epochId') && b.epochId != null) {
          if (b.epochId !== cur.epochId) {
            access.inProject('epochs', b.epochId, pid, `Epoch ${b.epochId}`);
            set('epoch_id', b.epochId);
            set('folder_id', null);
            const name = (db.prepare('SELECT name FROM epochs WHERE id = ?').get(b.epochId) as { name: string }).name;
            changes.push(`moved to epoch "${name}"`);
          }
        } else if (has(b, 'folderId')) {
          const folderId = b.folderId ?? null;
          if (folderId) access.inProject('folders', folderId, pid, `Folder ${folderId}`);
          if (folderId !== cur.folderId || cur.epochId !== null) {
            set('folder_id', folderId);
            set('epoch_id', null);
            changes.push(folderId ? 'moved to folder' : 'moved to inbox');
          }
        } else if (has(b, 'epochId') && b.epochId === null && cur.epochId !== null) {
          set('epoch_id', null);
          changes.push('removed from epoch');
        }

        if (sets.length) {
          set('updated_at', nowIso());
          db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
          logEdit(db, id, actor, changes.join('; '));
        }
        if (b.categories !== undefined) {
          const ids = resolveCategories(db, pid, b.categories);
          const before = cur.categories.map((c) => c.id).sort().join(',');
          if ([...ids].sort().join(',') !== before) {
            db.prepare('DELETE FROM task_categories WHERE task_id = ?').run(id);
            const add = db.prepare('INSERT INTO task_categories (task_id, category_id) VALUES (?, ?)');
            for (const c of ids) add.run(id, c);
            const names = db
              .prepare(`SELECT name FROM categories WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`)
              .all(...ids)
              .map((r) => r.name);
            logActivity(db, id, actor, 'edit', `categories: ${names.join(', ') || 'none'}`);
            touch(db, id);
          }
        }
        if (b.status !== undefined) changeStatus(db, pid, id, actor, resolveStatus(b.status), b.note);
        else if (b.note) logActivity(db, id, actor, 'comment', b.note);
      });
      changed(id, actor);
      return getTaskDetail(db, id);
    },
  );

  // Board drag & drop: put the task in `status` before `beforeId` (null = end of column).
  app.post<{ Params: { id: string }; Body: { status: string; beforeId?: number | null } }>(
    '/api/v1/tasks/:id/move',
    {
      schema: {
        body: { type: 'object', required: ['status'], properties: { status: { type: 'string' }, beforeId: nullableId } },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, project } = access.task(req, req.params.id);
      const status = resolveStatus(req.body.status);
      tx(db, () => {
        const cur = getTask(db, id);
        positionTask(db, project.id, id, status, req.body.beforeId ?? null);
        if (cur.status !== status) {
          logActivity(db, id, actor, 'status', `${statusLabel(cur.status)} → ${statusLabel(status)}`);
        }
        touch(db, id);
      });
      changed(id, actor);
      return getTask(db, id);
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/api/v1/tasks/:id/advance',
    { schema: { body: { type: ['object', 'null'], properties: { note: { type: 'string' } } } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, project } = access.task(req, req.params.id);
      tx(db, () => {
        const cur = getTask(db, id);
        const next = nextStatus(cur.status);
        if (!next) throw badRequest(`${cur.key} is already in the final status (${cur.statusLabel})`);
        changeStatus(db, project.id, id, actor, next, req.body?.note);
      });
      changed(id, actor);
      return getTask(db, id);
    },
  );

  app.post<{ Params: { id: string }; Body: { status: string; note?: string } }>(
    '/api/v1/tasks/:id/status',
    {
      schema: {
        body: { type: 'object', required: ['status'], properties: { status: { type: 'string' }, note: { type: 'string' } } },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, project } = access.task(req, req.params.id);
      const status = resolveStatus(req.body.status);
      tx(db, () => changeStatus(db, project.id, id, actor, status, req.body.note));
      changed(id, actor);
      return getTask(db, id);
    },
  );

  app.post<{ Params: { id: string }; Body: { message: string } }>(
    '/api/v1/tasks/:id/comments',
    {
      schema: {
        body: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 20000 } } },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { id } = access.task(req, req.params.id);
      logActivity(db, id, actor, 'comment', nonEmpty(req.body.message, 'Message', 20000));
      touch(db, id);
      changed(id, actor);
      reply.code(201);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/tasks/:id', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = access.task(req, req.params.id);
    const linked = tx(db, () => {
      const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string };
      const key = keyOf(db, id);
      // Links go with the task (ON DELETE CASCADE); leave a trace on the tasks it was linked to.
      const others = (
        db
          .prepare('SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS other FROM task_links WHERE source_id = ? OR target_id = ?')
          .all(id, id, id) as Array<{ other: number }>
      ).map((r) => r.other);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      for (const o of others) logActivity(db, o, actor, 'link', `Removed link: ${key} "${task.title}" was deleted`);
      return others;
    });
    changed(id, actor);
    for (const o of linked) changed(o, actor);
    return { ok: true };
  });

  // ---- Checklist ----------------------------------------------------------

  /** A checklist item, if the caller may see its task. */
  const checklistItem = (req: FastifyRequest, raw: string) => {
    const itemId = parseId(raw, 'checklist item');
    const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(itemId) as
      | { id: number; task_id: number; text: string; done: number }
      | undefined;
    if (!item) throw notFound('Checklist item');
    try {
      access.task(req, item.task_id);
    } catch {
      throw notFound('Checklist item');
    }
    return item;
  };

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/api/v1/tasks/:id/checklist',
    { schema: { body: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 1000 } } } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { id } = access.task(req, req.params.id);
      const text = nonEmpty(req.body.text, 'Text', 1000);
      const max = db.prepare('SELECT MAX(sort_order) AS m FROM checklist_items WHERE task_id = ?').get(id) as { m: number | null };
      const res = db
        .prepare('INSERT INTO checklist_items (task_id, text, sort_order) VALUES (?, ?, ?)')
        .run(id, text, (max.m ?? 0) + 1);
      touch(db, id);
      changed(id, actor);
      reply.code(201);
      return { id: Number(res.lastInsertRowid), text, done: false };
    },
  );

  app.patch<{ Params: { itemId: string }; Body: { text?: string; done?: boolean } }>(
    '/api/v1/checklist/:itemId',
    {
      schema: {
        body: { type: 'object', properties: { text: { type: 'string', maxLength: 1000 }, done: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const item = checklistItem(req, req.params.itemId);
      const text = req.body.text !== undefined ? nonEmpty(req.body.text, 'Text', 1000) : item.text;
      const done = req.body.done !== undefined ? req.body.done : !!item.done;
      db.prepare('UPDATE checklist_items SET text = ?, done = ? WHERE id = ?').run(text, done ? 1 : 0, item.id);
      if (req.body.done !== undefined && req.body.done !== !!item.done) {
        logActivity(db, item.task_id, actor, 'checklist', `${done ? 'Checked' : 'Unchecked'} "${text}"`);
      }
      touch(db, item.task_id);
      changed(item.task_id, actor);
      return { id: item.id, text, done };
    },
  );

  app.delete<{ Params: { itemId: string } }>('/api/v1/checklist/:itemId', async (req) => {
    const { actor } = requireAuth(req);
    const item = checklistItem(req, req.params.itemId);
    db.prepare('DELETE FROM checklist_items WHERE id = ?').run(item.id);
    touch(db, item.task_id);
    changed(item.task_id, actor);
    return { ok: true };
  });

  // ---- Links between tasks (within one project) ----------------------------------

  const linkBetween = (a: number, b: number) =>
    db
      .prepare('SELECT id, kind, source_id, target_id FROM task_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)')
      .get(a, b, b, a) as { id: number; kind: LinkKind; source_id: number; target_id: number } | undefined;
  const describe = (kind: LinkKind, source: number, target: number) => `${keyOf(db, source)} ${linkLabel(kind, true)} ${keyOf(db, target)}`;

  app.post<{ Params: { id: string }; Body: { task: string | number; kind?: string } }>(
    '/api/v1/tasks/:id/links',
    {
      schema: {
        body: {
          type: 'object',
          required: ['task'],
          properties: { task: { type: ['string', 'integer'] }, kind: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const a = access.task(req, req.params.id);
      const b = access.task(req, req.body.task);
      const [id, other] = [a.id, b.id];
      const { kind, reverse } = parseLinkKind(req.body.kind);
      if (other === id) throw badRequest('A task cannot be linked to itself');
      if (a.project.id !== b.project.id) throw badRequest('Tasks in different projects cannot be linked');
      tx(db, () => {
        const existing = linkBetween(id, other);
        if (existing) {
          throw conflict(`Already linked: ${describe(existing.kind, existing.source_id, existing.target_id)}. Remove that link first to change it.`);
        }
        // "relates" has no direction: store it one canonical way round.
        let [source, target] = reverse ? [other, id] : [id, other];
        if (kind === 'relates' && source > target) [source, target] = [target, source];
        db.prepare('INSERT INTO task_links (source_id, target_id, kind, created_by) VALUES (?, ?, ?, ?)').run(source, target, kind, actor);
        const text = describe(kind, source, target);
        logActivity(db, id, actor, 'link', `Linked: ${text}`);
        logActivity(db, other, actor, 'link', `Linked: ${text}`);
        touch(db, id);
        touch(db, other);
      });
      changed(id, actor);
      changed(other, actor);
      reply.code(201);
      return getTaskDetail(db, id);
    },
  );

  // The other task identifies the link: there is at most one link per pair of tasks.
  app.delete<{ Params: { id: string; other: string } }>('/api/v1/tasks/:id/links/:other', async (req) => {
    const { actor } = requireAuth(req);
    const id = access.task(req, req.params.id).id;
    const other = access.task(req, req.params.other).id;
    tx(db, () => {
      const link = linkBetween(id, other);
      if (!link) throw notFound(`Link between ${keyOf(db, id)} and ${keyOf(db, other)}`);
      db.prepare('DELETE FROM task_links WHERE id = ?').run(link.id);
      const text = describe(link.kind, link.source_id, link.target_id);
      logActivity(db, id, actor, 'link', `Removed link: ${text}`);
      logActivity(db, other, actor, 'link', `Removed link: ${text}`);
      touch(db, id);
      touch(db, other);
    });
    changed(id, actor);
    changed(other, actor);
    return getTaskDetail(db, id);
  });
}

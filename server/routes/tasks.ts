import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { Access } from '../access.ts';
import type { DB } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { STATUSES, nextStatus, normalizePriority, normalizeStatus, statusLabel } from '../lib/constants.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { csv, has, nonEmpty, parseDuration, parseId, taskKey } from '../lib/util.ts';
import { parseTemplateData, type TemplateData } from './templates.ts';

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
  parent_id: number | null;
  parent_number: number | null;
  parent_title: string | null;
  subtask_total: number;
  subtask_done: number;
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
    pt.number AS parent_number, pt.title AS parent_title,
    (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS subtask_total,
    (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.status NOT IN (${UNRESOLVED_STATUSES})) AS subtask_done,
    (SELECT COUNT(*) FROM task_links l JOIN tasks b ON b.id = l.source_id
      WHERE l.target_id = t.id AND l.kind = 'blocks' AND b.status IN (${UNRESOLVED_STATUSES})) AS open_blockers,
    (SELECT SUM(${LOGGED_EXPR}) FROM time_entries WHERE task_id = t.id) AS logged_minutes,
    EXISTS (SELECT 1 FROM time_entries WHERE task_id = t.id AND ended_at IS NULL AND minutes IS NULL) AS timer_running,
    (SELECT COUNT(*) FROM checklist_items WHERE task_id = t.id) AS checklist_total,
    (SELECT COUNT(*) FROM checklist_items WHERE task_id = t.id AND done = 1) AS checklist_done,
    (SELECT group_concat(category_id) FROM task_categories WHERE task_id = t.id) AS category_ids
  FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN epochs e ON e.id = t.epoch_id
    LEFT JOIN tasks pt ON pt.id = t.parent_id`;

function categoryMap(db: DB, projectId: number): Map<number, CategoryRef> {
  const rows = db.prepare('SELECT id, name, color FROM categories WHERE project_id = ?').all(projectId) as unknown as CategoryRef[];
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, color: r.color }]));
}

/** "APP-12" for a task id (for activity messages). */
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
    /** The task this one is a sub-task of (always in the same project), or null. */
    parentId: row.parent_id,
    parent:
      row.parent_id !== null && row.parent_number !== null
        ? { id: row.parent_id, key: taskKey(row.project_key, row.parent_number), title: row.parent_title ?? '' }
        : null,
    /** This task's sub-tasks; "done" counts those at Alpha Complete or later (the rule blockers use). */
    subtasks: { done: row.subtask_done, total: row.subtask_total },
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

/** A task's sub-tasks in the order they were created, without descriptions. */
function getChildren(db: DB, id: number, projectId: number): TaskDto[] {
  const rows = db.prepare(`${TASK_SELECT} WHERE t.parent_id = ? ORDER BY t.number`).all(id) as unknown as TaskRow[];
  const cats = categoryMap(db, projectId);
  return rows.map((r) => {
    const dto = toDto(r, cats);
    (dto as { description?: string }).description = undefined;
    return dto;
  });
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
  return { ...task, checklistItems: checklist, links: getLinks(db, id), children: getChildren(db, id, task.projectId), activity };
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

/**
 * Checks that task `parentId` can take task `childId` (null for a task being created) as a sub-task: same
 * project, not itself, and one level only. Returns the parent's key for activity messages.
 */
function checkParent(db: DB, projectId: number, childId: number | null, parentId: number): string {
  const p = db.prepare('SELECT project_id, parent_id FROM tasks WHERE id = ?').get(parentId) as
    | { project_id: number; parent_id: number | null }
    | undefined;
  if (!p) throw notFound(`Task ${parentId}`);
  if (p.project_id !== projectId) throw badRequest('A sub-task must be in the same project as its parent');
  if (childId === parentId) throw badRequest('A task cannot be its own parent');
  const key = keyOf(db, parentId);
  if (p.parent_id !== null) {
    throw badRequest(`${key} is a sub-task of ${keyOf(db, p.parent_id)}. Sub-tasks can't have sub-tasks of their own.`);
  }
  if (childId !== null && db.prepare('SELECT 1 FROM tasks WHERE parent_id = ?').get(childId)) {
    throw badRequest(`${keyOf(db, childId)} has sub-tasks of its own, so it can't become a sub-task`);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Creating and changing tasks. Shared by the routes below, templates, bulk actions and copies: the caller
// checks access to the task itself, and ids inside the input (epoch, folder, parent) are checked here.
// ---------------------------------------------------------------------------

export interface TaskInput {
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
  /** The parent task's id (null: a top-level task). Routes resolve a key or id to this after an access check. */
  parentId?: number | null;
}

export interface TaskDeps {
  db: DB;
  access: Access;
}

export interface CreateOptions {
  /** Says where the task came from in its first activity entry: "Created in Open from the template "Card"". */
  how?: string;
  /** False: no "Added sub-task" note on the parent (its own first entry already says what it came with). */
  noteOnParent?: boolean;
}

/** Creates a task in project `pid` and returns its id. Joins the caller's transaction, if there is one. */
export function createTask({ db, access }: TaskDeps, pid: number, actor: string, b: TaskInput, opts: CreateOptions = {}): number {
  return tx(db, () => {
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
    const parentId = b.parentId ?? null;
    const parentKey = parentId ? checkParent(db, pid, null, parentId) : null;
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
      `INSERT INTO tasks (id, project_id, number, title, description, type, status, priority, epoch_id, folder_id, parent_id, estimate_minutes, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, pid, number, title, b.description ?? '', type, status, priority, epochId, folderId, parentId, estimate, endOfColumn(db, pid, status), actor);
    const addCat = db.prepare('INSERT INTO task_categories (task_id, category_id) VALUES (?, ?)');
    for (const c of catIds) addCat.run(id, c);
    const addItem = db.prepare('INSERT INTO checklist_items (task_id, text, sort_order) VALUES (?, ?, ?)');
    (b.checklist ?? []).forEach((text, i) => {
      if (text.trim()) addItem.run(id, text.trim(), i + 1);
    });
    const how = opts.how ? ` ${opts.how}` : '';
    const asSubtask = parentKey ? ` as a sub-task of ${parentKey}` : '';
    logActivity(db, id, actor, 'created', `Created in ${statusLabel(status)}${how}${asSubtask}${b.note ? `: ${b.note}` : ''}`);
    if (parentId && opts.noteOnParent !== false) {
      logActivity(db, parentId, actor, 'subtask', `Added sub-task ${keyOf(db, id)} "${title}"`);
      touch(db, parentId);
    }
    return id;
  });
}

/** Applies the fields present in `b` to task `id` of project `pid`, logging what changed. */
export function updateTask({ db, access }: TaskDeps, pid: number, id: number, actor: string, b: TaskInput): void {
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
    // Parent: notes go on the old and the new parent too.
    if (has(b, 'parentId') && (b.parentId ?? null) !== cur.parentId) {
      const next = b.parentId ?? null;
      const nextKey = next ? checkParent(db, pid, id, next) : null;
      const oldKey = cur.parent?.key ?? null;
      set('parent_id', next);
      changes.push(nextKey ? (oldKey ? `moved from ${oldKey} to ${nextKey}` : `made a sub-task of ${nextKey}`) : `detached from ${oldKey}`);
      const title = b.title !== undefined ? b.title.trim() : cur.title;
      if (cur.parentId) {
        logActivity(db, cur.parentId, actor, 'subtask', `Removed sub-task ${cur.key} "${title}"`);
        touch(db, cur.parentId);
      }
      if (next) {
        logActivity(db, next, actor, 'subtask', `Added sub-task ${cur.key} "${title}"`);
        touch(db, next);
      }
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
}

/**
 * Deletes tasks, and their sub-tasks too when asked. Sub-tasks that stay become top-level tasks. Tasks that
 * stay get a note when a task they were linked to, their parent or a sub-task is deleted. Returns the deleted
 * ids and the ids of tasks that stay but changed.
 */
export function deleteTasks(db: DB, ids: number[], actor: string, opts: { withSubtasks?: boolean } = {}): { deleted: number[]; touched: number[] } {
  return tx(db, () => {
    const doomed = new Set(ids);
    const childrenOf = db.prepare('SELECT id FROM tasks WHERE parent_id = ? ORDER BY number');
    if (opts.withSubtasks) for (const id of ids) for (const r of childrenOf.all(id)) doomed.add(r.id as number);
    const info = db.prepare('SELECT title, parent_id FROM tasks WHERE id = ?');
    const linked = db.prepare(
      'SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS other FROM task_links WHERE source_id = ? OR target_id = ?',
    );
    const touched = new Set<number>();
    for (const id of doomed) {
      const t = info.get(id) as { title: string; parent_id: number | null };
      const what = `${keyOf(db, id)} "${t.title}"`;
      // Links go with the task (ON DELETE CASCADE); leave a trace on the tasks it was linked to.
      for (const r of linked.all(id, id, id) as Array<{ other: number }>) {
        if (doomed.has(r.other)) continue;
        logActivity(db, r.other, actor, 'link', `Removed link: ${what} was deleted`);
        touched.add(r.other);
      }
      if (t.parent_id !== null && !doomed.has(t.parent_id)) {
        logActivity(db, t.parent_id, actor, 'subtask', `Removed sub-task: ${what} was deleted`);
        touched.add(t.parent_id);
      }
      // Sub-tasks that stay lose their parent (ON DELETE SET NULL).
      for (const r of childrenOf.all(id)) {
        const child = r.id as number;
        if (doomed.has(child)) continue;
        logActivity(db, child, actor, 'subtask', `Parent ${what} was deleted, so this is now a top-level task`);
        touch(db, child);
        touched.add(child);
      }
    }
    const del = db.prepare('DELETE FROM tasks WHERE id = ?');
    for (const id of doomed) del.run(id);
    return { deleted: [...doomed], touched: [...touched] };
  });
}

// ---- Tasks from templates (templates.ts stores them) ----------------------------

export interface Template {
  name: string;
  data: TemplateData;
}

/** A template of project `pid`, by id or by name (names ignore case). Other projects' templates are not found. */
export function findTemplate(db: DB, pid: number, ref: string | number): Template {
  const s = String(ref).trim();
  const row = (
    /^\d+$/.test(s)
      ? db.prepare('SELECT name, data FROM task_templates WHERE id = ? AND project_id = ?').get(Number(s), pid)
      : db.prepare('SELECT name, data FROM task_templates WHERE name = ? AND project_id = ?').get(s, pid)
  ) as { name: string; data: string } | undefined;
  if (!row) throw notFound(`Template "${s}"`);
  return { name: row.name, data: parseTemplateData(row.data) };
}

const TITLE_SLOT = /\{title\}/gi;

/**
 * Creates a task and its sub-tasks from a template, in one transaction (or the caller's). Fields in `given`
 * win over the template's, and "{title}" in the template becomes the given title. Sub-tasks start in the
 * first status, in the epoch the template names for them or where their parent is. A type, category or
 * epoch the project doesn't have (renamed, deleted, or a template from elsewhere) is skipped with a warning
 * instead of failing.
 */
export function createFromTemplate(
  deps: TaskDeps,
  pid: number,
  actor: string,
  tpl: Template,
  given: TaskInput,
): { id: number; subtaskIds: number[]; warnings: string[] } {
  const { db } = deps;
  const t = tpl.data;
  return tx(db, () => {
    const warnings: string[] = [];
    const pattern = t.title.trim() || '{title}';
    const givenTitle = given.title?.trim() ?? '';
    const hasSlot = pattern.toLowerCase().includes('{title}');
    if (hasSlot && !givenTitle) throw badRequest(`The template "${tpl.name}" needs a title: its tasks are named "${pattern}"`);
    // A function replacement, so a title with "$&" or "$1" in it is used as it is.
    const title = hasSlot ? pattern.replace(TITLE_SLOT, () => givenTitle) : givenTitle || pattern;
    const slot = givenTitle || title;
    const fill = (s: string) => s.replace(TITLE_SLOT, () => slot);
    if (given.parentId && t.subtasks.length) {
      throw badRequest(`The template "${tpl.name}" has sub-tasks, so a task made from it can't be a sub-task itself`);
    }

    const typeOf = (name: string | null, what: string): string | undefined => {
      if (!name) return undefined;
      const row = db.prepare('SELECT name FROM task_types WHERE project_id = ? AND name = ?').get(pid, name) as { name: string } | undefined;
      if (!row) warnings.push(`${what}: there is no type "${name}" in this project, so it got the default type (${defaultType(db, pid)})`);
      return row?.name;
    };
    const allCategories = db.prepare('SELECT id, name FROM categories WHERE project_id = ?').all(pid) as Array<{ id: number; name: string }>;
    const categoriesOf = (names: string[], what: string): number[] => {
      const ids: number[] = [];
      const missing: string[] = [];
      for (const n of names) {
        const c = allCategories.find((x) => x.name.toLowerCase() === n.toLowerCase());
        if (c) ids.push(c.id);
        else missing.push(`"${n}"`);
      }
      if (missing.length) {
        warnings.push(`${what}: left out ${missing.length > 1 ? 'the categories' : 'the category'} ${missing.join(', ')}, which this project doesn't have`);
      }
      return ids;
    };
    const epochOf = (name: string | null, what: string, otherwise: string): number | null => {
      if (!name) return null;
      const rows = db.prepare('SELECT id FROM epochs WHERE project_id = ? AND name = ? COLLATE NOCASE ORDER BY sort_order, id').all(pid, name);
      if (!rows.length) warnings.push(`${what}: there is no epoch named "${name}" in this project, so it went ${otherwise}`);
      else if (rows.length > 1) warnings.push(`${what}: several epochs are named "${name}"; it went to the first one`);
      return rows.length ? (rows[0].id as number) : null;
    };

    const parentWhat = `"${title}"`;
    const locationGiven = (has(given, 'epochId') && given.epochId !== undefined) || (has(given, 'folderId') && given.folderId !== undefined);
    const estimateGiven = (has(given, 'estimate') && given.estimate !== undefined) || (has(given, 'estimateMinutes') && given.estimateMinutes !== undefined);
    const top: TaskInput = {
      title,
      description: given.description ?? fill(t.description),
      type: given.type?.trim() || typeOf(t.type, parentWhat),
      status: given.status,
      priority: given.priority?.trim() || t.priority || undefined,
      epochId: locationGiven ? given.epochId : epochOf(t.epoch, parentWhat, 'to the Inbox'),
      folderId: locationGiven ? given.folderId : null,
      ...(estimateGiven ? { estimate: given.estimate, estimateMinutes: given.estimateMinutes } : { estimateMinutes: t.estimateMinutes }),
      categories: given.categories ?? categoriesOf(t.categories, parentWhat),
      checklist: given.checklist ?? t.checklist.map(fill),
      note: given.note,
      parentId: given.parentId ?? null,
    };
    const n = t.subtasks.length;
    const from = `from the template "${tpl.name}"`;
    const id = createTask(deps, pid, actor, top, { how: n ? `${from} with ${n} sub-task${n === 1 ? '' : 's'}` : from });
    const parent = db.prepare('SELECT epoch_id, folder_id FROM tasks WHERE id = ?').get(id) as { epoch_id: number | null; folder_id: number | null };
    const subtaskIds = t.subtasks.map((s, i) => {
      const subTitle = fill(s.title).trim();
      if (!subTitle) throw badRequest(`Sub-task ${i + 1} of the template "${tpl.name}" has no title`);
      const what = `Sub-task "${subTitle}"`;
      const epochId = epochOf(s.epoch, what, 'where its parent is') ?? parent.epoch_id;
      return createTask(
        deps,
        pid,
        actor,
        {
          title: subTitle,
          description: fill(s.description),
          type: typeOf(s.type, what),
          priority: s.priority ?? undefined,
          epochId,
          folderId: epochId ? null : parent.folder_id,
          estimateMinutes: s.estimateMinutes,
          categories: categoriesOf(s.categories, what),
          checklist: s.checklist.map(fill),
          parentId: id,
        },
        { how: from, noteOnParent: false },
      );
    });
    return { id, subtaskIds, warnings };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** A task in a request body. `parent` is a key or id; null (or "none") makes it a top-level task. */
type TaskBody = Omit<TaskInput, 'parentId'> & { parent?: string | number | null };

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
  parent: { type: ['string', 'integer', 'null'], maxLength: 40 },
};

/** What a bulk update may set on every task it gets. Not the title, description or checklist: those are each task's own. */
const BULK_FIELDS = ['type', 'status', 'priority', 'epochId', 'folderId', 'estimate', 'estimateMinutes', 'categories', 'note', 'parent'] as const;
/** At most this many tasks in one bulk request. */
export const BULK_MAX = 500;

interface BulkBody {
  action: 'update' | 'move' | 'categories' | 'delete';
  ids: Array<string | number>;
  /** update: the fields to set on every task (BULK_FIELDS). */
  set?: Record<string, unknown>;
  /** move: the column, and the task they go before (null or left out: the end of the column). */
  status?: string;
  beforeId?: number | null;
  /** categories: names or ids to add to and remove from every task. */
  add?: Array<string | number>;
  remove?: Array<string | number>;
  /** delete: their sub-tasks too (else those become top-level tasks). */
  withSubtasks?: boolean;
}

const refList = { type: 'array', maxItems: 200, items: { type: ['string', 'integer'], maxLength: 100 } };
const bulkSchema = {
  type: 'object',
  required: ['action', 'ids'],
  properties: {
    action: { type: 'string', enum: ['update', 'move', 'categories', 'delete'] },
    ids: { type: 'array', minItems: 1, maxItems: BULK_MAX, items: { type: ['string', 'integer'], maxLength: 40 } },
    set: { type: 'object', properties: Object.fromEntries(BULK_FIELDS.map((k) => [k, taskBodyProps[k]])) },
    status: { type: 'string' },
    beforeId: nullableId,
    add: refList,
    remove: refList,
    withSubtasks: { type: 'boolean' },
  },
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
  /** A task key or id: its sub-tasks. "none": top-level tasks only. "any": sub-tasks only. */
  parent?: string;
  limit?: number;
  /** "1" leaves out descriptions (the board and list never show them; saves re-downloading every task's markdown). */
  summary?: string;
}

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access } = ctx;
  const changed = (id: number, actor: string) => bus.emit({ kind: 'tasks', id, actor });

  /**
   * The task fields of a request body. Only a `parent` the caller may see becomes a parentId: a parentId sent
   * by the client is dropped, as an id from someone else's project would otherwise get past the access check.
   */
  const taskInput = (req: FastifyRequest, body: TaskBody): TaskInput => {
    const input: TaskInput & { parent?: string | number | null } = { ...body };
    delete input.parent;
    delete input.parentId;
    const ref = body.parent;
    if (ref === undefined) return input;
    if (ref === null || /^(none)?$/i.test(String(ref).trim())) return { ...input, parentId: null };
    return { ...input, parentId: access.task(req, ref).id };
  };
  /** Also tells the parents of these tasks: their sub-task counts are part of what they show. */
  const changedWithParents = (ids: number[], actor: string, before: Array<number | null> = []) => {
    const all = new Set<number>(ids);
    for (const p of before) if (p) all.add(p);
    for (const id of ids) {
      const row = db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(id) as { parent_id: number | null } | undefined;
      if (row?.parent_id) all.add(row.parent_id);
    }
    for (const id of all) changed(id, actor);
  };

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
    if (q.parent) {
      const p = q.parent.trim().toLowerCase();
      if (p === 'none') where.push('t.parent_id IS NULL');
      else if (p === 'any') where.push('t.parent_id IS NOT NULL');
      else {
        where.push('t.parent_id = ?');
        params.push(access.task(req, q.parent).id);
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

  // With `template` (a name or id in this project) the other fields override the template's, and the title
  // is only needed when the template's title has "{title}" in it.
  app.post<{ Body: TaskBody & { template?: string | number } }>(
    '/api/v1/tasks',
    { schema: { body: { type: 'object', properties: { ...taskBodyProps, template: { type: ['string', 'integer'], maxLength: 100 } } } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = access.current(req).id;
      const { template, ...body } = req.body;
      const input = taskInput(req, body);
      if (template !== undefined) {
        const { id, subtaskIds, warnings } = createFromTemplate(ctx, pid, actor, findTemplate(db, pid, template), input);
        changedWithParents([id, ...subtaskIds], actor);
        reply.code(201);
        return { ...getTaskDetail(db, id), warnings };
      }
      if (input.title === undefined) throw badRequest('Title is required');
      const id = createTask(ctx, pid, actor, input);
      changedWithParents([id], actor);
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
      const before = getTask(db, id).parentId;
      updateTask(ctx, project.id, id, actor, taskInput(req, req.body));
      changedWithParents([id], actor, [before]);
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
      changedWithParents([id], actor);
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
      changedWithParents([id], actor);
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
      changedWithParents([id], actor);
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

  // Sub-tasks stay (as top-level tasks) unless ?withSubtasks=true.
  app.delete<{ Params: { id: string }; Querystring: { withSubtasks?: string } }>('/api/v1/tasks/:id', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = access.task(req, req.params.id);
    const withSubtasks = /^(true|1|yes)$/i.test(req.query.withSubtasks ?? '');
    const { deleted, touched } = deleteTasks(db, [id], actor, { withSubtasks });
    for (const t of [...deleted, ...touched]) changed(t, actor);
    return { ok: true, deleted: deleted.length };
  });

  // ---- Bulk actions on several tasks of one project ------------------------------
  // All or nothing: every reference is checked first, and the changes run in one transaction.

  app.post<{ Body: BulkBody }>('/api/v1/tasks/bulk', { schema: { body: bulkSchema } }, async (req) => {
    const { actor } = requireAuth(req);
    const b = req.body;
    const targets = b.ids.map((ref) => access.task(req, ref));
    const pid = targets[0].project.id;
    if (targets.some((t) => t.project.id !== pid)) throw badRequest('All the tasks must be in one project');
    const ids = [...new Set(targets.map((t) => t.id))];
    // One event for the lot: the web refreshes by kind, so per-task events would only repeat it.
    const done = (result: object) => {
      bus.emit({ kind: 'tasks', actor, projectId: pid });
      return result;
    };

    if (b.action === 'delete') {
      const { deleted } = deleteTasks(db, ids, actor, { withSubtasks: b.withSubtasks ?? false });
      return done({ ok: true, deleted: deleted.length });
    }
    if (b.action === 'update') {
      const given = Object.keys(b.set ?? {});
      const others = given.filter((k) => !(BULK_FIELDS as readonly string[]).includes(k));
      if (others.length) {
        throw badRequest(`${others.join(', ')} can't be changed on several tasks at once. A bulk update can set: ${BULK_FIELDS.join(', ')}`);
      }
      if (!given.length) throw badRequest(`Nothing to change. Send "set" with any of: ${BULK_FIELDS.join(', ')}`);
      const input = taskInput(req, b.set as TaskBody);
      tx(db, () => {
        for (const id of ids) updateTask(ctx, pid, id, actor, input);
      });
    } else if (b.action === 'move') {
      if (!b.status?.trim()) throw badRequest('Send "status": the column to move the tasks to');
      const status = resolveStatus(b.status);
      const beforeId = b.beforeId ?? null;
      if (beforeId !== null && ids.includes(beforeId)) throw badRequest('beforeId cannot be one of the tasks being moved');
      // In the order given: they end up next to each other, in that order, before `beforeId` (or at the end).
      tx(db, () => {
        for (const id of ids) {
          const cur = getTask(db, id);
          positionTask(db, pid, id, status, beforeId);
          if (cur.status !== status) logActivity(db, id, actor, 'status', `${statusLabel(cur.status)} → ${statusLabel(status)}`);
          touch(db, id);
        }
      });
    } else {
      const add = resolveCategories(db, pid, b.add ?? []);
      const remove = new Set(resolveCategories(db, pid, b.remove ?? []));
      if (!add.length && !remove.size) throw badRequest('Send "add" or "remove": category names or ids');
      tx(db, () => {
        for (const id of ids) {
          const current = getTask(db, id).categories.map((c) => c.id);
          const next = [...new Set([...current, ...add])].filter((c) => !remove.has(c));
          updateTask(ctx, pid, id, actor, { categories: next });
        }
      });
    }
    return done({ ok: true, tasks: ids.map((id) => getTask(db, id)) });
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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DB } from '../db.ts';
import type { Access } from '../access.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { has, parseDuration, parseId, taskKey } from '../lib/util.ts';
import { logActivity } from './tasks.ts';

interface EntryRow {
  id: number;
  task_id: number | null;
  epoch_id: number | null;
  project_id: number;
  project_key: string;
  task_number: number | null;
  actor: string;
  started_at: string;
  ended_at: string | null;
  minutes: number | null;
  note: string;
  task_title: string | null;
  epoch_name: string | null;
  task_epoch_id: number | null;
}

// An entry is on a task or directly on an epoch; either way that decides its project.
const ENTRY_SELECT = `
  SELECT te.*, t.title AS task_title, t.epoch_id AS task_epoch_id, t.number AS task_number,
    COALESCE(e.name, te2.name) AS epoch_name, p.id AS project_id, p.key AS project_key
  FROM time_entries te
  LEFT JOIN tasks t ON t.id = te.task_id
  LEFT JOIN epochs e ON e.id = te.epoch_id
  LEFT JOIN epochs te2 ON te2.id = t.epoch_id
  JOIN projects p ON p.id = COALESCE(t.project_id, e.project_id)`;

function entryDto(r: EntryRow) {
  const running = r.ended_at === null && r.minutes === null;
  const minutes = running ? Math.max(0, Math.round((Date.now() - Date.parse(r.started_at)) / 60000)) : (r.minutes ?? 0);
  return {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    taskKey: r.task_id && r.task_number !== null ? taskKey(r.project_key, r.task_number) : null,
    taskTitle: r.task_title,
    epochId: r.epoch_id ?? r.task_epoch_id,
    epochName: r.epoch_name,
    target: r.task_id ? 'task' : 'epoch',
    actor: r.actor,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    minutes,
    running,
    note: r.note,
  };
}

function getEntry(db: DB, id: number) {
  const row = db.prepare(`${ENTRY_SELECT} WHERE te.id = ?`).get(id) as EntryRow | undefined;
  if (!row) throw notFound(`Time entry ${id}`);
  return entryDto(row);
}

function runningFor(db: DB, actor: string) {
  const row = db.prepare(`${ENTRY_SELECT} WHERE te.actor = ? AND te.ended_at IS NULL AND te.minutes IS NULL`).get(actor) as
    | EntryRow
    | undefined;
  return row ? entryDto(row) : null;
}

interface TargetBody {
  taskId?: number | string | null;
  epochId?: number | null;
}

/** The task (id or key) or epoch an entry is for, if the caller may see it. */
function resolveTarget(access: Access, req: FastifyRequest, b: TargetBody): { taskId: number | null; epochId: number | null } {
  const hasTask = b.taskId != null && b.taskId !== '';
  const epochId = b.epochId ?? null;
  if (hasTask === (epochId !== null)) throw badRequest('Provide exactly one of taskId or epochId');
  if (hasTask) return { taskId: access.task(req, b.taskId as string | number).id, epochId: null };
  access.of(req, 'epochs', epochId as number, `Epoch ${epochId}`);
  return { taskId: null, epochId };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a user-supplied date. A bare date ("2026-11-11") means that day in the *server's local
 * time zone* (JavaScript would otherwise read it as UTC midnight, i.e. the previous evening here):
 * 'entry' -> local noon, 'from' -> local midnight, 'to' -> the following local midnight (whole day included).
 */
function parseWhen(v: string | undefined | null, mode: 'entry' | 'from' | 'to' = 'entry'): string {
  if (!v) return nowIso();
  const d = DATE_ONLY.exec(v.trim());
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]) - 1, Number(d[3])];
    const check = new Date(y, m, day);
    // Rejects impossible dates such as 2026-02-31 (which Date would silently roll over).
    if (check.getFullYear() !== y || check.getMonth() !== m || check.getDate() !== day) throw badRequest(`Invalid date "${v}"`);
    if (mode === 'entry') return new Date(y, m, day, 12).toISOString();
    return new Date(y, m, mode === 'to' ? day + 1 : day).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw badRequest(`Invalid date "${v}". Use ISO format, e.g. 2026-11-11 or 2026-11-11T14:30`);
  return new Date(t).toISOString();
}

const fmt = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);

/** Stops the actor's running timer (if any). Returns the stopped entry id. */
function stopRunning(db: DB, actor: string, note?: string): number | null {
  const run = runningFor(db, actor);
  if (!run) return null;
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(run.startedAt)) / 60000));
  db.prepare('UPDATE time_entries SET ended_at = ?, minutes = ?, note = CASE WHEN ? != \'\' THEN ? ELSE note END WHERE id = ?').run(
    nowIso(),
    minutes,
    note ?? '',
    note ?? '',
    run.id,
  );
  if (run.taskId) logActivity(db, run.taskId, actor, 'time', `Logged ${fmt(minutes)} (timer)${note ? `: ${note}` : ''}`);
  return run.id;
}

const targetProps = {
  taskId: { type: ['integer', 'string', 'null'] },
  epochId: { type: ['integer', 'null'], minimum: 1 },
};

export function registerTimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access } = ctx;
  const changed = (actor: string) => {
    bus.emit({ kind: 'time', actor });
    bus.emit({ kind: 'tasks', actor });
  };
  /** A time entry, if the caller may see its project. */
  const entryIn = (req: FastifyRequest, raw: string) => {
    const id = parseId(raw, 'time entry');
    const row = db.prepare(`${ENTRY_SELECT} WHERE te.id = ?`).get(id) as EntryRow | undefined;
    try {
      if (!row) throw new Error();
      access.project(req, row.project_id);
    } catch {
      throw notFound(`Time entry ${id}`);
    }
    return entryDto(row);
  };

  app.get<{
    Querystring: { taskId?: string; epochId?: string; actor?: string; from?: string; to?: string; limit?: number; project?: string };
  }>('/api/v1/time', async (req) => {
    const q = req.query;
    const where: string[] = ['p.id = ?'];
    const params: Array<string | number> = [access.current(req).id];
    if (q.taskId) {
      where.push('te.task_id = ?');
      params.push(access.task(req, q.taskId).id);
    }
    if (q.epochId) {
      // Entries on the epoch itself and on its tasks.
      const id = parseId(q.epochId, 'epoch');
      where.push('(te.epoch_id = ? OR t.epoch_id = ?)');
      params.push(id, id);
    }
    if (q.actor) {
      where.push('te.actor = ?');
      params.push(q.actor);
    }
    if (q.from) {
      where.push('te.started_at >= ?');
      params.push(parseWhen(q.from, 'from'));
    }
    if (q.to) {
      where.push('te.started_at < ?');
      params.push(parseWhen(q.to, 'to'));
    }
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 5000);
    const rows = db
      .prepare(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY te.started_at DESC LIMIT ${limit}`)
      .all(...params) as unknown as EntryRow[];
    const entries = rows.map(entryDto);
    return { entries, totalMinutes: entries.reduce((a, e) => a + e.minutes, 0) };
  });

  app.get('/api/v1/time/running', async (req) => ({ entry: runningFor(db, requireAuth(req).actor) }));

  /** Manual entry: { taskId | epochId, duration: "1h30m" | minutes: 90, note?, date? } */
  app.post<{ Body: TargetBody & { minutes?: number; duration?: string | number; note?: string; date?: string } }>(
    '/api/v1/time',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            ...targetProps,
            minutes: { type: 'integer', minimum: 1 },
            duration: { type: ['string', 'number'] },
            note: { type: 'string', maxLength: 5000 },
            date: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const b = req.body;
      const { taskId, epochId } = resolveTarget(access, req, b);
      const minutes = b.duration != null ? parseDuration(b.duration) : b.minutes;
      if (!minutes || minutes < 1) throw badRequest('Provide duration (e.g. "1h30m") or minutes (>= 1)');
      if (minutes > 24 * 60) throw badRequest('A single entry cannot exceed 24 hours');
      const id = tx(db, () => {
        const res = db
          .prepare('INSERT INTO time_entries (task_id, epoch_id, actor, started_at, minutes, note) VALUES (?, ?, ?, ?, ?, ?)')
          .run(taskId, epochId, actor, parseWhen(b.date), minutes, b.note ?? '');
        if (taskId) logActivity(db, taskId, actor, 'time', `Logged ${fmt(minutes)}${b.note ? `: ${b.note}` : ''}`);
        return Number(res.lastInsertRowid);
      });
      changed(actor);
      reply.code(201);
      return getEntry(db, id);
    },
  );

  /** Starts a timer. Any timer already running for this user/token is stopped first. */
  app.post<{ Body: TargetBody & { note?: string } }>(
    '/api/v1/time/start',
    { schema: { body: { type: 'object', properties: { ...targetProps, note: { type: 'string', maxLength: 5000 } } } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { taskId, epochId } = resolveTarget(access, req, req.body);
      const { id, stopped } = tx(db, () => {
        const stopped = stopRunning(db, actor);
        const res = db
          .prepare('INSERT INTO time_entries (task_id, epoch_id, actor, started_at, note) VALUES (?, ?, ?, ?, ?)')
          .run(taskId, epochId, actor, nowIso(), req.body.note ?? '');
        return { id: Number(res.lastInsertRowid), stopped };
      });
      changed(actor);
      // The timer that was stopped may have been in another of the caller's projects.
      if (stopped !== null) {
        const projectId = getEntry(db, stopped).projectId;
        bus.emit({ kind: 'time', actor, projectId });
        bus.emit({ kind: 'tasks', actor, projectId });
      }
      reply.code(201);
      return getEntry(db, id);
    },
  );

  // Your own running timer (one per user or API token), whichever project it is in.
  app.post<{ Body: { note?: string } }>(
    '/api/v1/time/stop',
    { schema: { body: { type: ['object', 'null'], properties: { note: { type: 'string', maxLength: 5000 } } } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const id = tx(db, () => stopRunning(db, actor, req.body?.note));
      if (id === null) throw notFound('Running timer');
      const entry = getEntry(db, id);
      access.project(req, entry.projectId); // tags the change events with that project
      changed(actor);
      return entry;
    },
  );

  app.patch<{ Params: { id: string }; Body: { minutes?: number; duration?: string | number; note?: string; date?: string } }>(
    '/api/v1/time/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            minutes: { type: 'integer', minimum: 1 },
            duration: { type: ['string', 'number'] },
            note: { type: 'string', maxLength: 5000 },
            date: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const cur = entryIn(req, req.params.id);
      const id = cur.id;
      const b = req.body;
      const sets: string[] = [];
      const vals: Array<string | number> = [];
      if (b.duration != null || b.minutes != null) {
        if (cur.running) throw badRequest('Stop the timer before editing its duration');
        const m = b.duration != null ? parseDuration(b.duration) : b.minutes!;
        if (m < 1 || m > 24 * 60) throw badRequest('Duration must be between 1 minute and 24 hours');
        sets.push('minutes = ?');
        vals.push(m);
      }
      if (has(b, 'note')) {
        sets.push('note = ?');
        vals.push(b.note ?? '');
      }
      if (b.date) {
        // A running timer's start drives its live duration; moving it would bypass the 24h cap or go negative.
        if (cur.running) throw badRequest('Stop the timer before changing its date');
        sets.push('started_at = ?');
        vals.push(parseWhen(b.date));
      }
      if (sets.length) {
        db.prepare(`UPDATE time_entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        changed(actor);
      }
      return getEntry(db, id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/time/:id', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = entryIn(req, req.params.id);
    db.prepare('DELETE FROM time_entries WHERE id = ?').run(id);
    changed(actor);
    return { ok: true };
  });
}

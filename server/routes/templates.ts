import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DB } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { normalizePriority } from '../lib/constants.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { has, nonEmpty, parseDuration } from '../lib/util.ts';

/**
 * Task templates: a task's fields and optional sub-tasks, saved per project under a name. Types, categories
 * and epochs are stored by name and looked up when a task is created from the template (createFromTemplate
 * in tasks.ts), so a template keeps working when those change or when it is copied to another project.
 * "{title}" in a title, description or checklist item is replaced by the title given at creation.
 */
export interface TemplateTask {
  title: string;
  description: string;
  type: string | null;
  priority: string | null;
  categories: string[];
  estimateMinutes: number | null;
  checklist: string[];
  /** Epoch name. Null: the task goes where the request puts it; a sub-task goes where its parent is. */
  epoch: string | null;
}

export interface TemplateData extends TemplateTask {
  subtasks: TemplateTask[];
}

export const TEMPLATE_LIMITS = { subtasks: 50, checklist: 100, categories: 50, bytes: 200_000 } as const;

/** The task fields as a request sends them (an estimate may be "1h30m"). */
interface TaskFields {
  title?: string;
  description?: string;
  type?: string | null;
  priority?: string | null;
  categories?: string[];
  estimate?: string | number | null;
  estimateMinutes?: number | null;
  checklist?: string[];
  epoch?: string | null;
}

interface TemplateBody extends TaskFields {
  name?: string;
  subtasks?: TaskFields[];
  /** Save this task (key or id) as a template; the other fields override what it would copy. */
  fromTask?: string | number;
  includeSubtasks?: boolean;
}

const taskProps = {
  title: { type: 'string', maxLength: 500 },
  description: { type: 'string', maxLength: 100_000 },
  type: { type: ['string', 'null'], maxLength: 60 },
  priority: { type: ['string', 'null'], maxLength: 20 },
  categories: { type: 'array', maxItems: TEMPLATE_LIMITS.categories, items: { type: 'string', maxLength: 60 } },
  estimate: { type: ['string', 'number', 'null'] },
  estimateMinutes: { type: ['integer', 'null'], minimum: 0 },
  checklist: { type: 'array', maxItems: TEMPLATE_LIMITS.checklist, items: { type: 'string', maxLength: 1000 } },
  epoch: { type: ['string', 'null'], maxLength: 200 },
};
const bodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 100 },
    ...taskProps,
    subtasks: { type: 'array', maxItems: TEMPLATE_LIMITS.subtasks, items: { type: 'object', required: ['title'], properties: taskProps } },
    fromTask: { type: ['string', 'integer'] },
    includeSubtasks: { type: 'boolean' },
  },
};

const emptyTask = (title: string): TemplateTask => ({
  title,
  description: '',
  type: null,
  priority: null,
  categories: [],
  estimateMinutes: null,
  checklist: [],
  epoch: null,
});

/** Applies the fields present in `f` on top of `base`, checking each one. */
function applyFields(base: TemplateTask, f: TaskFields, what: string): TemplateTask {
  const t = { ...base };
  if (f.title !== undefined) t.title = nonEmpty(f.title, `${what} title`, 500);
  if (f.description !== undefined) t.description = f.description;
  if (f.type !== undefined) t.type = f.type?.trim() || null;
  if (f.priority !== undefined) {
    const raw = f.priority?.trim();
    const p = raw ? normalizePriority(raw) : null;
    if (raw && !p) throw badRequest(`${what}: unknown priority "${raw}". Valid: low, medium, high, critical`);
    t.priority = p;
  }
  if (f.categories !== undefined) t.categories = [...new Set(f.categories.map((c) => c.trim()).filter(Boolean))];
  if (has(f, 'estimate')) t.estimateMinutes = f.estimate != null && f.estimate !== '' ? parseDuration(f.estimate) : null;
  else if (has(f, 'estimateMinutes')) t.estimateMinutes = f.estimateMinutes ?? null;
  if (f.checklist !== undefined) t.checklist = f.checklist.map((c) => c.trim()).filter(Boolean);
  if (f.epoch !== undefined) t.epoch = f.epoch?.trim() || null;
  return t;
}

/**
 * Checks the limits every template keeps to, however its data came in (a request's fields are checked by the
 * schema too, but a task saved as a template isn't), and returns the data as JSON.
 */
function checkLimits(data: TemplateData): string {
  if (data.subtasks.length > TEMPLATE_LIMITS.subtasks) throw badRequest(`A template can have at most ${TEMPLATE_LIMITS.subtasks} sub-tasks`);
  for (const t of [data, ...data.subtasks]) {
    const what = t === data ? 'The task' : `The sub-task "${t.title}"`;
    if (t.checklist.length > TEMPLATE_LIMITS.checklist) {
      throw badRequest(`${what} has ${t.checklist.length} checklist items; a template can keep at most ${TEMPLATE_LIMITS.checklist} per task`);
    }
    if (t.categories.length > TEMPLATE_LIMITS.categories) {
      throw badRequest(`${what} has ${t.categories.length} categories; a template can keep at most ${TEMPLATE_LIMITS.categories} per task`);
    }
  }
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > TEMPLATE_LIMITS.bytes) throw badRequest(`The template is too big (over ${TEMPLATE_LIMITS.bytes / 1000} KB)`);
  return json;
}

/** Reads stored data, filling in fields that older or hand-made data leaves out. */
export function parseTemplateData(json: string): TemplateData {
  const raw = JSON.parse(json) as Partial<TemplateData>;
  const fill = (t: Partial<TemplateTask>): TemplateTask => ({ ...emptyTask(t.title ?? '{title}'), ...t });
  return { ...fill(raw), subtasks: (raw.subtasks ?? []).map(fill) };
}

/** A task (and its sub-tasks, when asked) as template data. Checklists come along unticked. */
export function snapshotTask(db: DB, taskId: number, includeSubtasks: boolean): TemplateData {
  const one = (id: number): TemplateTask => {
    const t = db
      .prepare('SELECT t.title, t.description, t.type, t.priority, t.estimate_minutes, e.name AS epoch FROM tasks t LEFT JOIN epochs e ON e.id = t.epoch_id WHERE t.id = ?')
      .get(id) as { title: string; description: string; type: string; priority: string; estimate_minutes: number | null; epoch: string | null };
    const categories = db
      .prepare('SELECT c.name FROM task_categories tc JOIN categories c ON c.id = tc.category_id WHERE tc.task_id = ? ORDER BY c.name')
      .all(id)
      .map((r) => r.name as string);
    const checklist = db.prepare('SELECT text FROM checklist_items WHERE task_id = ? ORDER BY sort_order, id').all(id).map((r) => r.text as string);
    return {
      title: t.title,
      description: t.description,
      type: t.type,
      priority: t.priority,
      categories,
      estimateMinutes: t.estimate_minutes,
      checklist,
      epoch: t.epoch,
    };
  };
  const children = includeSubtasks ? db.prepare('SELECT id FROM tasks WHERE parent_id = ? ORDER BY number').all(taskId).map((r) => r.id as number) : [];
  if (children.length > TEMPLATE_LIMITS.subtasks) throw badRequest(`A template can have at most ${TEMPLATE_LIMITS.subtasks} sub-tasks`);
  return { ...one(taskId), subtasks: children.map(one) };
}

interface TemplateRow {
  id: number;
  project_id: number;
  name: string;
  data: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function dto(row: TemplateRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    ...parseTemplateData(row.data),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function templateName(raw: string): string {
  const name = nonEmpty(raw, 'Name', 100);
  // Bare numbers mean template ids in the API and in pm.
  if (/^\d+$/.test(name)) throw badRequest('A template name needs at least one letter (a bare number means a template id)');
  return name;
}

export function registerTemplateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access } = ctx;
  const changed = (id: number, actor: string) => bus.emit({ kind: 'templates', id, actor });
  const get = (id: number) => db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id) as unknown as TemplateRow;

  /** A template by id, or by name in the current project. */
  const find = (req: FastifyRequest, ref: string): TemplateRow => {
    const s = ref.trim();
    if (/^\d+$/.test(s)) {
      access.of(req, 'task_templates', Number(s), `Template ${s}`);
      return get(Number(s));
    }
    const row = db.prepare('SELECT * FROM task_templates WHERE project_id = ? AND name = ?').get(access.current(req).id, s) as TemplateRow | undefined;
    if (!row) throw notFound(`Template "${s}"`);
    return row;
  };

  const assertNameFree = (projectId: number, name: string, exceptId = 0) => {
    if (db.prepare('SELECT 1 FROM task_templates WHERE project_id = ? AND name = ? AND id != ?').get(projectId, name, exceptId)) {
      throw conflict(`There is already a template named "${name}"`);
    }
  };

  app.get('/api/v1/templates', async (req) => {
    const pid = access.current(req).id;
    const rows = db.prepare('SELECT * FROM task_templates WHERE project_id = ? ORDER BY name').all(pid) as unknown as TemplateRow[];
    return { templates: rows.map(dto) };
  });

  app.get<{ Params: { ref: string } }>('/api/v1/templates/:ref', async (req) => dto(find(req, req.params.ref)));

  app.post<{ Body: TemplateBody }>('/api/v1/templates', { schema: { body: { ...bodySchema, required: ['name'] } } }, async (req, reply) => {
    const { actor } = requireAuth(req);
    const b = req.body;
    const name = templateName(b.name ?? '');
    let pid: number;
    let base: TemplateData;
    if (b.fromTask !== undefined) {
      const task = access.task(req, b.fromTask);
      pid = task.project.id;
      base = snapshotTask(db, task.id, b.includeSubtasks ?? false);
    } else {
      pid = access.current(req).id;
      base = { ...emptyTask('{title}'), subtasks: [] };
    }
    const top = applyFields(base, b, 'Template');
    const subtasks = b.subtasks !== undefined ? b.subtasks.map((s, i) => applyFields(emptyTask(''), s, `Sub-task ${i + 1}`)) : base.subtasks;
    const json = checkLimits({ ...top, subtasks });
    const id = tx(db, () => {
      assertNameFree(pid, name);
      return Number(
        db.prepare('INSERT INTO task_templates (project_id, name, data, created_by) VALUES (?, ?, ?, ?)').run(pid, name, json, actor).lastInsertRowid,
      );
    });
    changed(id, actor);
    reply.code(201);
    return dto(get(id));
  });

  /** Changes the fields given; `subtasks`, when given, replaces the whole list. */
  app.patch<{ Params: { ref: string }; Body: TemplateBody }>('/api/v1/templates/:ref', { schema: { body: bodySchema } }, async (req) => {
    const { actor } = requireAuth(req);
    const row = find(req, req.params.ref);
    const b = req.body;
    if (b.fromTask !== undefined) throw badRequest('fromTask only works when creating a template');
    const cur = parseTemplateData(row.data);
    const name = b.name !== undefined ? templateName(b.name) : row.name;
    const top = applyFields(cur, b, 'Template');
    const subtasks = b.subtasks !== undefined ? b.subtasks.map((s, i) => applyFields(emptyTask(''), s, `Sub-task ${i + 1}`)) : cur.subtasks;
    const json = checkLimits({ ...top, subtasks });
    tx(db, () => {
      // Always asked (it skips this template itself): SQLite's NOCASE only folds A-Z, so "Äpfel" and "äpfel"
      // are two names, and a check that compared lower-cased names first would let the rename hit the UNIQUE index.
      assertNameFree(row.project_id, name, row.id);
      db.prepare('UPDATE task_templates SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(name, json, nowIso(), row.id);
    });
    changed(row.id, actor);
    return dto(get(row.id));
  });

  app.delete<{ Params: { ref: string } }>('/api/v1/templates/:ref', async (req) => {
    const { actor } = requireAuth(req);
    const row = find(req, req.params.ref);
    db.prepare('DELETE FROM task_templates WHERE id = ?').run(row.id);
    changed(row.id, actor);
    return { ok: true };
  });
}

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DB } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth, requireSession } from '../auth.ts';
import type { ProjectRow } from '../access.ts';
import { DEFAULT_TYPE_COLORS, DEFAULT_TYPES, STATUSES } from '../lib/constants.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { PROJECT_KEY_RE, assertColor, nonEmpty } from '../lib/util.ts';

export interface NewProject {
  key: string;
  name: string;
  color?: string;
  /** Copy task types, categories, column colours and task templates from this project (same owner). */
  copyFrom?: number | null;
  /** Starting categories as [name, color] (used when not copying). */
  categories?: Array<[string, string]>;
}

function normalizeKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!PROJECT_KEY_RE.test(key)) {
    throw badRequest('Project key must start with a letter and have at most 10 letters or digits (e.g. APP or GAME2). It prefixes task keys: APP-12.');
  }
  return key;
}

function assertKeyFree(db: DB, key: string, exceptId = 0): void {
  if (db.prepare('SELECT 1 FROM projects WHERE key = ? AND id != ?').get(key, exceptId)) {
    throw conflict(`The project key "${key}" is already taken on this server. Pick another one.`);
  }
}

/** Creates a project with its own types, column colours, categories and an empty architecture diagram. */
export function createProject(db: DB, ownerId: number, input: NewProject): number {
  const key = normalizeKey(input.key);
  const name = nonEmpty(input.name, 'Name', 100);
  const color = input.color ? assertColor(input.color) : '#6366f1';
  return tx(db, () => {
    assertKeyFree(db, key);
    const source = input.copyFrom
      ? (db.prepare('SELECT id FROM projects WHERE id = ? AND owner_id = ?').get(input.copyFrom, ownerId) as { id: number } | undefined)
      : undefined;
    if (input.copyFrom && !source) throw badRequest(`Project ${input.copyFrom} not found (to copy settings from)`);
    const id = Number(db.prepare('INSERT INTO projects (key, name, color, owner_id) VALUES (?, ?, ?, ?)').run(key, name, color, ownerId).lastInsertRowid);
    if (source) {
      db.prepare('INSERT INTO task_types (project_id, name, sort_order, color) SELECT ?, name, sort_order, color FROM task_types WHERE project_id = ?').run(id, source.id);
      db.prepare('INSERT INTO status_colors (project_id, status, color) SELECT ?, status, color FROM status_colors WHERE project_id = ?').run(id, source.id);
      db.prepare('INSERT INTO categories (project_id, name, color) SELECT ?, name, color FROM categories WHERE project_id = ?').run(id, source.id);
      db.prepare('INSERT INTO task_templates (project_id, name, data, created_by) SELECT ?, name, data, created_by FROM task_templates WHERE project_id = ?').run(id, source.id);
    } else {
      const addType = db.prepare('INSERT INTO task_types (project_id, name, sort_order, color) VALUES (?, ?, ?, ?)');
      DEFAULT_TYPES.forEach((t, i) => addType.run(id, t, i, DEFAULT_TYPE_COLORS[t] ?? '#64748b'));
      const addStatus = db.prepare('INSERT INTO status_colors (project_id, status, color) VALUES (?, ?, ?)');
      for (const s of STATUSES) addStatus.run(id, s.id, s.color);
      const addCat = db.prepare('INSERT INTO categories (project_id, name, color) VALUES (?, ?, ?)');
      for (const [catName, catColor] of input.categories ?? []) addCat.run(id, nonEmpty(catName, 'Category', 60), assertColor(catColor));
    }
    db.prepare("INSERT INTO diagrams (project_id, name) VALUES (?, 'Code Architecture')").run(id);
    db.prepare('INSERT INTO id_counters (name, last) VALUES (?, 0)').run(`tasks:${id}`);
    return id;
  });
}

/**
 * Deletes a project and everything in it (the database cascades from projects.id), then the uploaded files.
 * Backups keep their own copies. Returns how many files were removed.
 */
export async function deleteProject(db: DB, filesDir: string, projectId: number): Promise<number> {
  const stored = tx(db, () => {
    const names = (db.prepare('SELECT stored_name FROM files WHERE project_id = ?').all(projectId) as Array<{ stored_name: string }>).map(
      (r) => r.stored_name,
    );
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    db.prepare('DELETE FROM id_counters WHERE name = ?').run(`tasks:${projectId}`);
    return names;
  });
  await Promise.all(stored.map((s) => fsp.rm(path.join(filesDir, s), { force: true })));
  return stored.length;
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access, filesDir } = ctx;

  const dto = (p: ProjectRow) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS tasks, SUM(CASE WHEN status = 'ready_to_ship' THEN 0 ELSE 1 END) AS open
         FROM tasks WHERE project_id = ?`,
      )
      .get(p.id) as { tasks: number; open: number | null };
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      color: p.color,
      taskCount: counts.tasks,
      openTaskCount: counts.open ?? 0,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  };
  const changed = (id: number, ownerId: number, actor: string) => bus.emit({ kind: 'projects', id, actor, userId: ownerId });

  app.get('/api/v1/projects', async (req) => ({ projects: access.mine(requireAuth(req).userId).map(dto) }));

  /** The project this request would work in (X-PM-Project header, ?project=, or your only project). */
  app.get('/api/v1/projects/current', async (req) => dto(access.current(req)));

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (req) => dto(access.project(req, req.params.id)));

  app.post<{ Body: NewProject }>(
    '/api/v1/projects',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key', 'name'],
          properties: {
            key: { type: 'string', maxLength: 20 },
            name: { type: 'string', maxLength: 100 },
            color: { type: 'string' },
            copyFrom: { type: ['integer', 'null'], minimum: 1 },
            categories: {
              type: 'array',
              maxItems: 100,
              items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', maxLength: 60 } },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const id = createProject(db, auth.userId, req.body);
      changed(id, auth.userId, auth.actor);
      reply.code(201);
      return dto(access.project(req, id));
    },
  );

  app.patch<{ Params: { id: string }; Body: { key?: string; name?: string; color?: string } }>(
    '/api/v1/projects/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: { key: { type: 'string', maxLength: 20 }, name: { type: 'string', maxLength: 100 }, color: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const p = access.project(req, req.params.id);
      const b = req.body;
      const key = b.key !== undefined ? normalizeKey(b.key) : p.key;
      const name = b.name !== undefined ? nonEmpty(b.name, 'Name', 100) : p.name;
      const color = b.color !== undefined ? assertColor(b.color) : p.color;
      tx(db, () => {
        if (key !== p.key) assertKeyFree(db, key, p.id);
        db.prepare('UPDATE projects SET key = ?, name = ?, color = ?, updated_at = ? WHERE id = ?').run(key, name, color, nowIso(), p.id);
      });
      changed(p.id, auth.userId, auth.actor);
      // A new key renames every task key: let open boards refresh.
      if (key !== p.key) bus.emit({ kind: 'tasks', actor: auth.actor, projectId: p.id });
      return dto(access.project(req, p.id));
    },
  );

  /** Web app only, and the project key must be repeated as ?confirm=KEY: this deletes everything in it. */
  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>('/api/v1/projects/:id', async (req) => {
    const auth = requireSession(req);
    const p = access.project(req, req.params.id);
    if ((req.query.confirm ?? '').trim().toUpperCase() !== p.key) {
      throw badRequest(`Deleting project ${p.key} removes all its tasks, epochs, files, diagrams and time. Repeat its key as ?confirm=${p.key} to confirm.`);
    }
    const files = await deleteProject(db, filesDir, p.id);
    changed(p.id, auth.userId, auth.actor);
    return { ok: true, deletedFiles: files };
  });
}

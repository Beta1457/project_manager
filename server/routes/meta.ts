import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { requireAuth } from '../auth.ts';
import { PRIORITIES, STATUSES, normalizeStatus } from '../lib/constants.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { assertColor, nonEmpty, parseId } from '../lib/util.ts';

/** Categories, task types and Kanban column colours. Each project has its own. */
export function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access } = ctx;
  const categories = (pid: number) => db.prepare('SELECT id, name, color FROM categories WHERE project_id = ? ORDER BY name').all(pid);
  const typeRows = (pid: number) =>
    db.prepare('SELECT name, color FROM task_types WHERE project_id = ? ORDER BY sort_order, name').all(pid) as Array<{ name: string; color: string }>;
  const types = (pid: number) => typeRows(pid).map((r) => r.name);
  const typeColors = (pid: number) => Object.fromEntries(typeRows(pid).map((r) => [r.name, r.color]));
  const statuses = (pid: number) => {
    const colors = new Map(
      (db.prepare('SELECT status, color FROM status_colors WHERE project_id = ?').all(pid) as Array<{ status: string; color: string }>).map(
        (r) => [r.status, r.color],
      ),
    );
    return STATUSES.map((s) => ({ id: s.id, label: s.label, color: colors.get(s.id) ?? s.color }));
  };
  const project = (req: FastifyRequest) => access.current(req);

  /** Everything a client (or Claude) needs to know about valid values in the current project. */
  app.get('/api/v1/meta', async (req) => {
    const p = project(req);
    return {
      project: { id: p.id, key: p.key, name: p.name, color: p.color },
      statuses: statuses(p.id),
      priorities: PRIORITIES,
      types: types(p.id),
      typeColors: typeColors(p.id),
      categories: categories(p.id),
    };
  });

  // ---- Kanban column colours -----------------------------------------------------

  app.get('/api/v1/statuses', async (req) => ({ statuses: statuses(project(req).id) }));

  app.patch<{ Params: { id: string }; Body: { color: string } }>(
    '/api/v1/statuses/:id',
    { schema: { body: { type: 'object', required: ['color'], properties: { color: { type: 'string' } } } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const pid = project(req).id;
      const status = normalizeStatus(req.params.id);
      if (!status) throw notFound(`Status "${req.params.id}"`);
      db.prepare(
        'INSERT INTO status_colors (project_id, status, color) VALUES (?, ?, ?) ON CONFLICT(project_id, status) DO UPDATE SET color = excluded.color',
      ).run(pid, status, assertColor(req.body.color));
      bus.emit({ kind: 'types', actor });
      return { statuses: statuses(pid) };
    },
  );

  // ---- Categories -------------------------------------------------------------

  /** A category by id, if the caller may see its project. */
  const categoryIn = (req: FastifyRequest, raw: string) => {
    const id = parseId(raw, 'category');
    const p = access.of(req, 'categories', id, `Category ${id}`);
    return { id, pid: p.id, cur: db.prepare('SELECT name, color FROM categories WHERE id = ?').get(id) as { name: string; color: string } };
  };

  app.get('/api/v1/categories', async (req) => ({ categories: categories(project(req).id) }));

  app.post<{ Body: { name: string; color?: string } }>(
    '/api/v1/categories',
    {
      schema: {
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 60 }, color: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = project(req).id;
      const name = nonEmpty(req.body.name, 'Name', 60);
      if (db.prepare('SELECT 1 FROM categories WHERE project_id = ? AND name = ?').get(pid, name)) throw conflict(`Category "${name}" already exists`);
      const res = db
        .prepare('INSERT INTO categories (project_id, name, color) VALUES (?, ?, ?)')
        .run(pid, name, req.body.color ? assertColor(req.body.color) : '#64748b');
      bus.emit({ kind: 'categories', actor });
      reply.code(201);
      return db.prepare('SELECT id, name, color FROM categories WHERE id = ?').get(Number(res.lastInsertRowid));
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
    '/api/v1/categories/:id',
    { schema: { body: { type: 'object', properties: { name: { type: 'string', maxLength: 60 }, color: { type: 'string' } } } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, pid, cur } = categoryIn(req, req.params.id);
      const name = req.body.name !== undefined ? nonEmpty(req.body.name, 'Name', 60) : cur.name;
      if (name.toLowerCase() !== cur.name.toLowerCase() && db.prepare('SELECT 1 FROM categories WHERE project_id = ? AND name = ?').get(pid, name)) {
        throw conflict(`Category "${name}" already exists`);
      }
      const color = req.body.color !== undefined ? assertColor(req.body.color) : cur.color;
      db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(name, color, id);
      bus.emit({ kind: 'categories', actor });
      return { id, name, color };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/categories/:id', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = categoryIn(req, req.params.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    bus.emit({ kind: 'categories', actor });
    bus.emit({ kind: 'tasks', actor });
    return { ok: true };
  });

  // ---- Task types ---------------------------------------------------------------

  app.get('/api/v1/types', async (req) => {
    const pid = project(req).id;
    return { types: types(pid), typeColors: typeColors(pid) };
  });

  app.post<{ Body: { name: string; color?: string } }>(
    '/api/v1/types',
    {
      schema: {
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 40 }, color: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = project(req).id;
      const name = nonEmpty(req.body.name, 'Name', 40);
      if (db.prepare('SELECT 1 FROM task_types WHERE project_id = ? AND name = ?').get(pid, name)) throw conflict(`Type "${name}" already exists`);
      const max = db.prepare('SELECT MAX(sort_order) AS m FROM task_types WHERE project_id = ?').get(pid) as { m: number | null };
      db.prepare('INSERT INTO task_types (project_id, name, sort_order, color) VALUES (?, ?, ?, ?)').run(
        pid,
        name,
        (max.m ?? 0) + 1,
        req.body.color ? assertColor(req.body.color) : '#64748b',
      );
      bus.emit({ kind: 'types', actor });
      reply.code(201);
      return { types: types(pid) };
    },
  );

  app.patch<{ Params: { name: string }; Body: { color: string } }>(
    '/api/v1/types/:name',
    { schema: { body: { type: 'object', required: ['color'], properties: { color: { type: 'string' } } } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const pid = project(req).id;
      const res = db
        .prepare('UPDATE task_types SET color = ? WHERE project_id = ? AND name = ?')
        .run(assertColor(req.body.color), pid, req.params.name);
      if (!res.changes) throw notFound(`Type "${req.params.name}"`);
      bus.emit({ kind: 'types', actor });
      bus.emit({ kind: 'tasks', actor });
      return { types: types(pid) };
    },
  );

  app.delete<{ Params: { name: string } }>('/api/v1/types/:name', async (req) => {
    const { actor } = requireAuth(req);
    const pid = project(req).id;
    // Look up the stored spelling first: type names match case-insensitively ("feature" = "Feature"),
    // but tasks store the exact name, so the in-use check must use it.
    const row = db.prepare('SELECT name FROM task_types WHERE project_id = ? AND name = ?').get(pid, req.params.name) as { name: string } | undefined;
    if (!row) throw notFound(`Type "${req.params.name}"`);
    const used = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND type = ?').get(pid, row.name) as { n: number };
    if (used.n > 0) throw conflict(`Type "${row.name}" is used by ${used.n} task(s); change them first`);
    const total = db.prepare('SELECT COUNT(*) AS n FROM task_types WHERE project_id = ?').get(pid) as { n: number };
    if (total.n <= 1) throw conflict('Cannot delete the last task type');
    db.prepare('DELETE FROM task_types WHERE project_id = ? AND name = ?').run(pid, row.name);
    bus.emit({ kind: 'types', actor });
    return { types: types(pid) };
  });
}

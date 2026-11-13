import type { FastifyRequest } from 'fastify';
import type { DB } from './db.ts';
import { requireAuth } from './auth.ts';
import { badRequest, notFound } from './lib/errors.ts';
import { parseTaskRef } from './lib/util.ts';
import { requestContext } from './request-context.ts';

/**
 * Who may see what. Every project belongs to one user, and only that user can see or change anything in
 * it, through the web app or their API tokens. Every route goes through these helpers; anything outside the
 * caller's projects is reported as "not found" (never "forbidden"), so ids reveal nothing about other people.
 */

export interface ProjectRow {
  id: number;
  key: string;
  name: string;
  color: string;
  owner_id: number;
  created_at: string;
  updated_at: string;
}

/** Header (or ?project= query parameter) naming the project a list or create request works in: id or key. */
export const PROJECT_HEADER = 'x-pm-project';

/** Tables whose rows carry a project_id. */
export type ProjectTable = 'tasks' | 'epochs' | 'folders' | 'files' | 'diagrams' | 'categories' | 'task_templates';

export interface TaskTarget {
  id: number;
  project: ProjectRow;
}

export function createAccess(db: DB) {
  const byId = db.prepare('SELECT * FROM projects WHERE id = ?');
  const byKey = db.prepare('SELECT * FROM projects WHERE key = ?');

  /** Tags the request with its project, so its change events only reach that project's owner. */
  const use = (p: ProjectRow): ProjectRow => {
    const store = requestContext.getStore();
    if (store) store.projectId = p.id;
    return p;
  };

  const visible = (req: FastifyRequest, row: ProjectRow | undefined): row is ProjectRow =>
    !!row && row.owner_id === requireAuth(req).userId;

  /** The caller's projects, oldest first. */
  const mine = (userId: number): ProjectRow[] =>
    db.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY id').all(userId) as unknown as ProjectRow[];

  /** A project by id or key ("APP"), if the caller owns it. */
  const project = (req: FastifyRequest, ref: string | number): ProjectRow => {
    const s = String(ref).trim();
    const row = (/^\d+$/.test(s) ? byId.get(Number(s)) : byKey.get(s)) as ProjectRow | undefined;
    if (!visible(req, row)) throw notFound(`Project "${s}"`);
    return use(row);
  };

  /**
   * The project a list or create request works in: the X-PM-Project header or ?project=, else the caller's
   * only project. With several projects and none named, the error lists them.
   */
  const current = (req: FastifyRequest): ProjectRow => {
    const auth = requireAuth(req);
    const header = req.headers[PROJECT_HEADER];
    const query = (req.query as Record<string, unknown> | undefined)?.project;
    const ref = (Array.isArray(header) ? header[0] : header) || (typeof query === 'string' ? query : '');
    if (ref) return project(req, ref);
    const own = mine(auth.userId);
    if (own.length === 1) return use(own[0]);
    if (!own.length) throw badRequest('You have no projects yet. Create one first (web app: Settings → Projects, or POST /api/v1/projects).');
    throw badRequest(
      `Which project? Send the ${PROJECT_HEADER} header or ?project=KEY. Your projects: ${own.map((p) => `${p.key} (${p.name})`).join(', ')}`,
    );
  };

  /** The project a row belongs to, if the caller may see it; otherwise "<label> not found". */
  const of = (req: FastifyRequest, table: ProjectTable, id: number, label: string): ProjectRow => {
    const row = db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as { project_id: number } | undefined;
    const p = row ? (byId.get(row.project_id) as ProjectRow | undefined) : undefined;
    if (!visible(req, p)) throw notFound(label);
    return use(p);
  };

  /** For ids inside a request body (a task's epoch, a file's folder...): they must be in the same project. */
  const inProject = (table: ProjectTable, id: number, projectId: number, label: string): void => {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(id, projectId)) throw notFound(label);
  };

  /** Resolves a task id or key ("APP-12") the caller may see. */
  const task = (req: FastifyRequest, raw: string | number): TaskTarget => {
    const ref = parseTaskRef(String(raw));
    const row = (
      'id' in ref
        ? db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(ref.id)
        : db
            .prepare('SELECT t.id, t.project_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.key = ? AND t.number = ?')
            .get(ref.key, ref.number)
    ) as { id: number; project_id: number } | undefined;
    const p = row ? (byId.get(row.project_id) as ProjectRow | undefined) : undefined;
    if (!row || !visible(req, p)) throw notFound(`Task ${String(raw).trim()}`);
    return { id: row.id, project: use(p) };
  };

  return { mine, project, current, of, inProject, task };
}

export type Access = ReturnType<typeof createAccess>;

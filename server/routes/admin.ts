import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { createUser, requireAdmin, requireAuth, requireSession } from '../auth.ts';
import type { ChangeEvent } from '../events.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { randomToken, sha256 } from '../lib/security.ts';
import { nonEmpty, parseId } from '../lib/util.ts';
import { deleteProject } from './projects.ts';

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, backups, filesDir } = ctx;

  app.get('/api/health', async () => ({ ok: true }));

  // ---- Live updates (Server-Sent Events) -------------------------------------
  // Each listener only hears about its own projects and its own account.
  app.get('/api/events', (req, reply) => {
    const { userId } = requireAuth(req);
    const owns = db.prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?');
    const mayHear = (e: ChangeEvent) => e.userId === userId || (e.projectId !== undefined && !!owns.get(e.projectId, userId));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const unsubscribe = bus.subscribe((e) => {
      if (mayHear(e)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---- API tokens (web UI only; everyone manages their own) ----------------------
  app.get('/api/v1/tokens', async (req) => {
    const auth = requireSession(req);
    return {
      tokens: db
        .prepare(
          `SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt
           FROM api_tokens WHERE user_id = ? ORDER BY id`,
        )
        .all(auth.userId),
    };
  });

  app.post<{ Body: { name: string } }>(
    '/api/v1/tokens',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 40 } } } } },
    async (req, reply) => {
      const auth = requireSession(req);
      const name = nonEmpty(req.body.name, 'Name', 40);
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw badRequest('Token name may contain letters, numbers, _ . - (it appears in activity logs)');
      // The name is the actor in activity logs and owns its own running timer, so it must not
      // collide with another token or with a username.
      const clash = db
        .prepare('SELECT 1 FROM api_tokens WHERE name = ? COLLATE NOCASE UNION ALL SELECT 1 FROM users WHERE username = ? COLLATE NOCASE')
        .get(name, name);
      if (clash) throw conflict(`"${name}" is already used by another token or user. Pick a unique name, e.g. "claude-${auth.username}".`);
      const token = randomToken('pm_');
      const res = db
        .prepare('INSERT INTO api_tokens (name, token_hash, prefix, user_id) VALUES (?, ?, ?, ?)')
        .run(name, sha256(token), token.slice(0, 7), auth.userId);
      bus.markDirty();
      reply.code(201);
      // The plain token is only ever shown once.
      return { id: Number(res.lastInsertRowid), name, token };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/tokens/:id', async (req) => {
    const auth = requireSession(req);
    const id = parseId(req.params.id, 'token');
    if (!db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, auth.userId).changes) throw notFound(`Token ${id}`);
    bus.markDirty();
    return { ok: true };
  });

  // ---- Accounts (admins only) ------------------------------------------------------
  const userDto = db.prepare(
    `SELECT u.id, u.username, u.is_admin AS isAdmin, u.created_at AS createdAt,
       (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS projectCount
     FROM users u WHERE u.id = ?`,
  );
  const toUser = (r: Record<string, unknown>) => ({ ...r, isAdmin: !!r.isAdmin });

  app.get('/api/v1/users', async (req) => {
    requireAdmin(req);
    const ids = db.prepare('SELECT id FROM users ORDER BY id').all() as Array<{ id: number }>;
    return { users: ids.map((r) => toUser(userDto.get(r.id) as Record<string, unknown>)) };
  });

  app.post<{ Body: { username: string; password: string; admin?: boolean } }>(
    '/api/v1/users',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: { username: { type: 'string' }, password: { type: 'string' }, admin: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      requireAdmin(req);
      const id = createUser(db, req.body.username.trim(), req.body.password, { admin: req.body.admin === true });
      bus.markDirty();
      reply.code(201);
      return toUser(userDto.get(id) as Record<string, unknown>);
    },
  );

  /** Someone who still owns projects is only deleted with ?deleteProjects=true, which deletes those too. */
  app.delete<{ Params: { id: string }; Querystring: { deleteProjects?: string } }>('/api/v1/users/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = parseId(req.params.id, 'user');
    if (id === auth.userId) throw badRequest('You cannot delete your own account');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound(`User ${id}`);
    const projects = db.prepare('SELECT id FROM projects WHERE owner_id = ?').all(id) as Array<{ id: number }>;
    if (projects.length && req.query.deleteProjects !== 'true') {
      throw conflict(
        `This account owns ${projects.length} project(s). Deleting it deletes them and everything in them. Retry with ?deleteProjects=true to confirm.`,
      );
    }
    for (const p of projects) await deleteProject(db, filesDir, p.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    bus.markDirty();
    return { ok: true, deletedProjects: projects.length };
  });

  // ---- Backups -------------------------------------------------------------------
  // Only admins see the list (a backup holds everyone's projects; there is no download over the API). Anyone
  // may take a snapshot, e.g. Claude before reorganising: it only adds a copy on the server.
  app.get('/api/v1/backups', async (req) => {
    requireAdmin(req);
    return {
      intervalHours: ctx.config.backupIntervalHours,
      keep: ctx.config.backupKeep,
      directory: backups.dir,
      backups: backups.list(),
    };
  });

  app.post('/api/v1/backups', async (req, reply) => {
    const auth = requireAuth(req);
    // Old backups are pruned to a fixed count, so non-admins can't flush the history by asking repeatedly.
    const newest = backups.list()[0];
    if (!auth.isAdmin && newest && Date.now() - Date.parse(newest.createdAt) < 60_000) return newest;
    const info = await backups.run();
    reply.code(201);
    return info;
  });
}

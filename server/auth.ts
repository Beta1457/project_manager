import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.ts';
import type { ChangeBus } from './events.ts';
import { nowIso } from './db.ts';
import { HttpError, badRequest, forbidden } from './lib/errors.ts';
import {
  hashPassword,
  randomToken,
  sha256,
  validatePassword,
  validateUsername,
  verifyPassword,
} from './lib/security.ts';

export const SESSION_COOKIE = 'pm_session';
export const CSRF_HEADER = 'x-pm-client';
const DAY_MS = 24 * 60 * 60 * 1000;
const REMEMBER_MS = 30 * DAY_MS;
const SHORT_MS = 12 * 60 * 60 * 1000;

/** API routes reachable without logging in (route patterns, not raw URLs). */
// '/integration/:file' serves the (secret-free) coding-agent skill files so another PC can install them; see routes/integration.ts.
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login', '/api/auth/logout', '/api/auth/status', '/integration/:file']);
/** Route patterns registered by @fastify/static for the web UI's files (index.html, JS, CSS, icons). */
const STATIC_ROUTES = new Set(['/*', '/']);

export interface AuthInfo {
  userId: number;
  username: string;
  /** Name recorded in activity logs: the username, or the API token's name (e.g. "claude"). */
  actor: string;
  via: 'session' | 'token';
  /** Admins manage accounts and backups. They can't see other people's projects either. */
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

/** Simple in-memory login throttle: 10 failures per 15 minutes per IP. */
class LoginThrottle {
  private failures = new Map<string, { count: number; resetAt: number }>();
  private readonly max = 10;
  private readonly windowMs = 15 * 60 * 1000;

  check(ip: string): void {
    const entry = this.failures.get(ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= this.max) {
      const mins = Math.ceil((entry.resetAt - Date.now()) / 60000);
      throw new HttpError(429, `Too many failed logins. Try again in ${mins} minute(s).`);
    }
  }
  fail(ip: string): void {
    // Drop expired entries so the map can't grow without bound.
    if (this.failures.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
    const entry = this.failures.get(ip);
    if (!entry || entry.resetAt <= Date.now()) {
      this.failures.set(ip, { count: 1, resetAt: Date.now() + this.windowMs });
    } else {
      entry.count++;
    }
  }
  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}

export function requireAuth(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw new HttpError(401, 'Not authenticated');
  return req.auth;
}

export function requireSession(req: FastifyRequest): AuthInfo {
  const auth = requireAuth(req);
  if (auth.via !== 'session') throw forbidden('This action is only available from the web UI');
  return auth;
}

/** Account management and backups: web app only, admins only. */
export function requireAdmin(req: FastifyRequest): AuthInfo {
  const auth = requireSession(req);
  if (!auth.isAdmin) throw forbidden('Only an admin can do this');
  return auth;
}

/** Creates an account. The first account on a server is always an admin. */
export function createUser(db: DB, username: string, password: string, opts: { admin?: boolean } = {}): number {
  const uErr = validateUsername(username);
  if (uErr) throw badRequest(uErr);
  const pErr = validatePassword(password);
  if (pErr) throw badRequest(pErr);
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) throw new HttpError(409, `User "${username}" already exists`);
  // Usernames and API token names share one namespace: both appear as the actor in activity logs.
  if (db.prepare('SELECT 1 FROM api_tokens WHERE name = ? COLLATE NOCASE').get(username)) {
    throw new HttpError(409, `"${username}" is already the name of an API token`);
  }
  const first = !(db.prepare('SELECT 1 FROM users LIMIT 1').get());
  const res = db
    .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), opts.admin || first ? 1 : 0);
  return Number(res.lastInsertRowid);
}

export function setPassword(db: DB, userId: number, password: string): void {
  const pErr = validatePassword(password);
  if (pErr) throw badRequest(pErr);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  // Invalidate all sessions so other devices must log in with the new password.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function registerAuth(app: FastifyInstance, db: DB, bus: ChangeBus): void {
  const throttle = new LoginThrottle();
  app.decorateRequest('auth', null);

  const setSessionCookie = (reply: FastifyReply, token: string, remember: boolean) => {
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      ...(remember ? { maxAge: REMEMBER_MS / 1000 } : {}),
    });
  };

  // Auth decisions use the *matched route pattern*, never the raw URL: the router decodes and
  // normalises paths ("/%61pi/...", absolute-form "http://host/api/..."), so a raw-URL prefix
  // check can be sidestepped while the request still reaches the real handler.
  const routeOf = (req: FastifyRequest): string | undefined => req.routeOptions.url;

  // Resolve credentials for every matched route except the static web UI files.
  app.addHook('onRequest', async (req, reply) => {
    const route = routeOf(req);
    if (route === undefined || STATIC_ROUTES.has(route)) return;

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      const row = db
        .prepare(
          `SELECT t.id, t.name, u.id AS user_id, u.username, u.is_admin FROM api_tokens t
           JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
        )
        .get(sha256(token)) as { id: number; name: string; user_id: number; username: string; is_admin: number } | undefined;
      if (!row) throw new HttpError(401, 'Invalid API token');
      db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
      req.auth = { userId: row.user_id, username: row.username, actor: row.name, via: 'token', isAdmin: !!row.is_admin };
      return;
    }

    const cookie = req.cookies[SESSION_COOKIE];
    if (!cookie) return;
    const hash = sha256(cookie);
    const row = db
      .prepare(
        `SELECT s.user_id, s.remember, s.expires_at, u.username, u.is_admin FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hash) as { user_id: number; remember: number; expires_at: number; username: string; is_admin: number } | undefined;
    if (!row || row.expires_at < Date.now()) {
      if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    // Sliding expiry for "remember me" sessions so phones stay logged in.
    if (row.remember && row.expires_at - Date.now() < REMEMBER_MS - DAY_MS) {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + REMEMBER_MS, hash);
      setSessionCookie(reply, cookie, true);
    }
    // CSRF guard: cookie-authenticated writes must carry a custom header that
    // cross-site forms cannot set.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== 'web') {
      throw forbidden(`Missing ${CSRF_HEADER} header`);
    }
    req.auth = { userId: row.user_id, username: row.username, actor: row.username, via: 'session', isAdmin: !!row.is_admin };
  });

  // Default deny: every route needs auth unless it is listed here. Unmatched URLs (no route)
  // fall through to the 404 handler, which serves nothing private.
  app.addHook('preHandler', async (req) => {
    const route = routeOf(req);
    if (route === undefined || PUBLIC_ROUTES.has(route) || STATIC_ROUTES.has(route)) return;
    requireAuth(req);
  });

  app.post<{ Body: { username: string; password: string; remember?: boolean } }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', maxLength: 100 },
            password: { type: 'string', maxLength: 200 },
            remember: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      throttle.check(req.ip);
      const { username, password, remember = true } = req.body;
      const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username) as
        | { id: number; username: string; password_hash: string }
        | undefined;
      if (!user || !verifyPassword(password, user.password_hash)) {
        throttle.fail(req.ip);
        throw new HttpError(401, 'Invalid username or password');
      }
      throttle.succeed(req.ip);
      const token = randomToken();
      const expires = Date.now() + (remember ? REMEMBER_MS : SHORT_MS);
      db.prepare('INSERT INTO sessions (token_hash, user_id, remember, expires_at) VALUES (?, ?, ?, ?)').run(
        sha256(token),
        user.id,
        remember ? 1 : 0,
        expires,
      );
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      setSessionCookie(reply, token, remember);
      return { user: { id: user.id, username: user.username } };
    },
  );

  /** Public: lets the login page explain first-time setup when no account exists yet. */
  app.get('/api/auth/status', async () => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return { setupRequired: row.n === 0 };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(cookie));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const auth = requireAuth(req);
    return { user: { id: auth.userId, username: auth.username, isAdmin: auth.isAdmin }, actor: auth.actor, via: auth.via };
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const auth = requireSession(req);
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(auth.userId) as { password_hash: string };
      if (!verifyPassword(req.body.currentPassword, row.password_hash)) throw badRequest('Current password is incorrect');
      setPassword(db, auth.userId, req.body.newPassword);
      bus.markDirty();
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true, message: 'Password changed. Please log in again.' };
    },
  );
}

import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.ts';
import { openDb } from './db.ts';
import { ChangeBus } from './events.ts';
import { BackupService } from './backup.ts';
import { registerAuth } from './auth.ts';
import type { AppContext } from './context.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { registerStructureRoutes } from './routes/structure.ts';
import { registerTimeRoutes } from './routes/time.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerDiagramRoutes } from './routes/diagrams.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerIntegrationRoutes } from './routes/integration.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerCopyRoutes } from './routes/copy.ts';
import { createAccess } from './access.ts';
import { requestContext } from './request-context.ts';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function buildApp(config: AppConfig, opts: { dbFile?: string; logger?: boolean } = {}): Promise<BuiltApp> {
  const filesDir = path.join(config.dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  // Leftovers from an upload interrupted by a crash or power cut; never referenced by the database.
  for (const f of fs.readdirSync(filesDir)) if (f.endsWith('.part')) fs.rmSync(path.join(filesDir, f), { force: true });

  const db = openDb(opts.dbFile ?? path.join(config.dataDir, 'pm.db'));
  const bus = new ChangeBus();
  const app = Fastify({
    logger: opts.logger ? { level: 'info' } : false,
    // The service log only rotates on restart, so skip per-request lines; errors are still logged.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { allowUnionTypes: true } },
    // Live-update (SSE) connections never finish on their own; drop them on shutdown.
    forceCloseConnections: true,
  });
  const backups = new BackupService(db, bus, {
    dataDir: config.dataDir,
    filesDir,
    intervalHours: config.backupIntervalHours,
    keep: config.backupKeep,
    log: (m) => app.log.info(m),
  });
  const ctx: AppContext = { db, bus, config, backups, filesDir, access: createAccess(db) };

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 } });

  // Run the rest of each request inside a context that remembers which browser tab sent it.
  app.addHook('onRequest', (req, _reply, done) => {
    const raw = req.headers['x-pm-client-id'];
    const client = typeof raw === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : undefined;
    requestContext.run({ client }, done);
  });

  // Baseline security headers for every response. A route may set a stricter CSP of its own (the sandboxed
  // HTML preview does, together with X-Frame-Options SAMEORIGIN so the app can show it in an iframe).
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
          "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      );
    }
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  registerAuth(app, db, bus);
  registerAdminRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerMetaRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  registerStructureRoutes(app, ctx);
  registerTimeRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerCopyRoutes(app, ctx);
  registerDiagramRoutes(app, ctx);
  registerIntegrationRoutes(app);

  // Web UI (single-page app) if it has been built.
  const indexHtml = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    // wildcard (default) serves files from disk on demand, so a rebuilt UI is picked up without a restart.
    await app.register(fastifyStatic, {
      root: config.webDist,
      // "/" is a directory request under the wildcard route; without an index file it would answer 403.
      index: 'index.html',
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        // Vite fingerprints everything in /assets, so it can be cached forever; other files must revalidate.
        const hashed = /[\\/]assets[\\/]/.test(filePath);
        reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split('?')[0];
      // API routes, writes and missing static assets (anything with a file extension) get a real 404.
      const isRead = req.method === 'GET' || req.method === 'HEAD';
      if (pathname.startsWith('/api/') || !isRead || /\.[a-z0-9]+$/i.test(pathname)) {
        return reply.code(404).send({ error: `Route ${req.method} ${pathname} not found` });
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) =>
      reply.code(404).send({
        error: req.url.startsWith('/api/') ? `Route ${req.method} ${req.url.split('?')[0]} not found` : 'Web UI not built. Run: npm run build',
      }),
    );
  }

  app.addHook('onClose', async () => {
    backups.stop();
    db.close();
  });

  return { app, ctx };
}

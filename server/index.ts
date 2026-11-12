import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const { app, ctx } = await buildApp(config, { logger: true });

const userCount = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (userCount === 0) {
  app.log.warn('No users exist yet. Create one with:  npm run user -- add <username>');
}

ctx.backups.start();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  // Never hang a service stop: force exit if graceful close takes too long.
  setTimeout(() => process.exit(0), 5000).unref();
  try {
    await app.close();
  } catch (err) {
    app.log.error(err);
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK')); // Windows console close / Ctrl+Break

await app.listen({ port: config.port, host: config.host });
app.log.info(`Project Manager running on http://${config.host}:${config.port}`);

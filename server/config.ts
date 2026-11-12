import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const ROOT = path.resolve(import.meta.dirname, '..');
/** Settings written by `npm run setup` (PM_PORT=9000 and so on). Real environment variables win. */
export const ENV_FILE = path.join(ROOT, '.env');

/** Copies .env entries into process.env, keeping any variable that is already set. */
export function loadEnvFile(file = ENV_FILE): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const [key, value] of Object.entries(parseEnv(text) as Record<string, string>)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Setting ${name} must be a number (got "${raw}")`);
  return n;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  webDist: string;
  backupIntervalHours: number;
  backupKeep: number;
  maxUploadMb: number;
}

export function loadConfig(): AppConfig {
  loadEnvFile();
  const port = num('PM_PORT', 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Setting PM_PORT must be a whole number from 1 to 65535 (got "${process.env.PM_PORT}")`);
  }
  return {
    port,
    host: process.env.PM_HOST || '0.0.0.0',
    dataDir: path.resolve(process.env.PM_DATA_DIR || path.join(ROOT, 'data')),
    webDist: path.resolve(process.env.PM_WEB_DIST || path.join(ROOT, 'web', 'dist')),
    backupIntervalHours: num('PM_BACKUP_HOURS', 4),
    backupKeep: num('PM_BACKUP_KEEP', 42), // 42 x 4h = 7 days
    maxUploadMb: num('PM_MAX_UPLOAD_MB', 200),
  };
}

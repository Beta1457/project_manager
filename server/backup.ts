import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DB } from './db.ts';
import type { ChangeBus } from './events.ts';

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

export interface BackupOptions {
  dataDir: string;
  filesDir: string;
  intervalHours: number;
  keep: number;
  log?: (msg: string) => void;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Periodic backups: a consistent SQLite snapshot (VACUUM INTO) plus an
 * incremental mirror of uploaded files. Skips a cycle if nothing changed.
 */
export class BackupService {
  readonly dir: string;
  private timer: NodeJS.Timeout | null = null;
  private lastRevision = -1;
  private db: DB;
  private bus: ChangeBus;
  private opts: BackupOptions;

  constructor(db: DB, bus: ChangeBus, opts: BackupOptions) {
    this.db = db;
    this.bus = bus;
    this.opts = opts;
    this.dir = path.join(opts.dataDir, 'backups');
  }

  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const intervalMs = this.opts.intervalHours * 60 * 60 * 1000;
    if (intervalMs <= 0) return;
    // Back up at startup if the newest backup is older than one interval.
    const newest = this.list()[0];
    if (!newest || Date.now() - Date.parse(newest.createdAt) > intervalMs) void this.safeRun('startup');
    else this.lastRevision = this.bus.revision;
    this.timer = setInterval(() => {
      if (this.bus.revision !== this.lastRevision) void this.safeRun('scheduled');
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async safeRun(reason: string): Promise<void> {
    try {
      const info = await this.run();
      this.opts.log?.(`Backup (${reason}) written: ${info.name}`);
    } catch (err) {
      this.opts.log?.(`Backup (${reason}) FAILED: ${(err as Error).message}`);
    }
  }

  async run(): Promise<BackupInfo> {
    await fsp.mkdir(this.dir, { recursive: true });
    const revision = this.bus.revision;
    let name = `pm-${stamp()}.db`;
    let target = path.join(this.dir, name);
    for (let i = 1; fs.existsSync(target); i++) {
      name = `pm-${stamp()}-${i}.db`;
      target = path.join(this.dir, name);
    }
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    await this.mirrorFiles();
    this.lastRevision = revision;
    await this.prune();
    const st = await fsp.stat(target);
    return { name, size: st.size, createdAt: st.mtime.toISOString() };
  }

  /**
   * Copies uploaded files that are not yet in the backup mirror. Stored files are immutable once
   * complete (edits write a new name), so a name + size match means the copy is good.
   */
  private async mirrorFiles(): Promise<void> {
    const dest = path.join(this.dir, 'files');
    await fsp.mkdir(dest, { recursive: true });
    if (!fs.existsSync(this.opts.filesDir)) return;
    for (const f of await fsp.readdir(this.opts.filesDir)) {
      if (f.endsWith('.part')) continue; // upload or edit still being written
      const src = path.join(this.opts.filesDir, f);
      const target = path.join(dest, f);
      try {
        const srcSize = (await fsp.stat(src)).size;
        const existing = await fsp.stat(target).catch(() => null);
        if (existing && existing.size === srcSize) continue;
        // Temp + rename: a crash mid-copy can't leave a truncated file that looks complete.
        await fsp.copyFile(src, `${target}.part`);
        await fsp.rename(`${target}.part`, target);
      } catch (err) {
        // Deleted or replaced since readdir (e.g. a document edit): nothing to back up.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
  }

  private async prune(): Promise<void> {
    const all = this.list();
    for (const b of all.slice(Math.max(1, this.opts.keep))) {
      await fsp.rm(path.join(this.dir, b.name), { force: true });
    }
  }

  list(): BackupInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^pm-.*\.db$/.test(f))
      .map((name) => {
        const st = fs.statSync(path.join(this.dir, name));
        return { name, size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }
}

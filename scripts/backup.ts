// Manual backup: npm run backup
// Safe to run while the server is running (SQLite WAL + VACUUM INTO gives a consistent snapshot).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { ChangeBus } from '../server/events.ts';
import { BackupService } from '../server/backup.ts';

const config = loadConfig();
const dbFile = path.join(config.dataDir, 'pm.db');
if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}`);
  process.exit(1);
}
const db = openDb(dbFile);
const service = new BackupService(db, new ChangeBus(), {
  dataDir: config.dataDir,
  filesDir: path.join(config.dataDir, 'files'),
  intervalHours: config.backupIntervalHours,
  keep: config.backupKeep,
});
const info = await service.run();
db.close();
console.log(`Backup written: ${path.join(service.dir, info.name)} (${Math.round(info.size / 1024)} KB)`);

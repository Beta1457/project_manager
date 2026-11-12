import type { AppConfig } from './config.ts';
import type { DB } from './db.ts';
import type { ChangeBus } from './events.ts';
import type { BackupService } from './backup.ts';
import type { Access } from './access.ts';

export interface AppContext {
  db: DB;
  bus: ChangeBus;
  config: AppConfig;
  backups: BackupService;
  filesDir: string;
  /** Project ownership checks; every route that touches project data goes through it. */
  access: Access;
}

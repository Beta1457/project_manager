import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TYPE_COLORS, DEFAULT_TYPES, STATUSES } from './lib/constants.ts';

export type DB = DatabaseSync;

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/** Ordered migrations. Never edit a shipped migration; append a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remember INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    last_used_at TEXT
  );
  CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE epochs (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#6366f1',
    target_date TEXT,
    estimate_minutes INTEGER,
    sort_order REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE task_types (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#64748b'
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'Feature',
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    epoch_id INTEGER REFERENCES epochs(id) ON DELETE SET NULL,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    estimate_minutes INTEGER,
    sort_order REAL NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX tasks_status_order ON tasks(status, sort_order);
  CREATE INDEX tasks_epoch ON tasks(epoch_id);
  CREATE INDEX tasks_folder ON tasks(folder_id);
  CREATE TABLE task_categories (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, category_id)
  );
  CREATE TABLE checklist_items (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX activity_task ON activity(task_id, id);
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE diagrams (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE time_entries (
    id INTEGER PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    epoch_id INTEGER REFERENCES epochs(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    minutes INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    CHECK ((task_id IS NULL) <> (epoch_id IS NULL))
  );
  CREATE INDEX time_task ON time_entries(task_id);
  CREATE INDEX time_epoch ON time_entries(epoch_id);
  CREATE INDEX time_running ON time_entries(actor) WHERE ended_at IS NULL AND minutes IS NULL;
  `,
  // v2: colour coding for task types and Kanban columns.
  `
  ALTER TABLE task_types ADD COLUMN color TEXT NOT NULL DEFAULT '#64748b';
  CREATE TABLE status_colors (
    status TEXT PRIMARY KEY,
    color TEXT NOT NULL
  );
  `,
  // v3: task keys (T-12) are quoted in commits and notes, so a deleted task's number must never be handed out
  // again. SQLite reuses the highest rowid after it is deleted; this counter only ever goes up.
  `
  CREATE TABLE id_counters (
    name TEXT PRIMARY KEY,
    last INTEGER NOT NULL
  );
  INSERT INTO id_counters (name, last) SELECT 'tasks', COALESCE(MAX(id), 0) FROM tasks;
  `,
  // v4: links between tasks. "blocks" and "duplicates" read source → target; "relates" has no direction and
  // is stored with source < target. At most one link per pair of tasks (enforced in the API).
  `
  CREATE TABLE task_links (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('relates', 'blocks', 'duplicates')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    CHECK (source_id <> target_id),
    UNIQUE (source_id, target_id)
  );
  CREATE INDEX task_links_target ON task_links(target_id);
  `,
  // v5: projects. Everything belongs to a project owned by one user, and nobody else can see it. Categories,
  // task types and column colours become per project too, which means rebuilding those tables (their names
  // were unique server-wide). Task keys become <project key>-<number>, numbered per project; existing tasks
  // keep their numbers in a project with the key "T", so T-12 still means the same task. Rows are tagged with
  // project 0 here and assigned to a real project by migrateV5 below.
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6366f1',
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX projects_owner ON projects(owner_id);
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE folders ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0 REFERENCES projects(id) ON DELETE CASCADE;
  ALTER TABLE epochs ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0 REFERENCES projects(id) ON DELETE CASCADE;
  ALTER TABLE tasks ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0 REFERENCES projects(id) ON DELETE CASCADE;
  ALTER TABLE tasks ADD COLUMN number INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE files ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0 REFERENCES projects(id) ON DELETE CASCADE;
  ALTER TABLE diagrams ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0 REFERENCES projects(id) ON DELETE CASCADE;
  UPDATE tasks SET number = id;

  CREATE TABLE categories_v5 (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#64748b',
    UNIQUE (project_id, name)
  );
  INSERT INTO categories_v5 (id, project_id, name, color) SELECT id, 0, name, color FROM categories;
  DROP TABLE categories;
  ALTER TABLE categories_v5 RENAME TO categories;

  CREATE TABLE task_types_v5 (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#64748b',
    PRIMARY KEY (project_id, name)
  );
  INSERT INTO task_types_v5 (project_id, name, sort_order, color) SELECT 0, name, sort_order, color FROM task_types;
  DROP TABLE task_types;
  ALTER TABLE task_types_v5 RENAME TO task_types;

  CREATE TABLE status_colors_v5 (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    color TEXT NOT NULL,
    PRIMARY KEY (project_id, status)
  );
  INSERT INTO status_colors_v5 (project_id, status, color) SELECT 0, status, color FROM status_colors;
  DROP TABLE status_colors;
  ALTER TABLE status_colors_v5 RENAME TO status_colors;

  CREATE INDEX folders_project ON folders(project_id, parent_id);
  CREATE INDEX epochs_project ON epochs(project_id);
  CREATE INDEX tasks_project_status ON tasks(project_id, status, sort_order);
  CREATE UNIQUE INDEX tasks_project_number ON tasks(project_id, number);
  CREATE INDEX files_project ON files(project_id, folder_id);
  CREATE INDEX diagrams_project ON diagrams(project_id);
  `,
  // v6: sub-tasks. A task can have one parent in its own project, one level deep (both enforced in the API).
  // Deleting a parent leaves its sub-tasks as top-level tasks, unless the API is asked to delete them too.
  `
  ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
  CREATE INDEX tasks_parent ON tasks(parent_id);
  `,
  // v7: task templates, per project. The data column is JSON: the task's fields and its sub-tasks, with types,
  // categories and epochs by name (looked up when the template is used).
  `
  CREATE TABLE task_templates (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    data TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW},
    UNIQUE (project_id, name)
  );
  `,
];

/** Gives the data from before projects existed to the first user, as a project with the key "T". */
function migrateV5(db: DB): void {
  const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (!owner) {
    // A fresh install: the categories, types, colours and diagram seeded by earlier versions belong to no one.
    // Projects get their own when they are created.
    const content = db.prepare('SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM epochs) + (SELECT COUNT(*) FROM folders) + (SELECT COUNT(*) FROM files) AS n').get() as { n: number };
    if (content.n > 0) throw new Error('The database has content but no user to give it to. Create a user with an older version first.');
    db.exec('DELETE FROM categories; DELETE FROM task_types; DELETE FROM status_colors; DELETE FROM diagrams;');
    return;
  }
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(owner.id);
  const pid = Number(db.prepare("INSERT INTO projects (key, name, owner_id) VALUES ('T', 'My project', ?)").run(owner.id).lastInsertRowid);
  for (const table of ['folders', 'epochs', 'tasks', 'files', 'diagrams', 'categories', 'task_types', 'status_colors']) {
    db.prepare(`UPDATE ${table} SET project_id = ?`).run(pid);
  }
  const counter = db.prepare("SELECT last FROM id_counters WHERE name = 'tasks'").get() as { last: number } | undefined;
  db.prepare('INSERT INTO id_counters (name, last) VALUES (?, ?)').run(`tasks:${pid}`, counter?.last ?? 0);
}

/** Data steps that run right after a migration's SQL, in the same transaction. Keyed by migration index. */
const DATA_STEPS: Record<number, (db: DB) => void> = {
  0: (db) => seed(db),
  1: (db) => seedV2(db),
  4: migrateV5,
};

function seedV2(db: DB): void {
  const setType = db.prepare('UPDATE task_types SET color = ? WHERE name = ?');
  for (const [name, color] of Object.entries(DEFAULT_TYPE_COLORS)) setType.run(color, name);
  const addStatus = db.prepare('INSERT OR IGNORE INTO status_colors (status, color) VALUES (?, ?)');
  for (const s of STATUSES) addStatus.run(s.id, s.color);
}

/**
 * Runs pending migrations. Foreign keys are switched off while they run, which is how SQLite says to rebuild
 * a table that others reference (dropping it would otherwise cascade-delete their rows); every reference is
 * then checked before the migration commits. The pragma can't change inside a transaction, hence out here.
 */
function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  if (version >= MIGRATIONS.length) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    while (version < MIGRATIONS.length) {
      db.exec('BEGIN');
      try {
        db.exec(MIGRATIONS[version]);
        DATA_STEPS[version]?.(db);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migration ${version + 1} left broken references: ${JSON.stringify(broken.slice(0, 5))}`);
        version++;
        db.exec(`PRAGMA user_version = ${version}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Version 1 defaults. Fresh installs drop them again in v5 (each project gets its own); kept for the record. */
function seed(db: DB): void {
  const addType = db.prepare('INSERT INTO task_types (name, sort_order) VALUES (?, ?)');
  DEFAULT_TYPES.forEach((t, i) => addType.run(t, i));
  db.prepare("INSERT INTO diagrams (name) VALUES ('Code Architecture')").run();
}

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** Runs fn inside a transaction (nested calls join the outer one). */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();

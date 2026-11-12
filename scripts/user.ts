// Usage:
//   npm run user -- add <username> [--admin]   create a user (prompts for password); the first one is always admin
//   npm run user -- passwd <username>          reset a password (prompts)
//   npm run user -- admin <username>           make an existing user an admin
//   npm run user -- list
// Set PM_PASSWORD to skip the prompt (e.g. for automation).
import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createUser, setPassword } from '../server/auth.ts';
import fs from 'node:fs';

/** Reads a password from the terminal without echoing anything (like sudo). */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('No interactive terminal. Set PM_PASSWORD instead.'));
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return (finish(), resolve(value));
        if (ch === '\u0003') return (finish(), reject(new Error('Cancelled'))); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function getPassword(): Promise<string> {
  if (process.env.PM_PASSWORD) return process.env.PM_PASSWORD;
  const a = await promptHidden('Password: ');
  const b = await promptHidden('Confirm password: ');
  if (a !== b) throw new Error('Passwords do not match');
  return a;
}

async function main() {
  const args = process.argv.slice(2);
  const admin = args.includes('--admin');
  const [cmd, name] = args.filter((a) => a !== '--admin');
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, 'pm.db'));
  try {
    if (cmd === 'list') {
      for (const u of db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all()) {
        console.log(`${u.id}\t${u.username}\t${u.is_admin ? 'admin' : 'user'}\t${u.created_at}`);
      }
    } else if (cmd === 'add' && name) {
      const id = createUser(db, name, await getPassword(), { admin });
      const isAdmin = (db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id) as { is_admin: number }).is_admin;
      console.log(`User "${name}" created${isAdmin ? ' (admin: can add accounts and see backups)' : ''}.`);
    } else if (cmd === 'admin' && name) {
      const res = db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(name);
      if (!res.changes) throw new Error(`No user named "${name}"`);
      console.log(`"${name}" is now an admin.`);
    } else if (cmd === 'passwd' && name) {
      const u = db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number } | undefined;
      if (!u) throw new Error(`No user named "${name}"`);
      setPassword(db, u.id, await getPassword());
      console.log(`Password for "${name}" updated. Existing sessions were signed out.`);
    } else {
      console.log(
        'Usage: npm run user -- add <username> [--admin] | passwd <username> | admin <username> | list\n' +
          'The first account is always an admin. Admins add accounts and see backups; nobody can see other people\'s projects.',
      );
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

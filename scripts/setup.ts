// npm run setup: gets this folder ready to run the Project Manager server on Windows, macOS or Linux.
//
//   1. checks the Node.js version
//   2. installs packages and builds the web app
//   3. asks which port to use and whether other devices may connect, and saves that in .env
//   4. creates the first account (an admin) if there is none yet
//   5. shows the addresses to open and how to keep the server running
//
// Safe to re-run at any time (for example to change the port, or after `git pull`).
// Non-interactive: npm run setup -- --port 9000 --local|--lan --yes
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseEnv } from 'node:util';
import { ENV_FILE, ROOT } from '../server/config.ts';

const MIN_NODE = 24;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const interactive = process.stdin.isTTY && !flag('yes');
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

const step = (s: string) => console.log(`\n${paint(36, `== ${s}`)}`);
const ok = (s: string) => console.log(paint(32, `   OK: ${s}`));
const note = (s: string) => console.log(`   ${s}`);
function stop(s: string): never {
  console.error(`\n${paint(31, `STOPPED: ${s}`)}`);
  process.exit(1);
}

async function ask(question: string, fallback: string): Promise<string> {
  if (!interactive) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`   ${question} [${fallback}]: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

function check(what: string, res: ReturnType<typeof spawnSync>): void {
  if (res.error) stop(`${what} failed: ${res.error.message}`);
  if (res.status !== 0) stop(`${what} failed (exit code ${res.status ?? res.signal}). Fix the error above and run setup again.`);
}

function npm(what: string, npmArgs: string[]): void {
  // `npm run setup` tells us where npm's own script is, so it can run without a shell. Otherwise npm is
  // npm.cmd on Windows, which only starts through a shell (given one command string: nothing to escape).
  const cli = process.env.npm_execpath;
  const res =
    cli && /npm-cli\.c?js$/.test(cli)
      ? spawnSync(process.execPath, [cli, ...npmArgs], { cwd: ROOT, stdio: 'inherit' })
      : spawnSync(`npm ${npmArgs.join(' ')}`, { cwd: ROOT, stdio: 'inherit', shell: true });
  check(what, res);
}

function defaultUsername(): string {
  try {
    const name = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '');
    return name.length >= 2 ? name.slice(0, 40) : 'admin';
  } catch {
    return 'admin';
  }
}

/** Resolves true if nothing is listening on host:port. */
function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function isOurServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** Writes KEY=value lines into .env, keeping every other line (comments, other settings) as it is. */
function saveEnv(values: Record<string, string>): void {
  const lines = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
    : ['# Project Manager settings (written by `npm run setup`; environment variables override these).'];
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'));
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}

async function main() {
  console.log(paint(1, 'Project Manager setup'));

  // ---- 1. Node.js -------------------------------------------------------------------------------
  step(`Checking Node.js (version ${MIN_NODE} or newer)`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) {
    stop(
      `Node.js ${process.versions.node} is too old. Install the current LTS from https://nodejs.org ` +
        `(Windows: winget install OpenJS.NodeJS.LTS), open a new terminal and run setup again.`,
    );
  }
  ok(`Node.js ${process.versions.node}`);

  // ---- 2. Packages and web app ------------------------------------------------------------------
  step('Installing packages and building the web app (takes a minute the first time)');
  npm('npm install', ['install', '--no-fund', '--no-audit']);
  npm('npm install (web)', ['--prefix', 'web', 'install', '--no-fund', '--no-audit']);
  npm('Building the web app', ['run', 'build']);
  ok('installed and built');

  // ---- 3. Port and network access ---------------------------------------------------------------
  step('Choosing the port and who can connect');
  const saved = fs.existsSync(ENV_FILE) ? (parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) as Record<string, string>) : {};
  let port = Number(option('port') ?? saved.PM_PORT ?? 8080);
  for (;;) {
    port = Number(await ask('Port for the web app and API (1024-65535)', String(port)));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      if (!interactive) stop(`--port must be a whole number from 1 to 65535.`);
      note('Type a whole number from 1 to 65535.');
      port = 8080;
      continue;
    }
    if (port < 1024 && process.platform !== 'win32') note('Ports below 1024 need root on macOS/Linux; 1024 or higher is easier.');
    if (await portFree(port, '0.0.0.0')) break;
    if (await isOurServer(port)) {
      note(`The Project Manager is already running on port ${port}; keeping it.`);
      break;
    }
    if (!interactive) stop(`Port ${port} is already used by another program. Pick another with --port.`);
    note(`Port ${port} is already used by another program. Pick another one.`);
  }
  const currentLan = (saved.PM_HOST ?? '0.0.0.0') !== '127.0.0.1';
  const lan = flag('local')
    ? false
    : flag('lan')
      ? true
      : /^y/i.test(await ask('Let phones and other computers on your network connect? (y/n)', currentLan ? 'y' : 'n'));
  saveEnv({ PM_PORT: String(port), PM_HOST: lan ? '0.0.0.0' : '127.0.0.1' });
  ok(`port ${port}, ${lan ? 'reachable from your network' : 'only from this computer'} (saved in .env)`);

  // ---- 4. First account -------------------------------------------------------------------------
  step('Accounts');
  const { openDb } = await import('../server/db.ts');
  const { loadConfig } = await import('../server/config.ts');
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, 'pm.db'));
  const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  db.close();
  if (users > 0) {
    ok(`${users} account(s) already exist (add more in Settings > Users, or: npm run user -- add <name>)`);
  } else if (!interactive) {
    note('No account yet. Create the first (admin) account with: npm run user -- add <name>');
  } else {
    note('Create your account. The first account is an admin: it can add accounts for other people.');
    let name = '';
    while (!/^[A-Za-z0-9_.-]{2,40}$/.test(name)) name = await ask('Username (2-40 letters, digits, _ . -)', defaultUsername());
    check('Creating the account', spawnSync(process.execPath, ['scripts/user.ts', 'add', name], { cwd: ROOT, stdio: 'inherit' }));
  }

  // ---- 5. Next steps ----------------------------------------------------------------------------
  step('Done. Next steps');
  const running = await isOurServer(port);
  note(running ? 'The server is running. Restart it to apply any change made above:' : 'Start the server:');
  if (process.platform === 'win32') {
    note('  As a Windows service (starts on boot; re-run it after changing the port), in PowerShell as Administrator:');
    note('    .\\scripts\\install-service.ps1');
    if (lan) note('    .\\scripts\\open-firewall.ps1      (lets devices on your network in)');
    note('  Or just for now:  npm start');
  } else {
    note('  npm start          (keep the terminal open; README.md shows how to run it as a service)');
  }
  note('');
  note('Then open:');
  note(`  http://localhost:${port}`);
  if (lan) for (const ip of lanAddresses()) note(`  http://${ip}:${port}    (from other devices on your network)`);
  note('');
  note('Coding agent (Claude Code, Codex, Cursor, Copilot...): in your code project folder, run');
  note(`  node "${path.join(ROOT, 'scripts', 'install-agent.mjs')}"`);
  note('From another computer, see README.md ("Connect your coding agent").');
  note('Away from home: docs/REMOTE-ACCESS.md (WireGuard or Tailscale; never open the port to the internet).');
}

main().catch((err: Error) => stop(err.message));

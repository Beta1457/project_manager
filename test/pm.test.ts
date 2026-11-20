// The pm command-line client (tools/pm.mjs): trying the server's addresses in order, and saving changes on this
// computer while none answers, to send them later. pm runs as a child process against a real listening server, an
// address where nothing listens, and a web server that isn't the Project Manager.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';
import { createUser } from '../server/auth.ts';
import type { AppContext } from '../server/context.ts';
import { createProject } from '../server/routes/projects.ts';

type Json = Record<string, any>;
interface Run {
  code: number;
  out: string;
  err: string;
}

const PM = fileURLToPath(new URL('../tools/pm.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cli-test-'));
let app: FastifyInstance;
let ctx: AppContext;
let token = '';
/** The Project Manager. */
let real = '';
/** Addresses where nothing listens. */
let closed = '';
let closed2 = '';
/** A web server that answers everything with a page, like a router's login page would. */
let impostor = '';
let impostorServer: http.Server;
const impostorAuth: Array<string | undefined> = [];

const portOf = (server: net.Server | http.Server) => (server.address() as net.AddressInfo).port;

/** A port nothing listens on: one the system has just handed out and taken back. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The API as the same token pm uses. */
async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { authorization: `Bearer ${token}`, 'x-pm-project': 'T' },
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {} };
}

async function newTask(title: string): Promise<string> {
  const r = await api('POST', '/api/v1/tasks', { title });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.key as string;
}

/** Where pm remembers which of these addresses answered (or that none did). */
const memoFile = (temp: string, urls: string[]) =>
  path.join(temp, `pm-server-${crypto.createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 16)}.json`);

let workspaces = 0;
/** A folder with its own .pm.json, home folder (where the offline queue lives) and temp folder. */
function workspace(cfg: Json) {
  const root = path.join(tmp, `ws-${++workspaces}`);
  const dir = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  for (const d of [dir, home, temp]) fs.mkdirSync(d, { recursive: true });
  const configure = (c: Json) => fs.writeFileSync(path.join(dir, '.pm.json'), JSON.stringify({ token, project: 'T', ...c }));
  configure(cfg);
  const run = (...args: string[]) =>
    new Promise<Run>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp };
      delete env.PM_URL;
      delete env.PM_TOKEN;
      delete env.PM_PROJECT;
      // Never spawnSync: the server answering pm runs in this process.
      const child = spawn(process.execPath, [PM, ...args], { cwd: dir, env });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    });
  const queueDir = path.join(home, '.pm-offline');
  const queueFile = () => {
    const names = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((n) => n.endsWith('.json')) : [];
    assert.ok(names.length <= 1, `one queue per .pm.json, found ${names.join(', ')}`);
    return names.length ? path.join(queueDir, names[0]) : undefined;
  };
  const queue = (): Json | undefined => {
    const file = queueFile();
    return file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Json) : undefined;
  };
  const editQueue = (change: (box: Json) => void) => {
    const file = queueFile();
    assert.ok(file, 'something is saved offline');
    const box = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
    change(box);
    fs.writeFileSync(file, JSON.stringify(box));
  };
  return { dir, temp, queueDir, configure, run, queue, queueFile, editQueue };
}

const ok = (r: Run) => assert.equal(r.code, 0, `pm failed:\n${r.out}\n${r.err}`);

before(async () => {
  const built = await buildApp(
    { port: 0, host: '127.0.0.1', dataDir: tmp, webDist: path.join(tmp, 'no-web'), backupIntervalHours: 0, backupKeep: 3, maxUploadMb: 5 },
    { dbFile: ':memory:' },
  );
  app = built.app;
  ctx = built.ctx;
  const alice = createUser(ctx.db, 'alice', 'correct-horse');
  createProject(ctx.db, alice, { key: 'T', name: 'Test game' });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'correct-horse' } });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    headers: { cookie, 'x-pm-client': 'web' },
    payload: { name: 'claude' },
  });
  assert.equal(created.statusCode, 201);
  token = (JSON.parse(created.body) as Json).token;

  await app.listen({ port: 0, host: '127.0.0.1' });
  real = `http://127.0.0.1:${portOf(app.server)}`;
  closed = `http://127.0.0.1:${await freePort()}`;
  do closed2 = `http://127.0.0.1:${await freePort()}`;
  while (closed2 === closed);
  impostorServer = http.createServer((req, res) => {
    impostorAuth.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Router login</title>');
  });
  await new Promise<void>((resolve) => impostorServer.listen(0, '127.0.0.1', resolve));
  impostor = `http://127.0.0.1:${portOf(impostorServer)}`;
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => impostorServer.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pm: with one address, that address is used as before and nothing is remembered', async () => {
  const ws = workspace({ url: real });
  const r = await ws.run('whoami');
  ok(r);
  assert.ok(r.out.includes(`Connected to ${real} as claude`), r.out);
  assert.doesNotMatch(r.out, /Server addresses/);
  assert.deepEqual(fs.readdirSync(ws.temp), []);
});

test('pm: falls back to the next address, and remembers one it can trust', async () => {
  const ws = workspace({ url: closed, fallbackUrls: [real] });
  let r = await ws.run('whoami');
  ok(r);
  assert.ok(r.out.includes(`Connected to ${real} as claude`), r.out);
  assert.ok(r.out.includes(`Server addresses, in the order pm tries them: ${closed}, ${real}`), r.out);
  assert.equal(JSON.parse(fs.readFileSync(memoFile(ws.temp, [closed, real]), 'utf8')).url, real);
  // Changes go there too.
  const key = await newTask('Fallback');
  r = await ws.run('task', 'note', key, 'sent the long way round');
  ok(r);
  assert.equal(ws.queue(), undefined);
  assert.ok((await api('GET', `/api/v1/tasks/${key}`)).body.activity.some((a: Json) => a.message === 'sent the long way round'));
});

test('pm: a remembered address that stops answering is swapped for one that answers', async () => {
  const ws = workspace({ url: closed, fallbackUrls: [real] });
  fs.writeFileSync(memoFile(ws.temp, [closed, real]), JSON.stringify({ url: closed, at: Date.now() }));
  const key = await newTask('Remembered');
  const r = await ws.run('task', 'note', key, 'still here');
  ok(r);
  assert.match(r.out, new RegExp(`Note added to ${key}`));
  assert.equal(ws.queue(), undefined, 'sent, not saved for later');
  assert.equal(JSON.parse(fs.readFileSync(memoFile(ws.temp, [closed, real]), 'utf8')).url, real);
});

test('pm: an address that answers but is not the Project Manager never gets the token', async () => {
  impostorAuth.length = 0;
  const ws = workspace({ url: impostor, fallbackUrls: [real] });
  let r = await ws.run('whoami');
  ok(r);
  assert.ok(r.out.includes(`Connected to ${real}`), r.out);
  const lone = workspace({ url: impostor, fallbackUrls: [closed] });
  r = await lone.run('task', 'list');
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`${impostor} (not the Project Manager)`), r.err);
  assert.ok(impostorAuth.length >= 2, 'it was asked whether it is the Project Manager');
  assert.ok(
    impostorAuth.every((a) => a === undefined),
    'without the token',
  );
});

test('pm: when nothing answers, a lookup fails naming every address; a refused token is not "offline"', async () => {
  const ws = workspace({ url: closed, fallbackUrls: [closed2] });
  let r = await ws.run('task', 'list');
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(closed) && r.err.includes(closed2), r.err);
  assert.equal(ws.queue(), undefined, 'lookups are never saved');

  const refused = workspace({ url: real, token: 'pm_not_a_real_token' });
  r = await refused.run('task', 'note', 'T-1', 'hello');
  assert.equal(r.code, 1);
  assert.match(r.err, /401/);
  assert.equal(refused.queue(), undefined);
});

test('pm offline: changes are saved, then sent in order by the next command that reaches the server', async () => {
  const key = await newTask('Offline order');
  const ws = workspace({ url: closed });
  let r = await ws.run('task', 'status', key, 'In Progress');
  ok(r);
  assert.match(r.out, /Saved offline: pm task status/);
  r = await ws.run('task', 'note', key, 'written on a plane');
  ok(r);
  assert.match(r.out, /could not be reached a moment ago/, 'no waiting on the same timeouts again');
  r = await ws.run('task', 'status', key, 'Alpha QA', '--json');
  ok(r);
  const saved = JSON.parse(r.out) as Json;
  assert.equal(saved.savedOffline, true);
  assert.equal(saved.waiting, 3);
  r = await ws.run('task', 'get', key);
  assert.equal(r.code, 1, 'looking things up needs the server');
  assert.equal(ws.queue()?.entries.length, 3);
  assert.equal((await api('GET', `/api/v1/tasks/${key}`)).body.statusLabel, 'Open');

  ws.configure({ url: real });
  r = await ws.run('task', 'get', key);
  ok(r);
  assert.match(r.err, /sent 3 changes saved while the server couldn't be reached/);
  assert.ok(r.out.startsWith(`${key}  [Alpha QA]`), r.out);
  assert.equal(ws.queue(), undefined);
  const task = (await api('GET', `/api/v1/tasks/${key}`)).body;
  assert.equal(task.statusLabel, 'Alpha QA');
  assert.ok(task.activity.some((a: Json) => a.kind === 'comment' && a.message === 'written on a plane'));
});

test('pm offline: a task created offline goes by NEW_n, in later commands too, until it is sent', async () => {
  const ws = workspace({ url: closed });
  const notes = path.join(ws.dir, 'notes.md');
  fs.writeFileSync(notes, 'Written before take-off');
  let r = await ws.run('task', 'create', '--title', 'Offline parent', '--desc-file', notes);
  ok(r);
  assert.match(r.out, /Saved offline as NEW_1/);
  fs.writeFileSync(notes, 'Changed later'); // the text saved is the text of the time
  r = await ws.run('task', 'create', '--title', 'Offline child', '--parent', 'NEW_1');
  ok(r);
  assert.match(r.out, /Saved offline as NEW_2/);
  ok(await ws.run('task', 'status', 'new_2', 'In Progress'));
  r = await ws.run('task', 'note', 'NEW_7', 'a typo');
  assert.equal(r.code, 1);
  assert.match(r.err, /NEW_7 is not a task saved offline here/);

  ws.configure({ url: real });
  r = await ws.run('queue', 'send');
  ok(r);
  const parentKey = /NEW_1 is (T-\d+)/.exec(r.out)?.[1];
  const childKey = /NEW_2 is (T-\d+)/.exec(r.out)?.[1];
  assert.ok(parentKey && childKey, r.out);
  const child = (await api('GET', `/api/v1/tasks/${childKey}`)).body;
  assert.equal(child.parent.key, parentKey);
  assert.equal(child.statusLabel, 'In Progress');
  assert.equal((await api('GET', `/api/v1/tasks/${parentKey}`)).body.description, 'Written before take-off');
  // The temporary keys keep working for a while after.
  r = await ws.run('task', 'get', 'NEW_2');
  ok(r);
  assert.ok(r.out.startsWith(`${childKey}  [In Progress]`), r.out);
});

test('pm offline: a timer started offline is logged with its real start and length', async () => {
  const key = await newTask('Offline timer');
  const ws = workspace({ url: closed });
  let r = await ws.run('time', 'start', '--task', key, '--note', 'deep work');
  ok(r);
  assert.match(r.out, /Timer started on .* on this computer/);
  const startedAt = new Date(Date.now() - 40 * 60000).toISOString();
  ws.editQueue((box) => {
    box.timer.startedAt = startedAt;
  });
  r = await ws.run('time', 'status');
  ok(r);
  assert.match(r.out, /^40m \(running on this computer since/);
  r = await ws.run('time', 'stop');
  ok(r);
  assert.match(r.out, /Timer stopped: 40m on .*saved until the server can be reached/);
  ok(await ws.run('time', 'log', '25m', '--task', key, '--note', 'notes'));
  const loggedAt = Date.now();

  ws.configure({ url: real });
  r = await ws.run('queue', 'send');
  ok(r);
  assert.match(r.out, /no timer was running on the server/);
  const { entries } = (await api('GET', `/api/v1/time?taskId=${key}`)).body;
  const timed = entries.find((e: Json) => e.note === 'deep work');
  assert.equal(timed.minutes, 40);
  assert.equal(timed.startedAt, startedAt);
  const logged = entries.find((e: Json) => e.note === 'notes');
  assert.equal(logged.minutes, 25);
  assert.ok(Math.abs(Date.parse(logged.startedAt) - loggedAt) < 60000, 'logged when it was done, not when it was sent');
});

test("pm offline: the server's timer, stopped offline, keeps the length it had then", async () => {
  const key = await newTask('Server timer');
  const ws = workspace({ url: real });
  ok(await ws.run('time', 'start', '--task', key));
  const running = (await api('GET', '/api/v1/time/running')).body.entry;
  ctx.db.prepare('UPDATE time_entries SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 50 * 60000).toISOString(), running.id);

  ws.configure({ url: closed });
  let r = await ws.run('time', 'stop', '--note', 'landed');
  ok(r);
  assert.match(r.out, /the timer running on the server stops as of/);
  ws.editQueue((box) => {
    box.entries[0].stopAt = new Date(Date.now() - 10 * 60000).toISOString();
  });

  ws.configure({ url: real });
  r = await ws.run('queue', 'send');
  ok(r);
  assert.match(r.out, /stopped the timer on .*: 40m/);
  const entry = (await api('GET', `/api/v1/time?taskId=${key}`)).body.entries[0];
  assert.equal(entry.running, false);
  assert.equal(entry.minutes, 40);
  assert.equal(entry.note, 'landed');
});

test('pm offline: a timer started offline can be dropped', async () => {
  const key = await newTask('Dropped timer');
  const ws = workspace({ url: closed });
  ok(await ws.run('time', 'start', '--task', key));
  const r = await ws.run('queue', 'drop', 'timer');
  ok(r);
  assert.match(r.out, /Dropped the timer started offline/);
  assert.equal(ws.queue()?.timer, null);
});

test('pm offline: a change whose connection drops while it is being sent is never saved to be sent again', async () => {
  // It may have been made already: sending it again later could make it twice.
  const dropper = net.createServer((socket) => socket.once('data', () => socket.destroy()));
  await new Promise<void>((resolve) => dropper.listen(0, '127.0.0.1', resolve));
  try {
    const ws = workspace({ url: `http://127.0.0.1:${portOf(dropper)}` });
    const r = await ws.run('task', 'note', 'T-1', 'maybe sent');
    assert.equal(r.code, 1);
    assert.match(r.err, /may or may not have been made/);
    assert.equal(ws.queue(), undefined);
  } finally {
    await new Promise<void>((resolve) => dropper.close(() => resolve()));
  }
});

test('pm offline: a change the server refuses is kept aside, and the others still go', async () => {
  const key = await newTask('Refusals');
  const ws = workspace({ url: closed });
  ok(await ws.run('task', 'status', key, 'Not a real column'));
  ok(await ws.run('task', 'note', key, 'this one is fine'));

  ws.configure({ url: real });
  let r = await ws.run('task', 'list');
  ok(r);
  assert.match(r.err, /sent 1 change saved/);
  assert.match(r.err, /1 saved change was refused, and kept aside/);
  assert.ok((await api('GET', `/api/v1/tasks/${key}`)).body.activity.some((a: Json) => a.message === 'this one is fine'));
  r = await ws.run('queue');
  ok(r);
  assert.match(r.out, /Refused when sent/);
  assert.match(r.out, /Not a real column/);
  ok(await ws.run('queue', 'drop', 'failed'));
  r = await ws.run('queue');
  assert.match(r.out, /Nothing is saved offline/);
});

test('pm offline: commands run side by side are all saved, and sent once each', async () => {
  const key = await newTask('Side by side');
  const ws = workspace({ url: closed });
  const runs = await Promise.all([1, 2, 3, 4, 5].map((n) => ws.run('task', 'note', key, `note ${n}`)));
  for (const r of runs) ok(r);
  const box = ws.queue();
  assert.equal(box?.entries.length, 5);
  assert.equal(new Set(box?.entries.map((e: Json) => e.id)).size, 5);
  assert.deepEqual(
    fs.readdirSync(ws.queueDir).filter((n) => !n.endsWith('.json')),
    [],
    'no lock or temporary file left behind',
  );

  ws.configure({ url: real });
  ok(await ws.run('queue', 'send'));
  const notes = (await api('GET', `/api/v1/tasks/${key}`)).body.activity.filter((a: Json) => a.kind === 'comment');
  assert.deepEqual(notes.map((a: Json) => a.message).sort(), ['note 1', 'note 2', 'note 3', 'note 4', 'note 5']);
});

test('pm offline: the lock of a pm that was stopped halfway is taken over', async () => {
  const key = await newTask('Left-behind lock');
  const ws = workspace({ url: closed });
  ok(await ws.run('task', 'note', key, 'first'));
  const lock = `${ws.queueFile()}.lock`;
  // A pm that isn't running any more.
  const gone = spawn(process.execPath, ['-e', '']);
  await once(gone, 'close');
  fs.writeFileSync(lock, `${gone.pid}@${os.hostname()}`);
  ok(await ws.run('task', 'note', key, 'second'));
  // One that has been silent for a minute: it would have touched the lock every few seconds.
  fs.writeFileSync(lock, `${process.pid}@${os.hostname()}`);
  const minuteAgo = new Date(Date.now() - 60000);
  fs.utimesSync(lock, minuteAgo, minuteAgo);
  ok(await ws.run('task', 'note', key, 'third'));
  assert.deepEqual(
    ws.queue()?.entries.map((e: Json) => e.argv.at(-1)),
    ['first', 'second', 'third'],
  );
  assert.equal(fs.existsSync(lock), false);
});

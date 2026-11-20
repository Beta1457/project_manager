#!/usr/bin/env node
// Part of Project Manager. Copyright (c) 2026 Bettafish Games, LLC.
// SPDX-License-Identifier: MIT (the full text is in Project Manager's LICENSE file). Keep this notice in copies.
//
// pm — command-line client for the Project Manager API.
// Zero dependencies; requires Node 18+.
//
// Configuration (first match wins):
//   1. env PM_URL and PM_TOKEN (and PM_PROJECT)
//   2. .pm.json in the current directory or any parent: {"url": "http://SERVER:8080", "token": "pm_...", "project": "KEY"}
//   3. ~/.pm.json
// "project" picks which of your projects the commands work in; --project KEY overrides it for one command.
// "fallbackUrls": ["https://pm.example.ts.net"] in .pm.json lists other addresses of the same server, tried in order
// when "url" doesn't answer (the home address first, say, then Tailscale when away). PM_URL can hold several
// addresses too, separated by commas.
//
// When no address answers, changes to tasks and time tracking are saved on this computer (~/.pm-offline) and sent by
// the next pm command that reaches the server: see "Offline" in `node pm.mjs help`.
//
// Run `node pm.mjs help` for commands.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- config ----

function findConfig() {
  let dir = process.cwd();
  for (;;) {
    const f = path.join(dir, '.pm.json');
    if (fs.existsSync(f)) return f;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = path.join(os.homedir(), '.pm.json');
  return fs.existsSync(home) ? home : null;
}

function loadConfig() {
  let url = process.env.PM_URL;
  let token = process.env.PM_TOKEN;
  let project = process.env.PM_PROJECT;
  let fallbacks = [];
  let file = null;
  let urlFrom = 'PM_URL';
  if (!url || !token) {
    file = findConfig();
    if (file) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!url) {
        url = cfg.url;
        urlFrom = file;
        fallbacks = [].concat(cfg.fallbackUrls ?? []);
      }
      token ||= cfg.token;
      project ||= cfg.project;
    }
  }
  if (!url || !token) fail('Not configured. Set PM_URL and PM_TOKEN, or create .pm.json with {"url": "...", "token": "...", "project": "KEY"}');
  // --project KEY (any command) works in another of your projects just this once.
  if (PROJECT_FLAG) project = PROJECT_FLAG;
  // The server's addresses in the order to try them: "url" (or each one in PM_URL), then "fallbackUrls".
  const urls = [...new Set([...String(url).split(','), ...fallbacks].map((u) => String(u).trim().replace(/\/+$/, '')).filter(Boolean))];
  for (const u of urls) {
    let protocol;
    try {
      ({ protocol } = new URL(u));
    } catch {
      /* said below */
    }
    if (protocol !== 'http:' && protocol !== 'https:') fail(`"${u}" in ${urlFrom} is not a web address like http://SERVER:8080 or https://SERVER`);
  }
  return { urls, token, project: project ? String(project) : undefined, file };
}

/** Headers for every request: the token, and the project the command works in. */
function authHeaders() {
  CFG ??= loadConfig();
  const headers = { authorization: `Bearer ${CFG.token}` };
  if (CFG.project) headers['x-pm-project'] = CFG.project;
  return headers;
}

// ------------------------------------------------------------------ args ----

const REPEATABLE = new Set(['check']);
const BOOLEAN = new Set(['json', 'undo', 'help', 'remove', 'delete-time', 'replace', 'yes', 'with-children', 'with-subtasks', 'top', 'bottom']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (BOOLEAN.has(key)) {
        val = true;
      } else {
        val = argv[++i];
        if (val === undefined) fail(`Missing value for --${key}`);
      }
      if (REPEATABLE.has(key)) (flags[key] ??= []).push(val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

// ----------------------------------------------------------------- server ----

/** Nothing reached the server: no address answered, or a connection failed before anything was sent. */
class Offline extends Error {}

/** How long the address that answered is used before the addresses are checked in order again. */
const SERVER_MEMO_MS = 10 * 60 * 1000;
/** After no address answered, how long changes are saved offline straight away instead of waiting on timeouts again. */
const OFFLINE_MEMO_MS = 60 * 1000;
/** Fetch failures where nothing reached the server, so it can't have done anything. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT', 'bad port']);
const notSent = (code) => NOT_SENT.has(code) || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/.test(code); // TLS fails before sending

/** Why a fetch failed, in a word: ECONNREFUSED, ENOTFOUND, timeout... */
function errCode(err) {
  if (err?.name === 'TimeoutError') return 'timeout';
  const cause = err?.cause;
  return String(cause?.code ?? cause?.errors?.find((e) => e?.code)?.code ?? cause?.message ?? err?.message ?? err);
}

/** An address no other computer can answer for: https (its certificate proves which server it is), or this computer. */
function trusted(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' || hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

/**
 * What pm remembers between commands (each one is a new process): which address answered, or that none did. In the
 * temp folder; losing it only means checking the addresses again.
 */
function memoFile() {
  const key = crypto.createHash('sha256').update(CFG.urls.join('\n')).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `pm-server-${key}.json`);
}
function readMemo() {
  try {
    const memo = JSON.parse(fs.readFileSync(memoFile(), 'utf8'));
    const age = Date.now() - memo.at;
    return age >= 0 ? { ...memo, age } : {};
  } catch {
    return {};
  }
}
function writeMemo(memo) {
  try {
    if (memo) fs.writeFileSync(memoFile(), JSON.stringify({ ...memo, at: Date.now() }), { mode: 0o600 });
    else fs.rmSync(memoFile(), { force: true });
  } catch {
    /* only a shortcut */
  }
}
/** No address answered a moment ago, so a change can be saved offline without waiting on timeouts again. */
function offlineLately() {
  const memo = readMemo();
  return memo.offline === true && memo.age < OFFLINE_MEMO_MS;
}
/** No address answers: remembers that for a minute, and stops whatever was being sent. */
function goOffline(why) {
  CFG.offline = why;
  writeMemo({ offline: true });
  throw new Offline(why);
}

/** Whether the Project Manager answers at this address. Asked without the token, before the token goes there. */
async function probe(base, ms) {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(ms) });
  const data = await res.json().catch(() => ({}));
  if (data.ok !== true) throw new Error(res.ok ? 'not the Project Manager' : `HTTP ${res.status}`);
}

/**
 * The server address to use. With one address, that one. With fallbacks, the first in order where the Project Manager
 * answers. That's remembered for a few minutes when it's https or this computer; a plain-http address of another
 * computer is checked every time instead, so the token never goes to a different computer that has the same address
 * on another network. `failed`: an address that just stopped answering, checked last.
 */
async function serverUrl({ failed } = {}) {
  CFG ??= loadConfig();
  if (CFG.offline) throw new Offline(CFG.offline);
  if (CFG.base && !failed) return CFG.base;
  if (CFG.urls.length === 1) return (CFG.base = CFG.urls[0]);
  CFG.remembered = false;
  const memo = failed ? {} : readMemo();
  if (memo.url && memo.age < SERVER_MEMO_MS && CFG.urls.includes(memo.url) && trusted(memo.url)) {
    CFG.remembered = true;
    return (CFG.base = memo.url);
  }
  const order = failed ? [...CFG.urls.filter((u) => u !== failed), failed] : CFG.urls;
  const tried = [];
  for (const [i, base] of order.entries()) {
    try {
      // A short wait for all but the last, so an address that isn't there (home, away) doesn't hold things up.
      await probe(base, i < order.length - 1 ? 3000 : 6000);
      writeMemo(trusted(base) ? { url: base } : null); // replaces "none answered", if that was remembered
      CFG.offlineMemo = false;
      return (CFG.base = base);
    } catch (err) {
      tried.push(`${base} (${errCode(err)})`);
    }
  }
  return goOffline(`Cannot reach the Project Manager at ${tried.join(' or ')}`);
}

// ------------------------------------------------------------------- http ----

let CFG;
let PROJECT_FLAG; // --project KEY, set before any command runs
/** Changes this command sent that reached the server. It can only be saved for later while this is 0. */
let WROTE = 0;

/**
 * fetch on the server. A read whose connection fails, or a change that never left this computer, means offline (see
 * Offline). A remembered address that stopped answering is swapped for one that answers, once.
 */
async function send(url, init = {}) {
  const read = !init.method || init.method === 'GET';
  let base = await serverUrl();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(base + url, init);
      if (!read && !REPLAYING) WROTE++;
      if (CFG.offlineMemo) {
        // It answers again, so changes go straight to it instead of being saved offline for the rest of the minute.
        CFG.offlineMemo = false;
        writeMemo(null);
      }
      return res;
    } catch (err) {
      const code = errCode(err);
      if (!read && !notSent(code)) {
        fail(`Lost the connection to ${base} while sending (${code}). The change may or may not have been made: check before trying again.`);
      }
      if (attempt === 0 && CFG.remembered) base = await serverUrl({ failed: base });
      else goOffline(`Cannot reach ${base} (${code})`);
    }
  }
}

/** Calls the API. `soft`: return { error, status } instead of exiting when the server says no. */
async function http(method, url, body, { soft = false } = {}) {
  const headers = authHeaders();
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined || (method !== 'GET' && method !== 'DELETE')) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  const res = await send(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const error = data.error ?? text;
    if (soft) return { error, status: res.status };
    // A project that was renamed or deleted: say where the setting lives.
    if (res.status === 404 && CFG.project && /^Project "/.test(error)) {
      fail(`${error}. Fix "project" in ${CFG.file ?? 'PM_PROJECT'} (pm project list shows your projects).`);
    }
    fail(`${res.status}: ${error}`);
  }
  return data;
}
/** GET returning the raw Response (file contents). */
async function rawGet(url) {
  const res = await send(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {}
    fail(`${res.status}: ${msg}`);
  }
  return res;
}
const get = (u) => http('GET', u);
const post = (u, b) => http('POST', u, b);
const patch = (u, b) => http('PATCH', u, b);
const del = (u) => http('DELETE', u);

// ---------------------------------------------------------------- helpers ----

/** A saved offline change that failed when it was sent later (see flushOutbox). Anywhere else, fail() ends pm. */
class Failed extends Error {}
let REPLAYING = false;

function fail(msg) {
  if (REPLAYING) throw new Failed(msg);
  console.error(`pm: ${msg}`);
  process.exit(1);
}

const fmtMin = (m) => (m == null ? '-' : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const list = (v) => (v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));

function readDesc(flags) {
  if (flags['desc-file']) return fs.readFileSync(flags['desc-file'], 'utf8');
  // Taken literally: unescaping "\n" would mangle Windows paths like C:\new\notes.md. Use --desc-file for multi-line text.
  if (flags.desc !== undefined) return String(flags.desc);
  return undefined;
}

let CURRENT;
/** The project the commands work in, as the server sees it (fetched once per run). */
async function currentProject() {
  CURRENT ??= await get('/api/v1/projects/current');
  return CURRENT;
}

/** "APP-12" or "app-12" → "APP-12"; a bare "12" (or "#12") means task 12 of the current project. */
async function taskRef(raw, what = 'task key') {
  const s = String(need(raw, what)).trim().replace(/^#/, '');
  if (TEMP_KEY.test(s)) return tempKeyRef(s.toUpperCase());
  if (/^\d+$/.test(s)) return `${(await currentProject()).key}-${s}`;
  if (/^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/.test(s)) return s.toUpperCase();
  fail(`"${raw}" is not a task key. Keys look like ${CURRENT?.key ?? 'APP'}-12 (a bare 12 means task 12 of the current project).`);
}

async function resolveEpoch(ref) {
  if (ref === undefined) return undefined;
  if (ref === '' || ref === 'none' || ref === 'null') return null;
  if (/^\d+$/.test(ref)) return Number(ref);
  const { epochs } = await get('/api/v1/epochs');
  return pickByName(epochs, ref, 'epoch', (e) => e.name);
}

async function resolveFolder(ref) {
  if (ref === undefined) return undefined;
  // "root" = top level (for folders and files), "inbox" = no folder (for tasks); both are stored as null.
  if (ref === '' || ref === 'none' || ref === 'null' || ref === 'inbox' || ref === 'root') return null;
  if (/^\d+$/.test(ref)) return Number(ref);
  const { folders } = await get('/api/v1/folders');
  return pickByName(folders, ref, 'folder', (f) => f.name);
}

/** Finds exactly one item by case-insensitive name; fails with the candidates' ids if none or several match. */
function pickByName(items, ref, what, nameOf) {
  const matches = items.filter((x) => nameOf(x).toLowerCase() === String(ref).toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) fail(`Several ${what}s are named "${ref}" (ids ${matches.map((x) => x.id).join(', ')}). Use the id instead.`);
  fail(`No ${what} named "${ref}". Existing: ${items.map((x) => `${x.id}:${nameOf(x)}`).join(', ') || '(none)'}`);
}

async function resolveCategory(ref) {
  if (/^\d+$/.test(String(ref))) return Number(ref);
  const { categories } = await get('/api/v1/categories');
  return pickByName(categories, ref, 'category', (c) => c.name);
}

/** The stored spelling of a task type (type names match case-insensitively). */
async function resolveType(ref) {
  const { types } = await get('/api/v1/types');
  const match = types.find((t) => t.toLowerCase() === String(ref).toLowerCase());
  if (!match) fail(`No type named "${ref}". Existing: ${types.join(', ')}`);
  return match;
}

function printTask(t, detail = false) {
  const cats = t.categories?.map((c) => c.name).join(', ');
  // Blocked: it has caught up with a task that blocks it (same column or further on) and waits for it to move on.
  console.log(`${t.key}  [${t.statusLabel}]  ${t.title}${t.openBlockers ? `  BLOCKED by ${plural(t.openBlockers, 'task', 'tasks')}` : ''}`);
  console.log(`  type=${t.type} priority=${t.priority}${t.epochName ? ` epoch="${t.epochName}"` : ''}${cats ? ` categories=${cats}` : ''}` +
    ` time=${fmtMin(t.loggedMinutes)}${t.estimateMinutes ? `/${fmtMin(t.estimateMinutes)}` : ''}` +
    `${t.parent ? ` parent=${t.parent.key}` : ''}${t.subtasks?.total ? ` subtasks=${t.subtasks.done}/${t.subtasks.total} done` : ''}` +
    `${t.subtasks?.all > t.subtasks?.total ? ` (${t.subtasks.all} at all levels)` : ''}`);
  if (!detail) return;
  if (t.parent) {
    // Sub-tasks can have sub-tasks: name the tasks above the parent too, from the top-level one down.
    const above = (t.ancestors ?? []).slice(0, -1).map((a) => a.key);
    console.log(`  sub-task of ${t.parent.key} "${t.parent.title}"${above.length ? ` (under ${above.join(' > ')})` : ''}`);
  }
  if (t.description) console.log(`\n${t.description}\n`);
  if (t.children?.length) {
    console.log('Sub-tasks:');
    for (const c of t.children) printSubtask(c);
  }
  if (t.checklistItems?.length) {
    console.log('Checklist:');
    for (const i of t.checklistItems) console.log(`  [${i.done ? 'x' : ' '}] #${i.id} ${i.text}`);
  }
  if (t.links?.length) {
    console.log('Links:');
    for (const l of t.links) {
      // A "blocks" link holding a task up right now: this one ("blocked by") or the other one ("blocks").
      const now = l.blocking ? (l.outgoing ? '  (waiting for this task)' : '  (holding this task up)') : '';
      console.log(`  ${l.label} ${l.task.key} [${l.task.statusLabel}] ${l.task.title}${now}`);
    }
  }
  if (t.activity?.length) {
    console.log('Recent activity:');
    for (const a of t.activity.slice(0, 10)) console.log(`  ${a.createdAt.slice(0, 16).replace('T', ' ')} ${a.actor}: ${a.message}`);
  }
}

/** One line per sub-task: key, status, title, where it lives when that is an epoch, and its own sub-tasks. */
function printSubtask(c) {
  const own = c.subtasks?.total ? `  + ${plural(c.subtasks.total, 'sub-task', 'sub-tasks')} of its own` : '';
  console.log(`  ${c.key} [${c.statusLabel}] ${c.title}${c.epochName ? `  (epoch "${c.epochName}")` : ''}${own}`);
}

/** Something a user would type as a task: APP-12, app-12, 12 or #12, or NEW_3 for one created offline. */
const KEY_LIKE = /^#?\d+$|^[A-Za-z][A-Za-z0-9]{0,9}-\d+$|^NEW_\d+$/i;

/**
 * The task keys at the start of a command line, and the words after them:
 * "APP-1 APP-2 12 Alpha QA" → keys APP-1, APP-2 and APP-12 (in the current project), rest "Alpha QA".
 */
async function leadingKeys(args) {
  const end = args.findIndex((a) => !KEY_LIKE.test(String(a).trim()));
  const raw = end === -1 ? args : args.slice(0, end);
  if (!raw.length) await taskRef(args[0]); // says what's wrong with the first word, or that there's none
  const keys = [];
  for (const r of raw) keys.push(await taskRef(r));
  return { keys: [...new Set(keys)], rest: end === -1 ? [] : args.slice(end) };
}

/** --parent APP-3 → "APP-3"; none (also null or empty) → null, meaning a top-level task. */
async function parentRef(raw) {
  if (raw === undefined) return undefined;
  if (/^(none|null|)$/i.test(String(raw).trim())) return null;
  return taskRef(raw, 'parent task key');
}

/** "1 box", "3 boxes". */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Tasks in the board's order: column by column (Open first), each column from the top down. */
async function boardOrder(tasks) {
  // One column: the server already lists it from the top down.
  if (new Set(tasks.map((t) => t.status)).size < 2) return tasks;
  const column = new Map((await get('/api/v1/meta')).statuses.map((s, i) => [s.id, i]));
  const at = (t) => column.get(t.status) ?? column.size;
  return [...tasks].sort((a, b) => at(a) - at(b) || a.sortOrder - b.sortOrder || a.id - b.id);
}

const PLACES = ['top', 'bottom', 'before', 'after'];
const REORDER_USAGE = 'pm task reorder APP-12 [APP-13 ...] --top | --bottom | --before APP-9 | --after APP-9';

const out = (flags, data, human) => (flags.json ? console.log(JSON.stringify(data, null, 2)) : human(data));

/** What a diagram import changes: "add 7 boxes and 8 arrows, update 1 box" ("added …" once done), or "change nothing". */
function importSummary(r, done) {
  const count = (n, one, many) => (n ? plural(n, one, many) : '');
  const parts = [['added', 'add'], ['updated', 'update'], ['removed', 'remove']].flatMap(([key, verb]) => {
    const what = [count(r.nodes[key], 'box', 'boxes'), count(r.edges[key], 'arrow', 'arrows')].filter(Boolean);
    return what.length ? [`${done ? key : verb} ${what.join(' and ')}`] : [];
  });
  if (r.settingsChanged) parts.push(`${done ? 'changed' : 'change'} the layout settings`);
  return parts.length ? parts.join(', ') : done ? 'nothing changed' : 'change nothing';
}

function taskBody(flags) {
  const body = {};
  if (flags.title !== undefined) body.title = flags.title;
  const desc = readDesc(flags);
  if (desc !== undefined) body.description = desc;
  for (const k of ['type', 'status', 'priority', 'note']) if (flags[k] !== undefined) body[k] = flags[k];
  if (flags.category !== undefined) body.categories = list(flags.category);
  if (flags.estimate !== undefined) body.estimate = flags.estimate === 'none' ? null : flags.estimate;
  return body;
}

// ---------------------------------------------------------------- offline ----
// When the server can't be reached, changes to tasks and time tracking are saved on this computer and sent, oldest
// first, by the next pm command that reaches it (or pm queue send). One queue per .pm.json, in ~/.pm-offline. What's
// saved is the command itself, run again later with the token of that time: the queue never holds the token.

/** Commands that can be saved for later: each sends one request (all or nothing), so sending it later can't half-repeat it. */
const SAVABLE = {
  task: ['create', 'new', 'update', 'edit', 'advance', 'next', 'status', 'move', 'note', 'comment', 'check', 'link', 'unlink'],
  time: ['start', 'stop', 'log', 'add'],
};
const savable = (cmd, sub) => cmd === 'item' || Boolean(SAVABLE[cmd]?.includes(sub));

/** A task created offline goes by NEW_<n> until it's sent and gets its real key. */
const TEMP_KEY = /^NEW_\d+$/i;
/** NEW_<n> → { key, at }: the real keys of tasks created offline, kept a week (see writeOutbox). */
let KEYS = {};
/** The task the last pm task create made; a saved one, when sent, gives its NEW_<n> the real key. */
let CREATED;

function outboxFile() {
  const where = CFG.file ? path.resolve(CFG.file) : `env ${CFG.urls.join(' ')}`;
  const id = crypto.createHash('sha256').update(process.platform === 'win32' ? where.toLowerCase() : where).digest('hex').slice(0, 10);
  const name = CFG.file ? path.basename(path.dirname(where)).replace(/[^\w.-]/g, '_') : 'env';
  return path.join(os.homedir(), '.pm-offline', `${name}-${id}.json`);
}

const emptyBox = () => ({ version: 1, seq: 1, entries: [], failed: [], timer: null, keys: {} });

/** Waits without giving other work a turn: only for short waits on a file. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Errors from a file another program has open for a moment (on Windows: a virus scanner, the search indexer). */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

function readOutbox() {
  const file = outboxFile();
  let text;
  for (let tries = 1; text === undefined; tries++) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return emptyBox();
      // Never taken for an empty queue: whatever is saved next would replace what's in there.
      if (tries >= 20 || !BUSY.has(err.code)) fail(`Could not read the offline queue ${file} (${err.message})`);
      sleepSync(50);
    }
  }
  try {
    const box = { ...emptyBox(), ...JSON.parse(text) };
    if (!Array.isArray(box.entries) || !Array.isArray(box.failed) || typeof box.keys !== 'object' || !box.keys) {
      throw new Error('not a pm offline queue');
    }
    return box;
  } catch (err) {
    // Kept aside rather than lost, and out of the way of every other pm command.
    const aside = `${file}.unreadable-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      /* reported below either way */
    }
    console.error(`pm: the offline queue couldn't be read (${err.message}); it was moved to ${aside}`);
    return emptyBox();
  }
}

function writeOutbox(box) {
  const file = outboxFile();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [temp, k] of Object.entries(box.keys)) if (!(Date.parse(k.at) >= weekAgo)) delete box.keys[temp];
  if (!box.entries.length && !box.failed.length && !box.timer && !Object.keys(box.keys).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(box, null, 2)}\n`, { mode: 0o600 });
  // All at once, so another pm reading it never sees half a file. On Windows a virus scanner or the search indexer
  // can have the file open for a moment, so that's waited out.
  for (let tries = 1; ; tries++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (tries >= 20 || !BUSY.has(err.code)) throw err;
      sleepSync(50);
    }
  }
}

/** A pm holding the queue's lock touches it this often, so the others can tell it's still at work. */
const LOCK_BEAT_MS = 5_000;
/** A lock untouched for this long was left by a pm that's gone (killed, say), and is taken over. */
const LOCK_STALE_MS = 30_000;
const LOCK_ID = `${process.pid}@${os.hostname()}`;
let LOCK; // the queue's lock file, while this pm holds it

/** Who holds a lock and when they last touched it; undefined when nobody does, id null when it can't be read. */
function lockHolder(lock) {
  try {
    return { id: fs.readFileSync(lock, 'utf8'), touched: fs.statSync(lock).mtimeMs };
  } catch (err) {
    return err.code === 'ENOENT' ? undefined : { id: null, touched: Date.now() };
  }
}

/** Whether the pm holding a lock is gone: silent for too long, or no longer running on this computer. */
function lockGone({ id, touched }) {
  if (id === null) return false; // can't tell: waited out
  if (Date.now() - touched > LOCK_STALE_MS) return true;
  const [pid, host] = id.split('@');
  if (host !== os.hostname() || !/^\d+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0); // only asks whether it's running
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

function releaseLock() {
  try {
    if (LOCK && lockHolder(LOCK)?.id === LOCK_ID) fs.rmSync(LOCK, { force: true });
  } catch {
    /* the next pm finds this one gone and takes it over */
  }
  LOCK = undefined;
}
process.on('exit', releaseLock);

/**
 * Runs fn(box, save) with the queue locked, since pm commands can run side by side, and saves the box afterwards.
 * save() writes it straight away, for changes that must not be lost if pm is stopped halfway.
 */
async function withOutbox(fn) {
  const file = outboxFile();
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (const giveUp = Date.now() + 120_000; ; ) {
    let busy = false;
    try {
      fs.writeFileSync(lock, LOCK_ID, { flag: 'wx' });
      break;
    } catch (err) {
      if (BUSY.has(err.code)) busy = true; // Windows: the pm that had it is still letting go
      else if (err.code !== 'EEXIST') throw err;
    }
    const holder = busy ? { id: null, touched: Date.now() } : lockHolder(lock);
    if (!holder) continue; // just let go
    if (lockGone(holder)) {
      try {
        // Looked at once more right before it goes, so a lock another pm has only just taken over stays.
        const still = lockHolder(lock);
        if (still?.id === holder.id && still.touched === holder.touched) fs.rmSync(lock);
        continue;
      } catch {
        /* waited out below */
      }
    }
    if (Date.now() > giveUp) fail(`Another pm command has been busy with the offline queue for 2 minutes. Try again, or delete ${lock} if no pm is running.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  LOCK = lock;
  const beat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lock, now, now);
    } catch {
      /* checked when it's saved */
    }
  }, LOCK_BEAT_MS);
  beat.unref();
  const own = () => {
    const holder = lockHolder(lock);
    return holder !== undefined && (holder.id === LOCK_ID || holder.id === null); // null: can't be read just now
  };
  const box = readOutbox();
  const save = () => {
    // Only if this pm was so slow (its computer asleep, say) that another one took the queue over.
    if (!own()) fail('Another pm command took over the offline queue while this one was sending it. What is left is sent by the next pm command.');
    writeOutbox(box);
  };
  try {
    return await fn(box, save);
  } finally {
    clearInterval(beat);
    try {
      if (own()) writeOutbox(box);
    } finally {
      releaseLock();
    }
  }
}

/** NEW_3, a task created offline: its real key once it's been sent; still NEW_3 while changes are being saved offline. */
function tempKeyRef(temp) {
  if (KEYS[temp]) return KEYS[temp].key;
  const box = readOutbox();
  const refused = box.failed.find((e) => e.tempKey === temp);
  if (refused) fail(`${temp} was never created: the server refused it (${refused.error}). pm queue shows it.`);
  if (!box.entries.some((e) => e.tempKey === temp)) fail(`${temp} is not a task saved offline here (pm queue shows those).`);
  // Still waiting to be sent: a change saved offline can use it, since it's sent after the task is created.
  if (CFG.offline && !REPLAYING) return temp;
  fail(`${temp} hasn't been sent to the server yet (pm queue send sends it).`);
}

/** 14:05 today, or 2026-11-19 14:05 another day (this computer's clock). */
function when(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

const targetName = (t) => t.task ?? `epoch ${t.epoch}`;

/** A saved change in words, for pm queue and the report once it's sent. */
function describe(e) {
  if (e.kind === 'time-log') return `time log ${fmtMin(e.minutes)} on ${targetName(e.target)} from ${when(e.startedAt)}${e.note ? ` "${e.note}"` : ''}`;
  if (e.kind === 'timer-stop') return `time stop as of ${when(e.stopAt)} (the timer running on the server, if any)`;
  const shown = (a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a);
  return `pm ${e.argv.map((a) => (/^[\w@%+=:,./#-]+$/.test(a) ? a : JSON.stringify(shown(a)))).join(' ')}`;
}

/** What a command saved offline prints: what was saved, and that it's sent later (--json: as JSON). */
function sayOffline(flags, waiting, lines, extra = {}) {
  if (flags.json) return console.log(JSON.stringify({ savedOffline: true, ...extra, waiting }, null, 2));
  for (const line of lines) if (line) console.log(line);
  console.log(`(${CFG.offline}. ${plural(waiting, 'change is', 'changes are')} saved on this computer; the next pm command that reaches the server sends them, and pm queue lists them.)`);
}

/** The command with --desc-file swapped for the file's text now: the file may change before the command is sent. */
function withFileText(argv) {
  const text = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      return fail(`Could not read ${file} (${err.message})`);
    }
  };
  const saved = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--desc-file') saved.push('--desc', text(argv[++i]));
    else if (a.startsWith('--desc-file=')) saved.push('--desc', text(a.slice('--desc-file='.length)));
    else saved.push(a);
  }
  return saved;
}

/** Saves a command that couldn't reach the server, to be sent later, and says so. */
async function saveForLater(cmd, rest, flags, argv) {
  const sub = cmd === 'item' ? undefined : rest[0];
  const now = new Date();
  const base = { at: now.toISOString(), project: CFG.project ?? null };
  if (cmd === 'time' && (sub === 'start' || sub === 'stop')) return saveTimer(sub, flags, base, now);
  const saved = withFileText(argv);
  if (cmd === 'time' && flags.date === undefined) saved.push('--date', now.toISOString()); // logged when it was done
  const { entry, waiting } = await withOutbox((box) => {
    const e = { id: box.seq++, ...base, argv: saved };
    if (cmd === 'task' && (sub === 'create' || sub === 'new')) e.tempKey = `NEW_${e.id}`;
    box.entries.push(e);
    return { entry: e, waiting: box.entries.length };
  });
  sayOffline(
    flags,
    waiting,
    [
      `Saved offline${entry.tempKey ? ` as ${entry.tempKey}` : ''}: ${describe(entry)}`,
      entry.tempKey && `Use ${entry.tempKey} for this task in other pm commands until then; it gets its real key when it's sent.`,
    ],
    { id: entry.id, ...(entry.tempKey ? { key: entry.tempKey } : {}) },
  );
}

/** Ends the timer started offline: an entry with its real start and length, to be sent. */
function logTimer(box, now, note) {
  const t = box.timer;
  box.timer = null;
  const entry = {
    id: box.seq++,
    at: now.toISOString(),
    project: t.project,
    kind: 'time-log',
    target: t.target,
    startedAt: t.startedAt,
    minutes: Math.max(1, Math.round((now - Date.parse(t.startedAt)) / 60000)),
    note: [t.note, note].filter(Boolean).join('; '),
  };
  box.entries.push(entry);
  return entry;
}

/** pm time start / stop without the server: the timer runs on this computer and is logged with its real times later. */
async function saveTimer(sub, flags, base, now) {
  const target = flags.task !== undefined ? { task: String(flags.task) } : flags.epoch !== undefined ? { epoch: String(flags.epoch) } : null;
  if (sub === 'start' && !target) fail('Provide --task APP-12 or --epoch ID');
  const note = sub === 'stop' && flags.note ? String(flags.note) : undefined;
  const { logged, waiting } = await withOutbox((box) => {
    let ended;
    if (box.timer) ended = logTimer(box, now, note);
    // None started here, but one may be running on the server: it stops now, as it would have.
    else box.entries.push({ id: box.seq++, ...base, kind: 'timer-stop', stopAt: now.toISOString(), ...(note ? { note } : {}) });
    if (sub === 'start') box.timer = { ...base, target, startedAt: now.toISOString(), note: flags.note ? String(flags.note) : '' };
    return { logged: ended, waiting: box.entries.length };
  });
  const lines = [];
  if (logged) lines.push(`Timer stopped: ${fmtMin(logged.minutes)} on ${targetName(logged.target)} (saved offline)`);
  else if (sub === 'stop') lines.push(`Saved offline: the timer running on the server stops as of ${when(now)}`);
  if (sub === 'start') lines.push(`Timer started on ${targetName(target)} at ${when(now)}, on this computer: it's logged with its real start and length once it's stopped and the server can be reached`);
  sayOffline(flags, waiting, lines);
}

/** A timer started offline is still running: it's logged with its real times (sent now, or saved if still offline). */
async function settleOfflineTimer(note) {
  if (!readOutbox().timer) return undefined;
  const logged = await withOutbox((box) => (box.timer ? logTimer(box, new Date(), note) : undefined));
  if (logged) await flushOutbox();
  return logged;
}

async function timeTarget(t) {
  return t.task !== undefined ? { taskId: await taskRef(t.task) } : { epochId: await resolveEpoch(t.epoch) };
}

/** A timer that ran offline: a time entry with its real start and length (24 hours at most each, so maybe several). */
async function replayTimeLog(e) {
  const target = await timeTarget(e.target);
  const total = e.minutes;
  while (e.minutes > 0) {
    const minutes = Math.min(e.minutes, 24 * 60);
    await post('/api/v1/time', { ...target, minutes, date: e.startedAt, note: e.note || undefined });
    // What's left, should a later piece be refused: retrying it never logs a piece twice.
    e.startedAt = new Date(Date.parse(e.startedAt) + minutes * 60000).toISOString();
    e.minutes -= minutes;
  }
  return `logged ${fmtMin(total)}`;
}

/** A timer stopped offline that runs on the server: stopped, then set to the length it had when it was stopped. */
async function replayTimerStop(e) {
  if (e.entryId === undefined) {
    const { entry: running } = await get('/api/v1/time/running');
    if (!running) return 'no timer was running on the server';
    if (Date.parse(running.startedAt) > Date.parse(e.stopAt)) return `the server's timer started later (${when(running.startedAt)}), so it keeps running`;
    const stopped = await post('/api/v1/time/stop', e.note ? { note: e.note } : {});
    // Kept, should setting its length be refused: retrying it sets this entry's length rather than looking for a timer.
    Object.assign(e, { entryId: stopped.id, startedAt: stopped.startedAt, minutes: stopped.minutes, on: stopped.taskKey ?? stopped.epochName });
  }
  const ran = Math.max(1, Math.round((Date.parse(e.stopAt) - Date.parse(e.startedAt)) / 60000));
  const minutes = Math.min(ran, 24 * 60); // the longest one entry can be
  if (minutes !== e.minutes) await patch(`/api/v1/time/${e.entryId}`, { minutes });
  return `stopped the timer on ${e.on}: ${fmtMin(minutes)}${ran > minutes ? ` (it ran ${fmtMin(ran)}; one entry is 24 hours at most)` : ''}`;
}

/** Runs one saved change again, now that the server answers, in the project it was meant for. Returns what it said. */
async function replay(entry, box) {
  const keep = { project: CFG.project, current: CURRENT, log: console.log };
  const said = [];
  if ((entry.project ?? undefined) !== CFG.project) {
    CFG.project = entry.project ?? undefined;
    CURRENT = undefined;
  }
  REPLAYING = true;
  console.log = (...args) => said.push(args.join(' '));
  try {
    if (entry.kind === 'time-log') return await replayTimeLog(entry);
    if (entry.kind === 'timer-stop') return await replayTimerStop(entry);
    CREATED = undefined;
    const { pos, flags } = parseArgs(entry.argv);
    delete flags.json; // what it says goes into the report, in words
    const [cmd, ...rest] = pos;
    await commands[cmd](rest, flags);
    if (entry.tempKey && CREATED?.key) {
      box.keys[entry.tempKey] = { key: CREATED.key, at: new Date().toISOString() };
      return `${entry.tempKey} is ${CREATED.key}`;
    }
    return said.find(Boolean) ?? '';
  } finally {
    REPLAYING = false;
    console.log = keep.log;
    if (CFG.project !== keep.project) {
      CFG.project = keep.project;
      CURRENT = keep.current;
    }
  }
}

/**
 * Sends the saved changes, oldest first. One the server refuses is kept aside (pm queue) and the rest go on; if the
 * server stops answering, what's left waits for next time. Reports on stderr, so a command's own output stays clean.
 */
async function flushOutbox(say = (s) => console.error(s)) {
  const sent = [];
  const refused = [];
  if (CFG.offline) return { sent: 0, refused: 0 };
  await withOutbox(async (box, save) => {
    KEYS = box.keys;
    while (box.entries.length && !CFG.offline) {
      const entry = box.entries[0];
      try {
        const result = await replay(entry, box);
        box.entries.shift();
        sent.push(`  ${describe(entry)}${result ? `  ->  ${result}` : ''}`);
      } catch (err) {
        if (err instanceof Offline) break;
        box.entries.shift();
        const error = err instanceof Failed ? err.message : `pm error: ${err?.message ?? err}`;
        box.failed.push({ ...entry, error, failedAt: new Date().toISOString() });
        refused.push(`  ${describe(entry)}\n      ${error}`);
      }
      save();
    }
  });
  if (sent.length) say([`pm: sent ${plural(sent.length, 'change', 'changes')} saved while the server couldn't be reached:`, ...sent].join('\n'));
  if (refused.length) {
    say([`pm: ${plural(refused.length, 'saved change was', 'saved changes were')} refused, and kept aside (pm queue shows them; pm queue retry or drop):`, ...refused].join('\n'));
  }
  return { sent: sent.length, refused: refused.length };
}

/**
 * Runs a command. What was saved offline goes first, so changes reach the server in the order they were made; when the
 * server can't be reached, a change to a task or to the time tracking is saved for later instead of failing.
 */
async function run(cmd, rest, flags, argv) {
  CFG ??= loadConfig();
  const canSave = savable(cmd, rest[0]);
  if (cmd !== 'queue') {
    const box = readOutbox();
    KEYS = box.keys;
    CFG.offlineMemo = offlineLately();
    if (canSave && CFG.offlineMemo) CFG.offline = 'The server could not be reached a moment ago';
    else if (box.entries.length) await flushOutbox();
  }
  try {
    await commands[cmd](rest, flags);
  } catch (err) {
    if (!(err instanceof Offline)) throw err;
    if (!canSave) fail(`${err.message}. Is the server running, and can this computer reach it?`);
    if (WROTE) fail(`${err.message}, after part of this command had been sent, so it wasn't saved for later: check what was done once the server can be reached.`);
    await saveForLater(cmd, rest, flags, argv);
  }
}

// --------------------------------------------------------------- commands ----

const commands = {
  async meta(_, flags) {
    const m = await get('/api/v1/meta');
    out(flags, m, () => {
      console.log('Statuses:   ' + m.statuses.map((s) => `${s.label} (${s.id})`).join(' → '));
      console.log('Types:      ' + m.types.join(', '));
      console.log('Priorities: ' + m.priorities.join(', '));
      console.log('Categories: ' + m.categories.map((c) => c.name).join(', '));
    });
  },

  async task([sub, ...rest], flags) {
    switch (sub) {
      case 'list':
      case 'ls': {
        const epoch = await resolveEpoch(flags.epoch);
        const folder = flags.folder === 'inbox' ? 'inbox' : await resolveFolder(flags.folder);
        const parent = /^(none|any)$/i.test(String(flags.parent ?? '')) ? String(flags.parent).toLowerCase() : await parentRef(flags.parent);
        const r = await get('/api/v1/tasks' + qs({
          q: flags.q ?? rest.join(' '), status: flags.status, type: flags.type, category: flags.category,
          priority: flags.priority, epoch: epoch === null ? 'none' : epoch, folder, createdBy: flags['created-by'],
          parent: parent === null ? 'none' : parent,
        }));
        return out(flags, await boardOrder(r.tasks), (ts) => (ts.length ? ts.forEach((t) => printTask(t)) : console.log('No tasks found.')));
      }
      case 'get':
      case 'show':
        return out(flags, await get(`/api/v1/tasks/${await taskRef(rest[0])}`), (t) => printTask(t, true));
      case 'subtasks': {
        const t = await get(`/api/v1/tasks/${await taskRef(rest[0])}`);
        return out(flags, t.children, (cs) => {
          if (!cs.length) return console.log(`${t.key} has no sub-tasks.${t.parent ? ` It is a sub-task of ${t.parent.key}.` : ''}`);
          console.log(`${t.key} "${t.title}": ${t.subtasks.done}/${t.subtasks.total} sub-tasks done (Alpha Complete or later)`);
          cs.forEach(printSubtask);
        });
      }
      case 'create':
      case 'new': {
        const body = taskBody(flags);
        if (!body.title && rest.length) body.title = rest.join(' ');
        // With a template the server decides whether a title is needed (only when the template's has {title}).
        if (flags.template !== undefined) body.template = String(flags.template);
        else if (!body.title) fail('Provide --title "..."');
        const epochId = await resolveEpoch(flags.epoch);
        if (epochId !== undefined) body.epochId = epochId;
        const folderId = await resolveFolder(flags.folder);
        if (folderId !== undefined) body.folderId = folderId;
        if (flags.check) body.checklist = flags.check;
        const parent = await parentRef(flags.parent);
        if (parent !== undefined) body.parent = parent;
        const t = await post('/api/v1/tasks', body);
        CREATED = t;
        return out(flags, t, () => {
          console.log(`Created ${t.key}${t.children?.length ? ` with ${plural(t.children.length, 'sub-task', 'sub-tasks')}` : ''}`);
          printTask(t);
          for (const c of t.children ?? []) printSubtask(c);
          for (const w of t.warnings ?? []) console.log(`Note: ${w}`);
        });
      }
      case 'update':
      case 'edit': {
        // Several keys: one request that changes them all, or none of them if one change is refused.
        const { keys, rest: extra } = await leadingKeys(rest);
        if (extra.length) fail(`"${extra[0]}" is not a task key. Give the changes as flags: pm task update APP-12 [APP-13 ...] --priority high`);
        const body = taskBody(flags);
        const epochId = await resolveEpoch(flags.epoch);
        if (epochId !== undefined) body.epochId = epochId;
        const folderId = await resolveFolder(flags.folder);
        if (folderId !== undefined) body.folderId = folderId;
        const parent = await parentRef(flags.parent);
        if (parent !== undefined) body.parent = parent;
        if (!Object.keys(body).length) fail('Nothing to update. Use --title, --desc, --type, --priority, --category, --epoch, --folder, --estimate, --status, --parent');
        if (keys.length === 1) return out(flags, await patch(`/api/v1/tasks/${keys[0]}`, body), (t) => { console.log(`Updated ${t.key}`); printTask(t); });
        if (body.title !== undefined || body.description !== undefined) fail('--title and --desc change one task at a time; the other flags work on several.');
        const r = await post('/api/v1/tasks/bulk', { action: 'update', ids: keys, set: body });
        return out(flags, r.tasks, (ts) => {
          console.log(`Updated ${plural(ts.length, 'task', 'tasks')}`);
          ts.forEach((t) => printTask(t));
        });
      }
      case 'advance':
      case 'next': {
        const t = await post(`/api/v1/tasks/${await taskRef(rest[0])}/advance`, { note: flags.note });
        return out(flags, t, () => console.log(`${t.key} → ${t.statusLabel}`));
      }
      case 'status':
      case 'move': {
        if (PLACES.some((p) => flags[p] !== undefined)) fail(`pm task ${sub} changes a task's column. To change its place in its column: ${REORDER_USAGE}`);
        const { keys, rest: words } = await leadingKeys(rest);
        const status = need(flags.status ?? words.join(' '), 'status');
        if (keys.length === 1) {
          const t = await post(`/api/v1/tasks/${keys[0]}/status`, { status, note: flags.note });
          return out(flags, t, () => console.log(`${t.key} → ${t.statusLabel}`));
        }
        const r = await post('/api/v1/tasks/bulk', { action: 'update', ids: keys, set: { status, note: flags.note } });
        return out(flags, r.tasks, (ts) => ts.forEach((t) => console.log(`${t.key} → ${t.statusLabel}`)));
      }
      case 'reorder':
      case 'order': {
        // A task's place in its column. Never its column: that is pm task status, which the QA rules are about.
        const { keys, rest: extra } = await leadingKeys(rest);
        if (extra.length) fail(`"${extra[0]}" is not a task key. Usage: ${REORDER_USAGE}`);
        const places = PLACES.filter((p) => flags[p] !== undefined);
        if (places.length !== 1) fail(`Say where with one of --top, --bottom, --before or --after. Usage: ${REORDER_USAGE}`);
        const place = places[0];
        const { status, statusLabel } = await get(`/api/v1/tasks/${keys[0]}`);
        const column = async () => (await get('/api/v1/tasks' + qs({ status, limit: 5000, summary: 1 }))).tasks;
        const col = await column();
        const inColumn = new Map(col.map((t) => [t.key, t]));
        const notHere = async (key) => {
          const t = await get(`/api/v1/tasks/${key}`);
          fail(`${t.key} is in ${t.statusLabel}, not ${statusLabel}. pm task reorder only changes the order inside one column (pm task status moves a task to another column).`);
        };
        for (const k of keys) if (!inColumn.has(k)) await notHere(k);
        const others = col.filter((t) => !keys.includes(t.key));
        // They go right above others[at]; others.length means at the bottom.
        let at = place === 'top' ? 0 : others.length;
        if (place === 'before' || place === 'after') {
          const anchor = await taskRef(flags[place], `task key after --${place}`);
          if (keys.includes(anchor)) fail(`${anchor} is one of the tasks being moved. Name another task after --${place}.`);
          const i = others.findIndex((t) => t.key === anchor);
          if (i === -1) await notHere(anchor);
          at = place === 'before' ? i : i + 1;
        }
        const target = [...others.slice(0, at), ...keys.map((k) => inColumn.get(k)), ...others.slice(at)];
        const already = target.every((t, i) => t.id === col[i].id);
        if (!already) {
          const beforeId = others[at]?.id ?? null;
          if (keys.length === 1) await post(`/api/v1/tasks/${keys[0]}/move`, { status, beforeId });
          else await post('/api/v1/tasks/bulk', { action: 'move', ids: keys, status, beforeId });
        }
        const now = already ? col : await column();
        return out(flags, { status, order: now.map((t) => t.key) }, () => {
          const spots = keys.map((k) => now.findIndex((t) => t.key === k)).filter((i) => i >= 0).sort((a, b) => a - b);
          if (!spots.length) return console.log(`Moved ${keys.join(', ')}`);
          const first = spots[0];
          const last = spots.at(-1);
          const where = first === 0 ? `at the top of ${statusLabel}` : last === now.length - 1 ? `at the bottom of ${statusLabel}` : `in ${statusLabel}`;
          const range = first === last ? `${first + 1}` : `${first + 1}-${last + 1}`;
          const near = [first > 0 && `below ${now[first - 1].key}`, last < now.length - 1 && `above ${now[last + 1].key}`].filter(Boolean).join(', ');
          const verb = `${keys.length === 1 ? 'is' : 'are'}${already ? '' : ' now'}`;
          console.log(`${already ? 'Already there: ' : ''}${keys.join(', ')} ${verb} ${where} (${range} of ${now.length})${near ? `, ${near}` : ''}`);
        });
      }
      case 'note':
      case 'comment': {
        const key = await taskRef(rest[0]);
        const message = flags.message ?? rest.slice(1).join(' ');
        await post(`/api/v1/tasks/${key}/comments`, { message: need(message, 'message') });
        return console.log(`Note added to ${key}`);
      }
      case 'check': {
        // pm task check APP-3 "item text"   → add item
        const key = await taskRef(rest[0]);
        const item = await post(`/api/v1/tasks/${key}/checklist`, { text: need(rest.slice(1).join(' '), 'item text') });
        return console.log(`Added checklist item #${item.id}`);
      }
      case 'link': {
        // pm task link APP-12 APP-9                 (relates to)
        // pm task link APP-12 blocks APP-9 | blocked by APP-9 | duplicates APP-9 | duplicated by APP-9 | relates to APP-9
        if (rest.length < 2) fail('Usage: pm task link APP-12 [blocks|blocked by|duplicates|duplicated by|relates to] APP-9');
        const key = await taskRef(rest[0]);
        const other = await taskRef(rest.at(-1), 'other task key');
        const kind = flags.kind ?? (rest.slice(1, -1).join(' ') || 'relates');
        const t = await post(`/api/v1/tasks/${key}/links`, { task: other, kind });
        return out(flags, t, () => {
          const l = t.links.find((x) => x.task.key === other);
          console.log(l ? `${t.key} ${l.label} ${l.task.key} (${l.task.title})` : `Linked ${t.key} and ${other}`);
        });
      }
      case 'unlink': {
        const key = await taskRef(rest[0]);
        const other = await taskRef(rest[1], 'other task key');
        const t = await del(`/api/v1/tasks/${key}/links/${other}`);
        return out(flags, t, () => console.log(`Removed the link between ${t.key} and ${other}`));
      }
      case 'delete':
      case 'rm': {
        const key = await taskRef(rest[0]);
        const { subtasks, parent } = await get(`/api/v1/tasks/${key}`);
        const withSubtasks = !!flags['with-subtasks'];
        const r = await del(`/api/v1/tasks/${key}${withSubtasks ? '?withSubtasks=true' : ''}`);
        if (withSubtasks && r.deleted > 1) return console.log(`Deleted ${key} and its ${plural(r.deleted - 1, 'sub-task', 'sub-tasks')}`);
        if (subtasks.total && !withSubtasks) {
          // They move up a level: under the deleted task's parent, or to the top level.
          const where = parent ? `now sub-tasks of ${parent.key}` : 'now top-level';
          return console.log(`Deleted ${key}. Its ${plural(subtasks.total, 'sub-task is', 'sub-tasks are')} ${where} (--with-subtasks deletes them too).`);
        }
        return console.log(`Deleted ${key}`);
      }
      default:
        fail(`Unknown task command "${sub ?? ''}". Try: list, get, subtasks, create, update, advance, status, reorder, note, check, link, unlink, delete`);
    }
  },

  /** Task templates: a task's fields and its sub-tasks, saved under a name; pm task create --template uses one. */
  async template([sub, ...rest], flags) {
    const ref = (raw) => encodeURIComponent(String(need(raw, 'template (name or id)')).trim());
    const none = (v) => (/^(none|null)$/i.test(String(v)) ? null : v);
    const body = () => {
      let b = {};
      if (flags.file !== undefined) {
        try {
          b = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
        } catch (err) {
          fail(`Could not read ${flags.file} as JSON (${err.message})`);
        }
      }
      if (flags.name !== undefined) b.name = flags.name;
      if (flags.title !== undefined) b.title = flags.title;
      const desc = readDesc(flags);
      if (desc !== undefined) b.description = desc;
      for (const k of ['type', 'priority', 'epoch', 'estimate']) if (flags[k] !== undefined) b[k] = none(flags[k]);
      if (flags.category !== undefined) b.categories = none(flags.category) === null ? [] : list(flags.category);
      if (flags.check !== undefined) b.checklist = flags.check;
      return b;
    };
    const line = (t) =>
      console.log(`${t.id}  ${t.name}  ->  "${t.title}"${t.subtasks.length ? `  + ${plural(t.subtasks.length, 'sub-task', 'sub-tasks')}` : ''}`);
    const facts = (t) =>
      [t.type && `type=${t.type}`, t.priority && `priority=${t.priority}`, t.epoch && `epoch="${t.epoch}"`,
        t.categories.length && `categories=${t.categories.join(',')}`, t.estimateMinutes != null && `estimate=${fmtMin(t.estimateMinutes)}`,
        t.checklist.length && `checklist=${t.checklist.length}`].filter(Boolean).join(' ');
    const detail = (t) => {
      line(t);
      if (facts(t)) console.log(`  ${facts(t)}`);
      if (t.description) console.log(`\n${t.description}\n`);
      if (t.checklist.length) {
        console.log('Checklist:');
        for (const c of t.checklist) console.log(`  [ ] ${c}`);
      }
      if (t.subtasks.length) {
        console.log('Sub-tasks (an epoch of their own, or where the new task goes):');
        for (const st of t.subtasks) console.log(`  ${st.title}${facts(st) ? `  ${facts(st)}` : ''}`);
      }
    };
    switch (sub) {
      case undefined:
      case 'list':
      case 'ls': {
        const { templates } = await get('/api/v1/templates');
        return out(flags, templates, () =>
          templates.length ? templates.forEach(line) : console.log('No templates yet. Create one: pm template create --name Card --title "Card: {title}"'));
      }
      case 'get':
      case 'show':
        return out(flags, await get(`/api/v1/templates/${ref(rest.join(' '))}`), detail);
      case 'create':
      case 'new': {
        const b = body();
        b.name ??= rest.join(' ');
        if (!b.name) fail('Provide --name "..."');
        if (flags['from-task'] !== undefined) {
          b.fromTask = await taskRef(flags['from-task']);
          b.includeSubtasks = !!flags['with-subtasks'];
        }
        const t = await post('/api/v1/templates', b);
        return out(flags, t, () => {
          console.log(`Created template ${t.id}: ${t.name}`);
          detail(t);
        });
      }
      case 'update':
      case 'edit': {
        const b = body();
        if (!Object.keys(b).length) fail('Nothing to change. Use --name, --title, --desc, --type, --priority, --category, --epoch, --estimate, --check or --file');
        const t = await patch(`/api/v1/templates/${ref(rest[0])}`, b);
        return out(flags, t, () => {
          console.log(`Updated template ${t.id}: ${t.name}`);
          detail(t);
        });
      }
      case 'delete':
      case 'rm': {
        const t = await get(`/api/v1/templates/${ref(rest.join(' '))}`);
        await del(`/api/v1/templates/${t.id}`);
        return console.log(`Deleted the template ${t.name} (tasks made from it stay as they are)`);
      }
      default:
        fail('Try: template list | show <name|id> | create --name X [--title ..] [--from-task APP-12 [--with-subtasks]] [--file t.json] | update <name|id> [..] | delete <name|id>');
    }
  },

  /** pm item <id> [--undo] [--text ".."] [--remove] — tick, untick, rename or remove a checklist item */
  async item([id], flags) {
    const itemId = need(id, 'checklist item id');
    if (flags.remove) {
      await del(`/api/v1/checklist/${itemId}`);
      return console.log(`Removed checklist item #${itemId}`);
    }
    const body = {};
    if (flags.text !== undefined) body.text = String(flags.text);
    if (flags.undo) body.done = false;
    else if (flags.text === undefined) body.done = true;
    const r = await patch(`/api/v1/checklist/${itemId}`, body);
    return out(flags, r, () => console.log(`#${r.id} ${r.done ? 'done' : 'not done'}: ${r.text}`));
  },

  async epoch([sub, ...rest], flags) {
    const body = () => {
      const b = {};
      if (flags.name !== undefined) b.name = flags.name;
      const desc = readDesc(flags);
      if (desc !== undefined) b.description = desc;
      if (flags.color !== undefined) b.color = flags.color;
      if (flags.target !== undefined) b.targetDate = flags.target === 'none' ? null : flags.target;
      if (flags.estimate !== undefined) b.estimate = flags.estimate === 'none' ? null : flags.estimate;
      return b;
    };
    const show = (e) =>
      console.log(`${e.id}  ${e.name}  ${e.shipped}/${e.total} shipped  time=${fmtMin(e.loggedMinutes)}${e.estimateMinutes ? `/${fmtMin(e.estimateMinutes)}` : ''}`);
    switch (sub) {
      case 'list':
      case 'ls':
        return out(flags, (await get('/api/v1/epochs')).epochs, (es) => (es.length ? es.forEach(show) : console.log('No epochs.')));
      case 'get':
      case 'show': {
        const e = await get(`/api/v1/epochs/${await resolveEpoch(need(rest.join(' '), 'epoch'))}`);
        return out(flags, e, () => {
          show(e);
          if (e.description) console.log(`\n${e.description}`);
          console.log('Counts: ' + Object.entries(e.counts).filter(([, n]) => n).map(([s, n]) => `${s}=${n}`).join(' '));
        });
      }
      case 'create':
      case 'new': {
        const b = body();
        b.name ??= rest.join(' ');
        if (!b.name) fail('Provide --name "..."');
        const folderId = await resolveFolder(flags.folder);
        if (folderId !== undefined) b.folderId = folderId;
        const e = await post('/api/v1/epochs', b);
        return out(flags, e, () => console.log(`Created epoch ${e.id}: ${e.name}`));
      }
      case 'update':
      case 'edit': {
        const id = await resolveEpoch(need(rest[0], 'epoch id'));
        const b = body();
        const folderId = await resolveFolder(flags.folder);
        if (folderId !== undefined) b.folderId = folderId;
        const e = await patch(`/api/v1/epochs/${id}`, b);
        return out(flags, e, () => console.log(`Updated epoch ${e.id}: ${e.name}`));
      }
      case 'delete':
      case 'rm':
        // Time logged directly on the epoch is deleted with it; the server refuses unless asked.
        await del(`/api/v1/epochs/${await resolveEpoch(need(rest[0], 'epoch id'))}${flags['delete-time'] ? '?deleteTime=true' : ''}`);
        return console.log('Deleted epoch (its tasks were kept)');
      default:
        fail(`Unknown epoch command "${sub ?? ''}". Try: list, get, create, update, delete`);
    }
  },

  async folder([sub, ...rest], flags) {
    const existingFolder = async (ref) => {
      const id = await resolveFolder(need(ref, 'folder (name or id)'));
      if (id === null) fail('Give a real folder name or id');
      return id;
    };
    switch (sub) {
      case 'list':
      case 'ls':
        return out(flags, (await get('/api/v1/folders')).folders, (fs_) =>
          fs_.forEach((f) => console.log(`${f.id}  ${f.name}${f.parentId ? `  (in ${f.parentId})` : ''}`)));
      case 'create':
      case 'new': {
        const parentId = await resolveFolder(flags.parent);
        const f = await post('/api/v1/folders', { name: need(flags.name ?? rest.join(' '), 'name'), parentId: parentId ?? null });
        return out(flags, f, () => console.log(`Created folder ${f.id}: ${f.name}`));
      }
      case 'rename': {
        const id = await existingFolder(rest[0]);
        const f = await patch(`/api/v1/folders/${id}`, { name: need(flags.name ?? rest.slice(1).join(' '), 'new name (--name)') });
        return out(flags, f, () => console.log(`Renamed folder ${f.id} to "${f.name}"`));
      }
      case 'move': {
        const id = await existingFolder(rest[0]);
        const parentId = await resolveFolder(need(flags.parent ?? rest[1], 'destination (--parent <folder> or root)'));
        const f = await patch(`/api/v1/folders/${id}`, { parentId });
        return out(flags, f, () => console.log(`Moved folder "${f.name}" ${parentId ? `into folder ${parentId}` : 'to the top level'}`));
      }
      case 'delete':
      case 'rm':
        await del(`/api/v1/folders/${await existingFolder(rest[0])}`);
        return console.log('Deleted folder (its contents moved to the parent folder)');
      default:
        fail('Try: folder list | create --name X [--parent F] | rename F --name X | move F --parent P|root | delete F');
    }
  },

  async time([sub, ...rest], flags) {
    const target = async () => {
      if (flags.task) return { taskId: await taskRef(flags.task) };
      if (flags.epoch) return { epochId: await resolveEpoch(flags.epoch) };
      fail('Provide --task APP-12 or --epoch ID');
    };
    const showEntry = (e) =>
      console.log(`#${e.id} ${fmtMin(e.minutes)}${e.running ? ' (running)' : ''}  ${e.taskKey ?? `epoch ${e.epochName}`}  ${e.actor}  ${e.note}`);
    switch (sub) {
      case 'start': {
        const body = { ...(await target()), note: flags.note };
        await settleOfflineTimer(); // like the server: starting a timer stops the one running
        const e = await post('/api/v1/time/start', body);
        return out(flags, e, () => console.log(`Timer started on ${e.taskKey ?? e.epochName}`));
      }
      case 'stop': {
        // A timer started while offline runs on this computer: it becomes an entry with its real start and length.
        const logged = await settleOfflineTimer(flags.note);
        if (logged) {
          const waiting = readOutbox().entries.some((x) => x.id === logged.id);
          return out(flags, logged, () =>
            console.log(`Timer stopped: ${fmtMin(logged.minutes)} on ${targetName(logged.target)} (started while offline${waiting ? '; saved until the server can be reached' : ''})`),
          );
        }
        const e = await post('/api/v1/time/stop', { note: flags.note });
        return out(flags, e, () => console.log(`Timer stopped: ${fmtMin(e.minutes)} on ${e.taskKey ?? e.epochName}`));
      }
      case 'status': {
        const local = readOutbox().timer;
        if (local) {
          const minutes = Math.max(0, Math.round((Date.now() - Date.parse(local.startedAt)) / 60000));
          return out(flags, { ...local, minutes, running: true, offline: true }, () =>
            console.log(`${fmtMin(minutes)} (running on this computer since ${when(local.startedAt)}; started while offline)  ${targetName(local.target)}  ${local.note}`),
          );
        }
        const { entry } = await get('/api/v1/time/running');
        return out(flags, entry, () => (entry ? showEntry(entry) : console.log('No timer running.')));
      }
      case 'log':
      case 'add': {
        const duration = need(flags.duration ?? rest[0], 'duration (e.g. 1h30m)');
        const e = await post('/api/v1/time', { ...(await target()), duration, note: flags.note, date: flags.date });
        return out(flags, e, () => console.log(`Logged ${fmtMin(e.minutes)} on ${e.taskKey ?? e.epochName}`));
      }
      case 'list':
      case 'ls': {
        const r = await get('/api/v1/time' + qs({
          taskId: flags.task ? await taskRef(flags.task) : undefined,
          epochId: flags.epoch ? await resolveEpoch(flags.epoch) : undefined, from: flags.from, to: flags.to,
        }));
        return out(flags, r, () => { r.entries.forEach(showEntry); console.log(`Total: ${fmtMin(r.totalMinutes)}`); });
      }
      case 'edit':
      case 'update': {
        const id = need(rest[0], 'entry id');
        const body = {};
        if (flags.duration !== undefined) body.duration = flags.duration;
        if (flags.note !== undefined) body.note = flags.note;
        if (flags.date !== undefined) body.date = flags.date;
        if (!Object.keys(body).length) fail('Nothing to change. Use --duration, --note or --date');
        const e = await patch(`/api/v1/time/${id}`, body);
        return out(flags, e, () => showEntry(e));
      }
      case 'delete':
      case 'rm':
        await del(`/api/v1/time/${need(rest[0], 'entry id')}`);
        return console.log('Deleted');
      default:
        fail('Try: time start|stop|status|log|list|edit|delete');
    }
  },

  async diagram([sub, ...rest], flags) {
    /** A diagram by id or (case-insensitive) name; with none given, the first one. */
    const resolveDiagram = async (ref) => {
      if (ref !== undefined && /^\d+$/.test(String(ref))) return Number(ref);
      const { diagrams } = await get('/api/v1/diagrams');
      if (ref !== undefined && ref !== '') return pickByName(diagrams, ref, 'diagram', (d) => d.name);
      if (!diagrams.length) fail('No diagrams exist. Create one: pm diagram create --name "..."');
      return diagrams[0].id;
    };
    let chosen;
    const base = async () => `/api/v1/diagrams/${(chosen ??= await resolveDiagram(flags.diagram))}`;
    const boxRef = () => encodeURIComponent(need(rest.join(' '), 'box label or id'));
    const num = (v, what) => {
      const n = Number(v);
      if (v === true || v === '' || !Number.isFinite(n)) fail(`${what} must be a number`);
      return n;
    };
    const link = async () => {
      // Diagram links store the task's id; look it up from the key.
      if (flags['link-task']) return { kind: 'task', id: (await get(`/api/v1/tasks/${await taskRef(flags['link-task'])}`)).id };
      if (flags['link-epoch']) return { kind: 'epoch', id: await resolveEpoch(flags['link-epoch']) };
      if (flags['link'] === 'none') return null;
      return undefined;
    };
    /** Box fields from the flags. "none" clears one (--parent none puts the box at the top level). */
    const boxBody = async () => {
      const body = {};
      const clear = (v) => (v === 'none' || v === '' ? null : v);
      if (flags.label !== undefined) body.label = flags.label;
      if (flags.layer !== undefined) body.layer = flags.layer;
      const desc = readDesc(flags);
      if (desc !== undefined) body.description = desc;
      for (const k of ['parent', 'path', 'role']) if (flags[k] !== undefined) body[k] = clear(flags[k]);
      for (const k of ['weight', 'width', 'height']) if (flags[k] !== undefined) body[k] = clear(flags[k]) === null ? null : num(flags[k], `--${k}`);
      const l = await link();
      if (l !== undefined) body.link = l;
      return body;
    };
    /** An arrow by its id, or by the two boxes it joins: "From box" "To box" (ids or labels). */
    const arrowId = async () => {
      if (rest.length <= 1) return need(rest[0], 'arrow id (or the two boxes it joins, in quotes)');
      if (rest.length > 2) fail('Give the arrow id, or the two boxes it joins, each in quotes: "From box" "To box"');
      const d = await get(await base());
      const box = (ref) => {
        const byId = d.nodes.find((n) => n.id === ref);
        if (byId) return byId;
        const named = d.nodes.filter((n) => n.label.toLowerCase() === ref.toLowerCase());
        if (named.length === 1) return named[0];
        fail(named.length ? `Several boxes are labelled "${ref}" (ids ${named.map((n) => n.id).join(', ')}). Use an id.` : `No box "${ref}" in ${d.name}.`);
      };
      const [s, t] = [box(rest[0]), box(rest[1])];
      const e = d.edges.find((x) => x.source === s.id && x.target === t.id);
      if (!e) fail(`No arrow from "${s.label}" to "${t.label}" (arrows have a direction).`);
      return e.id;
    };
    const arrowText = (e) => `${e.label ? ` "${e.label}"` : ''}${e.count > 1 ? ` ×${e.count}` : ''}`;

    switch (sub) {
      case 'list':
      case 'ls': {
        const r = await get('/api/v1/diagrams');
        return out(flags, r, () => {
          r.diagrams.forEach((d) => console.log(`${d.id}  ${d.name}  (${plural(d.nodeCount, 'box', 'boxes')}, ${plural(d.edgeCount, 'arrow', 'arrows')})`));
          console.log(`Layers: ${r.layers.join(', ')}`);
        });
      }
      case 'show': {
        const d = await get(`/api/v1/diagrams/${await resolveDiagram(rest.length ? rest.join(' ') : flags.diagram)}`);
        return out(flags, d, () => {
          const s = d.settings ?? {};
          console.log(`${d.name} (id ${d.id}, v${d.version}): ${s.layout ?? 'auto'} layout, arrows point ${s.direction === 'RIGHT' ? 'right' : 'down'}; ${plural(d.nodes.length, 'box', 'boxes')}, ${plural(d.edges.length, 'arrow', 'arrows')}`);
          const inside = new Map();
          for (const n of d.nodes) {
            const p = n.parent ?? '';
            if (!inside.has(p)) inside.set(p, []);
            inside.get(p).push(n);
          }
          const tree = (parent, depth) => {
            for (const n of inside.get(parent) ?? []) {
              const kids = inside.get(n.id)?.length;
              const role = n.role ?? n.description?.split('\n')[0];
              const size = n.width || n.height ? `${n.width ?? 'auto'}×${n.height ?? 'auto'}` : '';
              const extra = [n.path, role, n.weight !== undefined ? `weight ${n.weight}` : '', size].filter(Boolean).join(' · ');
              console.log(`${'  '.repeat(depth + 1)}[${n.layer}] ${n.label} (${n.id})${kids ? ` ▸ ${kids} inside` : ''}${extra ? ` — ${extra}` : ''}`);
              tree(n.id, depth + 1);
            }
          };
          tree('', 0);
          if (d.edges.length) console.log('Arrows:');
          const byId = new Map(d.nodes.map((n) => [n.id, n]));
          for (const e of d.edges) console.log(`  ${byId.get(e.source)?.label} → ${byId.get(e.target)?.label}${arrowText(e)}  [${e.id}]`);
        });
      }
      case 'create': {
        const d = await post('/api/v1/diagrams', { name: need(flags.name ?? rest.join(' '), 'name') });
        return console.log(`Created diagram ${d.id}: ${d.name}`);
      }
      case 'rename': {
        const d = await patch(await base(), { name: need(flags.name ?? rest.join(' '), 'new name (--name)') });
        return console.log(`Renamed diagram ${d.id} to ${d.name}`);
      }
      case 'settings': {
        const settings = {};
        if (flags.layout !== undefined) {
          settings.layout = String(flags.layout).toLowerCase();
          if (!['auto', 'manual'].includes(settings.layout)) fail('--layout is auto or manual');
        }
        if (flags.direction !== undefined) {
          settings.direction = String(flags.direction).toUpperCase();
          if (!['DOWN', 'RIGHT'].includes(settings.direction)) fail('--direction is down or right');
        }
        const d = Object.keys(settings).length ? await patch(await base(), { settings }) : await get(await base());
        return out(flags, d.settings, (s) => console.log(`${d.name}: ${s.layout} layout, arrows point ${s.direction === 'RIGHT' ? 'right' : 'down'}`));
      }
      case 'add-node': {
        const body = await boxBody();
        body.label = need(flags.label ?? rest.join(' '), 'label');
        const n = await post(`${await base()}/nodes`, body);
        return console.log(`Added box "${n.label}" (${n.id})`);
      }
      case 'update-node': {
        const body = await boxBody();
        if (!Object.keys(body).length) {
          fail('Nothing to change. Flags: --label --layer --parent --path --role --weight --width --height --desc --link-task --link-epoch --link none');
        }
        const n = await patch(`${await base()}/nodes/${boxRef()}`, body);
        return console.log(`Updated box "${n.label}"`);
      }
      case 'rm-node': {
        const r = await del(`${await base()}/nodes/${boxRef()}${flags['with-children'] ? '?withChildren=true' : ''}`);
        return console.log(r.removed > 1 ? `Removed ${r.removed} boxes` : 'Box removed');
      }
      case 'connect': {
        const [source, target] = rest;
        const body = { source: need(source, 'box the arrow starts at'), target: need(target, 'box the arrow points to') };
        if (flags.label !== undefined) body.label = flags.label;
        if (flags.count !== undefined) body.count = num(flags.count, '--count');
        const e = await post(`${await base()}/edges`, body);
        // Two boxes have one arrow each way; asking again returns the one there is, unchanged.
        const same = (flags.label === undefined || e.label === flags.label) && (body.count === undefined || (e.count ?? 1) === Math.round(body.count));
        if (!same) return console.log(`Those boxes were already joined (${e.id}${arrowText(e)}). Change it with: pm diagram update-edge ${e.id} [--label ..] [--count N]`);
        return console.log(`Connected (${e.id})${arrowText(e)}`);
      }
      case 'update-edge': {
        const id = await arrowId();
        const body = {};
        if (flags.label !== undefined) body.label = flags.label;
        if (flags.count !== undefined) body.count = flags.count === 'none' ? null : num(flags.count, '--count');
        if (!Object.keys(body).length) fail('Nothing to change. Flags: --label ".." --count N|none');
        const e = await patch(`${await base()}/edges/${encodeURIComponent(id)}`, body);
        return console.log(`Updated arrow ${e.id}${arrowText(e)}`);
      }
      case 'rm-edge': {
        const id = await arrowId();
        await del(`${await base()}/edges/${encodeURIComponent(id)}`);
        return console.log('Arrow removed');
      }
      case 'import': {
        const file = need(rest[0], 'JSON file to import (as written by pm diagram export)');
        let data;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
          fail(`Can't read ${file}: ${err.message}`);
        }
        if (!data || !Array.isArray(data.nodes)) fail(`${file} needs a "nodes" list (and usually "edges"), like the JSON pm diagram export writes.`);
        const body = { mode: flags.replace ? 'replace' : 'merge', nodes: data.nodes, edges: Array.isArray(data.edges) ? data.edges : [] };
        if (data.settings && typeof data.settings === 'object') body.settings = data.settings;
        const url = `${await base()}/import`;
        if (!flags.yes) {
          const r = await post(url, { ...body, dryRun: true });
          return out(flags, r, () => {
            console.log(`Dry run (${body.mode}): this would ${importSummary(r, false)}.`);
            if (r.nodes.removed || r.edges.removed) console.log("Removed boxes and arrows can't be brought back.");
            if (importSummary(r, false) !== 'change nothing') console.log('Nothing has changed yet. Run the same command with --yes to apply it.');
          });
        }
        const r = await post(url, body);
        return out(flags, r, () => console.log(`Imported (${body.mode}): ${importSummary(r, true)}. The diagram is now version ${r.version}.`));
      }
      case 'export': {
        const d = await get(`/api/v1/diagrams/${await resolveDiagram(rest.length ? rest.join(' ') : flags.diagram)}`);
        // The same JSON as the web app's "Export as JSON"; pm diagram import and the web app read it back.
        const text = `${JSON.stringify({ name: d.name, settings: d.settings, nodes: d.nodes, edges: d.edges }, null, 2)}\n`;
        if (!flags.out) return process.stdout.write(text);
        fs.writeFileSync(flags.out, text);
        return console.log(`Wrote ${plural(d.nodes.length, 'box', 'boxes')} and ${plural(d.edges.length, 'arrow', 'arrows')} to ${flags.out}`);
      }
      default:
        fail('Try: diagram list|show|create|rename|settings|add-node|update-node|rm-node|connect|update-edge|rm-edge|import|export (pm help shows the flags)');
    }
  },

  async file([sub, ...rest], flags) {
    switch (sub) {
      case 'upload': {
        const p = need(rest[0], 'file path');
        const fd = new FormData();
        const folderId = await resolveFolder(flags.folder);
        if (folderId) fd.append('folderId', String(folderId));
        fd.append('file', new Blob([fs.readFileSync(p)]), path.basename(p));
        const r = await post('/api/v1/files', fd);
        return out(flags, r, () =>
          r.files.forEach((f) => {
            // SVGs are only shown as images from the sandboxed render URL; /content serves them as text.
            const isSvg = /\.svg$/i.test(f.name);
            const url = `/api/v1/files/${f.id}/${isSvg ? 'render' : 'content'}`;
            const alt = f.name.replace(/[[\]]/g, '');
            const md = isSvg || f.mime.startsWith('image/') ? `![${alt}](${url})` : `[${alt}](${url})`;
            console.log(`Uploaded ${f.name} (#${f.id})  embed: ${md}`);
          }),
        );
      }
      case 'list':
      case 'ls': {
        const folder = flags.folder === undefined ? undefined : (await resolveFolder(flags.folder)) ?? 'root';
        const r = await get('/api/v1/files' + qs({ folder }));
        return out(flags, r.files, (files) =>
          files.length
            ? files.forEach((f) => console.log(`#${f.id}  ${f.name}  ${f.size} bytes${f.folderId ? `  folder ${f.folderId}` : ''}`))
            : console.log('No files.'));
      }
      case 'rename': {
        const f = await patch(`/api/v1/files/${need(rest[0], 'file id')}`, { name: need(flags.name ?? rest.slice(1).join(' '), 'new name (--name)') });
        return out(flags, f, () => console.log(`Renamed file #${f.id} to "${f.name}"`));
      }
      case 'move': {
        const folderId = await resolveFolder(need(flags.folder ?? rest[1], 'destination (--folder <folder> or root)'));
        const f = await patch(`/api/v1/files/${need(rest[0], 'file id')}`, { folderId });
        return out(flags, f, () => console.log(`Moved "${f.name}" ${folderId ? `into folder ${folderId}` : 'to the top level'}`));
      }
      case 'download':
      case 'get': {
        const id = need(rest[0], 'file id');
        const meta = await get(`/api/v1/files/${id}`);
        const dest = flags.out ?? path.basename(meta.name);
        fs.writeFileSync(dest, Buffer.from(await (await rawGet(`/api/v1/files/${id}/content?download=1`)).arrayBuffer()));
        return console.log(`Saved ${meta.name} to ${dest}`);
      }
      case 'delete':
      case 'rm':
        await del(`/api/v1/files/${need(rest[0], 'file id')}`);
        return console.log('Deleted file');
      default:
        fail('Try: file upload <path> [--folder F] | list [--folder F|root] | rename <id> --name X | move <id> --folder F|root | download <id> [--out path] | delete <id>');
    }
  },

  /** Markdown documents stored in the explorer. */
  async doc([sub, ...rest], flags) {
    const content = () => (flags.file ? fs.readFileSync(flags.file, 'utf8') : flags.content !== undefined ? String(flags.content) : undefined);
    switch (sub) {
      case 'create':
      case 'new': {
        const folderId = await resolveFolder(flags.folder);
        const d = await post('/api/v1/docs', { name: need(flags.name ?? rest.join(' '), 'name'), folderId: folderId ?? null, content: content() ?? '' });
        return out(flags, d, () => console.log(`Created document #${d.id}: ${d.name}`));
      }
      case 'write': {
        const id = need(rest[0], 'document id');
        const body = content();
        if (body === undefined) fail('Provide --file path or --content "..."');
        const d = await http('PUT', `/api/v1/files/${id}/content`, { content: body });
        return out(flags, d, () => console.log(`Updated document #${d.id}: ${d.name}`));
      }
      case 'read':
      case 'cat': {
        const res = await rawGet(`/api/v1/files/${need(rest[0], 'document id')}/content`);
        return process.stdout.write(await res.text());
      }
      default:
        fail('Try: doc create --name X [--folder F] [--file path | --content ".."] | doc write <id> --file path | doc read <id>');
    }
  },

  async category([sub, ...rest], flags) {
    switch (sub) {
      case undefined:
      case 'list':
      case 'ls': {
        const { categories } = await get('/api/v1/categories');
        return out(flags, categories, () => categories.forEach((c) => console.log(`${c.id}  ${c.name}  ${c.color}`)));
      }
      case 'create':
      case 'new': {
        const c = await post('/api/v1/categories', { name: need(flags.name ?? rest.join(' '), 'name'), color: flags.color });
        return out(flags, c, () => console.log(`Created category ${c.name} (${c.color})`));
      }
      case 'update':
      case 'edit': {
        const id = await resolveCategory(need(rest[0], 'category (name or id)'));
        const body = {};
        if (flags.name !== undefined) body.name = flags.name;
        if (flags.color !== undefined) body.color = flags.color;
        if (!Object.keys(body).length) fail('Nothing to change. Use --name or --color');
        const c = await patch(`/api/v1/categories/${id}`, body);
        return out(flags, c, () => console.log(`Updated category ${c.name} (${c.color})`));
      }
      case 'delete':
      case 'rm':
        await del(`/api/v1/categories/${await resolveCategory(need(rest[0], 'category (name or id)'))}`);
        return console.log('Deleted category (removed from its tasks)');
      default:
        fail('Try: category list | create --name X [--color #hex] | update <name|id> [--name] [--color] | delete <name|id>');
    }
  },

  /** Task types (Feature, Bug, Content, ...) and their colours. */
  async type([sub, ...rest], flags) {
    switch (sub) {
      case undefined:
      case 'list':
      case 'ls': {
        const r = await get('/api/v1/types');
        return out(flags, r, () => r.types.forEach((t) => console.log(`${t}  ${r.typeColors[t] ?? ''}`)));
      }
      case 'create':
      case 'new': {
        const name = need(flags.name ?? rest.join(' '), 'name');
        await post('/api/v1/types', { name, color: flags.color });
        return console.log(`Created type ${name}`);
      }
      case 'color': {
        const name = await resolveType(need(rest[0], 'type'));
        await patch(`/api/v1/types/${encodeURIComponent(name)}`, { color: need(flags.color ?? rest[1], 'colour (#RRGGBB)') });
        return console.log(`Type ${name} colour updated`);
      }
      case 'delete':
      case 'rm': {
        const name = await resolveType(need(rest[0], 'type'));
        await del(`/api/v1/types/${encodeURIComponent(name)}`);
        return console.log(`Deleted type ${name}`);
      }
      default:
        fail('Try: type list | create --name X [--color #hex] | color <type> #hex | delete <type>');
    }
  },

  /** Kanban column colours (the columns themselves are fixed). */
  async column([sub, ...rest], flags) {
    switch (sub) {
      case undefined:
      case 'list':
      case 'ls': {
        const { statuses } = await get('/api/v1/statuses');
        return out(flags, statuses, () => statuses.forEach((s) => console.log(`${s.label} (${s.id})  ${s.color}`)));
      }
      case 'color': {
        // pm column color "Alpha QA" #22c55e   (or --color #22c55e)
        const color = need(flags.color ?? rest.at(-1), 'colour (#RRGGBB)');
        const ref = need((flags.color ? rest : rest.slice(0, -1)).join(' '), 'column (label or id)');
        await patch(`/api/v1/statuses/${encodeURIComponent(ref)}`, { color });
        return console.log(`Column ${ref} colour updated`);
      }
      default:
        fail('Try: column list | column color "Alpha QA" #hex');
    }
  },

  /** The explorer: folders, epochs (with their tasks), loose tasks and files, as an indented tree. */
  async tree(_, flags) {
    const t = await get('/api/v1/tree');
    out(flags, t, () => {
      const atLevel = (items, pid) => items.filter((x) => (x.folderId ?? null) === pid);
      const taskLine = (k) => `${k.key} [${k.status}] ${k.title}`;
      const print = (pid, depth) => {
        const pad = '  '.repeat(depth);
        for (const f of t.folders.filter((x) => (x.parentId ?? null) === pid)) {
          console.log(`${pad}[folder ${f.id}] ${f.name}/`);
          print(f.id, depth + 1);
        }
        for (const e of atLevel(t.epochs, pid)) {
          console.log(`${pad}[epoch ${e.id}] ${e.name}  (${e.shipped}/${e.total} shipped)`);
          for (const k of t.tasks.filter((x) => x.epochId === e.id)) console.log(`${pad}    ${taskLine(k)}`);
        }
        for (const k of atLevel(t.tasks.filter((x) => !x.epochId), pid)) console.log(`${pad}${pid === null ? '(inbox) ' : ''}${taskLine(k)}`);
        for (const f of atLevel(t.files, pid)) console.log(`${pad}[file ${f.id}] ${f.name}`);
      };
      print(null, 0);
    });
  },

  /** Take a database + files backup now (e.g. before a large reorganisation). */
  async backup(_, flags) {
    const b = await post('/api/v1/backups', {});
    out(flags, b, () => console.log(`Backup created: ${b.name} (${Math.round(b.size / 1024)} KB)`));
  },

  /** Raw access to any endpoint in API.md, using the configured URL and token. */
  async api([method, apiPath], flags) {
    const m = String(need(method, 'method (GET, POST, PATCH, PUT, DELETE)')).toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) fail(`Unsupported method "${method}"`);
    let p = String(need(apiPath, 'path, e.g. /api/v1/tasks?status=open')).replace(/\\/g, '/');
    // Git Bash rewrites arguments that start with "/" into Windows paths ("C:/Program Files/Git/api/v1/...").
    const at = p.indexOf('/api/');
    if (at > 0) p = p.slice(at);
    else if (p.startsWith('api/')) p = '/' + p;
    else if (p.startsWith('v1/')) p = '/api/' + p;
    if (!p.startsWith('/api/')) fail('The path must start with /api/ (e.g. /api/v1/tasks)');
    let body;
    const raw = flags['body-file'] !== undefined ? fs.readFileSync(flags['body-file'], 'utf8') : flags.body;
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        fail(`Body is not valid JSON (${err.message}). Write it to a file and use --body-file.`);
      }
    }
    console.log(JSON.stringify(await http(m, p, body), null, 2));
  },

  async whoami() {
    const me = await get('/api/auth/me');
    console.log(`Connected to ${CFG.base} as ${me.actor} (user ${me.user.username})`);
    if (CFG.urls.length > 1) console.log(`Server addresses, in the order pm tries them: ${CFG.urls.join(', ')}`);
    const cur = await http('GET', '/api/v1/projects/current', undefined, { soft: true });
    if (cur.error) console.log(`No project selected: ${cur.error}`);
    else console.log(`Project: ${cur.key} (${cur.name}), ${cur.openTaskCount} open tasks`);
  },

  /** pm project list | current | create --key K --name N [--color #hex] [--copy-from KEY] | use KEY */
  async project([sub, ...rest], flags) {
    switch (sub ?? 'current') {
      case 'list':
      case 'ls': {
        const { projects } = await get('/api/v1/projects');
        const cur = await http('GET', '/api/v1/projects/current', undefined, { soft: true });
        return out(flags, projects, () => {
          if (!projects.length) return console.log('You have no projects yet. Create one: pm project create --key APP --name "My app"');
          for (const p of projects) console.log(`${p.id === cur.id ? '*' : ' '} ${p.key.padEnd(10)} ${p.name}  (${p.openTaskCount} open of ${p.taskCount})`);
        });
      }
      case 'current': {
        const p = await currentProject();
        return out(flags, p, () => console.log(`${p.key} (${p.name}), ${p.openTaskCount} open of ${p.taskCount} tasks`));
      }
      case 'create':
      case 'new': {
        const body = { key: need(flags.key, 'key (--key APP)'), name: need(flags.name ?? rest.join(' '), 'name (--name "My app")') };
        if (flags.color) body.color = flags.color;
        if (flags['copy-from']) {
          const { projects } = await get('/api/v1/projects');
          const from = projects.find((p) => p.key.toUpperCase() === String(flags['copy-from']).toUpperCase());
          if (!from) fail(`No project with the key ${flags['copy-from']}`);
          body.copyFrom = from.id;
        }
        const p = await post('/api/v1/projects', body);
        return out(flags, p, () => console.log(`Created project ${p.key} (${p.name}). Work in it with: pm project use ${p.key}`));
      }
      case 'use': {
        const key = need(rest[0], 'project key');
        const { projects } = await get('/api/v1/projects');
        const p = projects.find((x) => x.key.toUpperCase() === key.toUpperCase());
        if (!p) fail(`No project with the key ${key}. Yours: ${projects.map((x) => x.key).join(', ') || 'none'}`);
        if (!CFG.file) fail(`Your settings come from environment variables: set PM_PROJECT=${p.key} instead.`);
        const cfg = JSON.parse(fs.readFileSync(CFG.file, 'utf8'));
        cfg.project = p.key;
        fs.writeFileSync(CFG.file, `${JSON.stringify(cfg, null, 2)}\n`);
        return console.log(`Now working in ${p.key} (${p.name}); saved to ${CFG.file}`);
      }
      default:
        fail('Try: project list | current | create --key K --name N [--color #hex] [--copy-from KEY] | use KEY');
    }
  },

  /** pm queue [send | retry [id] | drop <id|failed>]: changes saved while the server couldn't be reached */
  async queue([sub, raw], flags) {
    const id = raw === undefined ? undefined : String(raw).replace(/^#/, ''); // pm queue shows them as #3
    switch (sub ?? 'list') {
      case 'list':
      case 'ls':
      case 'show': {
        const box = readOutbox();
        return out(flags, { file: outboxFile(), waiting: box.entries, refused: box.failed, timer: box.timer, keys: box.keys }, () => {
          if (!box.entries.length && !box.failed.length && !box.timer) return console.log('Nothing is saved offline.');
          if (box.entries.length) {
            console.log('Waiting to be sent, oldest first (by the next pm command that reaches the server, or pm queue send):');
            for (const e of box.entries) console.log(`  #${e.id}  saved ${when(e.at)}  ${describe(e)}`);
          }
          if (box.timer) {
            console.log(`Timer running on this computer since ${when(box.timer.startedAt)} on ${targetName(box.timer.target)}; logged when it's stopped (pm time stop)`);
          }
          if (box.failed.length) {
            console.log('Refused when sent (pm queue retry [id] tries again, pm queue drop <id|failed> throws away):');
            for (const e of box.failed) console.log(`  #${e.id}  ${describe(e)}\n        ${e.error}`);
          }
        });
      }
      case 'send': {
        if (!readOutbox().entries.length) return console.log('Nothing is waiting to be sent.');
        const { refused } = await flushOutbox(console.log);
        if (CFG.offline) fail(`${CFG.offline}. What wasn't sent stays saved.`);
        if (refused) process.exitCode = 1;
        return;
      }
      case 'retry': {
        const back = await withOutbox((box) => {
          const again = box.failed.filter((e) => id === undefined || String(e.id) === String(id));
          box.failed = box.failed.filter((e) => !again.includes(e));
          for (const e of again) {
            delete e.error;
            delete e.failedAt;
          }
          box.entries = [...box.entries, ...again].sort((a, b) => a.id - b.id);
          return again.length;
        });
        if (!back) fail(id === undefined ? 'No refused changes to retry.' : `No refused change #${id} (pm queue lists them).`);
        const { refused } = await flushOutbox(console.log);
        if (CFG.offline) fail(`${CFG.offline}. What wasn't sent stays saved.`);
        if (refused) process.exitCode = 1;
        return;
      }
      case 'drop':
      case 'rm': {
        if (id === undefined) fail('Say which: pm queue drop <id> | failed | timer');
        if (id === 'timer') {
          const timer = await withOutbox((box) => {
            const t = box.timer;
            box.timer = null;
            return t;
          });
          if (!timer) fail('No timer is running on this computer.');
          return console.log(`Dropped the timer started offline on ${targetName(timer.target)} at ${when(timer.startedAt)}; no time is logged for it.`);
        }
        const gone = await withOutbox((box) => {
          const all = [...box.entries, ...box.failed];
          const dropped = id === 'failed' ? box.failed : all.filter((e) => String(e.id) === String(id));
          box.entries = box.entries.filter((e) => !dropped.includes(e));
          box.failed = box.failed.filter((e) => !dropped.includes(e));
          return dropped;
        });
        if (!gone.length) fail(id === 'failed' ? 'No refused changes.' : `No saved change #${id} (pm queue lists them).`);
        for (const e of gone) console.log(`Dropped #${e.id}: ${describe(e)}`);
        return;
      }
      default:
        fail('Try: pm queue | queue send | queue retry [id] | queue drop <id|failed|timer>');
    }
  },

  help() {
    console.log(`pm — Project Manager CLI

Projects: pm project list | current | create --key APP --name "My app" [--color #hex] [--copy-from KEY] | use APP
          Commands work in the project named in .pm.json ("project"); add --project KEY to any command for another one.

Tasks (keys look like APP-12; a bare 12 means task 12 of the current project):
  pm task list [--status S] [--category C] [--type T] [--priority P] [--epoch E|none] [--folder F|inbox] [--created-by NAME] [--q text]
               [--parent APP-3|none|any]           a task's own sub-tasks | top-level tasks only | sub-tasks only
                                                  (in board order: column by column, each from the top down)
  pm task get APP-12
  pm task subtasks APP-3                          its own sub-tasks and how many are done (sub-tasks can have
                                                  sub-tasks too, up to 5 levels deep)
  pm task create --title "..." [--type Feature] [--category UI,Backend] [--epoch "Version 1.0"]
                 [--priority high] [--status open] [--desc "..." | --desc-file notes.md] [--estimate 2h]
                 [--check "step one" --check "step two"] [--folder F] [--parent APP-3]
  pm task update APP-12 [same flags as create]    --epoch moves it into an epoch; --folder F|inbox takes it out;
                                                  --parent APP-3 makes it a sub-task, --parent none makes it top-level
  pm task update APP-12 APP-13 APP-14 --priority high   several tasks in one go (all or none); any flag but
                                                  --title and --desc
  pm task advance APP-12 [--note "why"]           move to the next Kanban column
  pm task status APP-12 [APP-13 ...] "Alpha QA" [--note ".."]   set any status, on one task or several
  pm task reorder APP-12 --top | --bottom | --before APP-9 | --after APP-9
                                                  its place in its column (never its column)
  pm task reorder APP-3 APP-7 APP-5 --top         several: together, in the order given (all in one column)
  pm task note APP-12 "progress message"
  pm task check APP-12 "checklist item"           add checklist item
  pm item 34 [--undo] [--text ".."] [--remove]    tick / untick / reword / remove a checklist item (ids shown by task get)
  pm task link APP-12 [blocks | blocked by | duplicates | duplicated by | relates to] APP-9   (default: relates to)
  pm task unlink APP-12 APP-9                     one link per pair of tasks; links show in task get
  pm task delete APP-12 [--with-subtasks]         without the flag its sub-tasks stay, moving up a level;
                                                  with it they go too, at every level
  pm task create --template Card --title "Fireball"   a task, and its sub-tasks, from a template; other flags
                                                  replace the template's values ({title} becomes the title)

Templates (per project; types, categories and epochs are kept by name):
  pm template list | show <name|id> | delete <name|id>
  pm template create --name Card [--title "Card: {title}"] [--type T] [--priority P] [--category A,B] [--epoch E]
                     [--estimate 2h] [--desc ".." | --desc-file f] [--check "step" --check "step"]
  pm template create --name Boss --from-task APP-12 [--with-subtasks] [--title "Boss: {title}"]
  pm template create --name Card --file card.json   all fields and "subtasks": [{ "title": "VFX: {title}", "epoch": "VFX" }]
  pm template update <name|id> [same flags; --file changes the fields it has; "subtasks" replaces the list]

Epochs:   pm epoch list | get <id|name> | create --name X [--desc] [--color #hex] [--folder F] [--estimate 20h] [--target YYYY-MM-DD]
          pm epoch update <id|name> [same flags; --folder F|root moves it] | delete <id|name> [--delete-time]
          (deleting keeps the tasks; time logged on the epoch itself is deleted too, so it needs --delete-time)
Explorer: pm tree                                  folders, epochs, tasks and files as one tree
Folders:  pm folder list | create --name X [--parent F] | rename F --name X | move F --parent P|root
          pm folder delete F                       (its contents move to the parent folder)
Time:     pm time start --task APP-12 | --epoch E  [--note]
          pm time stop [--note]   |  pm time status
          pm time log --task APP-12 --duration 1h30m [--note] [--date 2026-11-11]
          pm time list [--task APP-12 | --epoch E] [--from DATE] [--to DATE]
          pm time edit <entry> [--duration 45m] [--note ..] [--date ..]  |  pm time delete <entry>
Diagram:  pm diagram list | show [id|name] | create --name X | rename --name X | export [--out file.json]
          pm diagram add-node --label "AuthService" [--layer services] [--parent "Backend"] [--path src/auth/] [--role "Checks logins"]
                     [--weight 1200] [--width 200 --height 80] [--desc ".."] [--link-task APP-12 | --link-epoch E]
          pm diagram update-node "AuthService" [same flags; --label renames it; none clears one: --parent none, --weight none]
          pm diagram rm-node "AuthService" [--with-children]      (without it, the boxes inside move up a level)
          pm diagram connect "AuthService" "Database" [--label "reads users"] [--count 12]
          pm diagram update-edge <id> | "From" "To" [--label ..] [--count N|none]  |  pm diagram rm-edge <id> | "From" "To"
          pm diagram import file.json [--replace] [--yes]   shows what would change; --yes applies it in one save
          pm diagram settings [--layout auto|manual] [--direction down|right]
          Add --diagram <id|name> for a diagram other than the first. Boxes are named by label or id.
Files:    pm file upload ./path [--folder F] | list [--folder F|root] | download <id> [--out path]
          pm file rename <id> --name X | move <id> --folder F|root | delete <id>
Docs:     pm doc create --name "Design notes.md" [--folder F] [--file notes.md | --content ".."]
          pm doc write <id> --file notes.md  |  pm doc read <id>     (rename/move/delete docs with pm file ...)
          (embed an uploaded image in markdown with ![alt](/api/v1/files/<id>/content); for .svg use /render)
Colours:  pm category list | create --name X [--color #hex] | update <name|id> [--name X] [--color #hex] | delete <name|id>
          pm type list | create --name X [--color #hex] | color <type> #hex | delete <type>
          pm column list | color "Alpha QA" #hex             (Kanban column colours)
Other:    pm meta (valid statuses/types/categories) | pm backup (backup now) | pm whoami
          pm api <GET|POST|PATCH|PUT|DELETE> /api/v1/... [--body '{"json":1}' | --body-file body.json]
                                                    any endpoint in API.md (next to this file) with your token
Offline:  when the server can't be reached, changes to tasks (create, update, status, advance, note, check, link,
          unlink, pm item) and time tracking (start, stop, log) are saved on this computer, and the next pm command
          that reaches the server sends them, oldest first. Never repeat a command that was saved: it would go twice.
          A task created offline is NEW_1 (NEW_2, ...) until it's sent; use that key for it meanwhile. A timer started
          offline runs here and is logged with its real start and length. Looking things up needs the server.
          pm queue (what's saved) | queue send | queue retry [id] (refused ones) | queue drop <id|failed|timer>
Addresses: "fallbackUrls" in .pm.json lists other addresses of the same server, tried in order when "url" doesn't
          answer (pm whoami shows which one answered)

Statuses: Open → In Progress → Alpha QA → Alpha Complete → Beta In Progress → Beta QA → Beta Complete → Ready to Ship
Folder and epoch names are matched case-insensitively; use the id if a name is ambiguous.
Add --json to any command for machine-readable output.`);
  },
};

function need(v, what) {
  if (v === undefined || v === null || v === '') fail(`Missing ${what}`);
  return v;
}

const argv = process.argv.slice(2);
const { pos, flags } = parseArgs(argv);
PROJECT_FLAG = flags.project;
const [cmd, ...rest] = pos;
if (!cmd || flags.help || cmd === 'help') commands.help();
else if (!commands[cmd]) fail(`Unknown command "${cmd}". Run: pm help`);
else await run(cmd, rest, flags, argv);

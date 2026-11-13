import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';
import { createUser } from '../server/auth.ts';
import type { AppContext } from '../server/context.ts';
import { createProject } from '../server/routes/projects.ts';
import { COPY_LIMITS } from '../server/routes/copy.ts';

let app: FastifyInstance;
let ctx: AppContext;
let cookie = '';
let token = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));

type Json = Record<string, any>;

async function call(method: string, url: string, body?: unknown, auth: 'session' | 'token' | 'none' = 'session') {
  const headers: Record<string, string> = {};
  if (auth === 'session') {
    headers.cookie = cookie;
    headers['x-pm-client'] = 'web';
  } else if (auth === 'token') headers.authorization = `Bearer ${token}`;
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers,
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Json) : {}, res };
}

/** Uploads a small file into a folder (null: the top level) and returns it. */
async function upload(folderId: number | null, filename: string, data: string, type = 'text/plain') {
  const b = '----upload';
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { cookie, 'x-pm-client': 'web', 'content-type': `multipart/form-data; boundary=${b}` },
    payload:
      (folderId !== null ? `--${b}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${folderId}\r\n` : '') +
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n${data}\r\n--${b}--\r\n`,
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).files[0] as Json;
}

before(async () => {
  const built = await buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      dataDir: tmp,
      webDist: path.join(tmp, 'no-web'),
      backupIntervalHours: 0,
      backupKeep: 3,
      maxUploadMb: 5,
    },
    { dbFile: ':memory:' },
  );
  app = built.app;
  ctx = built.ctx;
  const alice = createUser(ctx.db, 'alice', 'correct-horse');
  createProject(ctx.db, alice, {
    key: 'T',
    name: 'Test game',
    categories: [
      ['Trinket', '#d97706'],
      ['Combat', '#7c3aed'],
    ],
  });
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('rejects unauthenticated requests', async () => {
  const r = await call('GET', '/api/v1/tasks', undefined, 'none');
  assert.equal(r.status, 401);
  const h = await call('GET', '/api/health', undefined, 'none');
  assert.equal(h.status, 200);
});

test('login: wrong password fails, correct password sets cookie', async () => {
  const bad = await call('POST', '/api/auth/login', { username: 'alice', password: 'nope' }, 'none');
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/auth/login', { username: 'ALICE', password: 'correct-horse' }, 'none');
  assert.equal(ok.status, 200);
  const setCookie = ok.res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  cookie = raw.split(';')[0];
  assert.match(cookie, /^pm_session=/);
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.body.user.username, 'alice');
});

test('cookie writes without the CSRF header are refused', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/folders', headers: { cookie }, payload: { name: 'x' } });
  assert.equal(res.statusCode, 403);
});

test('API token auth and actor name', async () => {
  const t = await call('POST', '/api/v1/tokens', { name: 'claude' });
  assert.equal(t.status, 201);
  token = t.body.token;
  assert.match(token, /^pm_/);
  // tokens cannot manage tokens
  const denied = await call('GET', '/api/v1/tokens', undefined, 'token');
  assert.equal(denied.status, 403);
  const created = await call('POST', '/api/v1/tasks', { title: 'Made by Claude', categories: ['Trinket'] }, 'token');
  assert.equal(created.status, 201);
  assert.equal(created.body.createdBy, 'claude');
  assert.equal(created.body.categories[0].name, 'Trinket');
  const bad = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { authorization: 'Bearer pm_wrong' } });
  assert.equal(bad.statusCode, 401);
});

test('task lifecycle: create, validate, advance, status by label, filter', async () => {
  const e = await call('POST', '/api/v1/epochs', { name: 'Act 1 Relics', color: '#ff8800', estimate: '10h' });
  assert.equal(e.status, 201);
  assert.equal(e.body.estimateMinutes, 600);

  const bad = await call('POST', '/api/v1/tasks', { title: 'x', type: 'Nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Valid: Feature/);
  const badCat = await call('POST', '/api/v1/tasks', { title: 'x', categories: ['Nope'] });
  assert.equal(badCat.status, 400);

  const t = await call('POST', '/api/v1/tasks', {
    title: 'Trinket: Cracked Hourglass',
    type: 'Content',
    priority: 'High',
    epochId: e.body.id,
    categories: ['trinket', 'Combat'],
    checklist: ['Implement effect', 'Write tests'],
    estimate: '1h30m',
  });
  assert.equal(t.status, 201);
  assert.equal(t.body.key, `T-${t.body.number}`);
  assert.equal(t.body.status, 'open');
  assert.equal(t.body.priority, 'high');
  assert.equal(t.body.estimateMinutes, 90);
  assert.equal(t.body.checklistItems.length, 2);
  const key = t.body.key;

  const adv = await call('POST', `/api/v1/tasks/${key}/advance`, { note: 'Started' }, 'token');
  assert.equal(adv.body.status, 'in_progress');
  const st = await call('POST', `/api/v1/tasks/${key}/status`, { status: 'Alpha QA', note: 'Tests pass' }, 'token');
  assert.equal(st.body.status, 'alpha_qa');

  const detail = await call('GET', `/api/v1/tasks/${key}`);
  const kinds = detail.body.activity.map((a: Json) => a.kind);
  assert.deepEqual(kinds.slice(0, 3), ['status', 'status', 'created']);
  assert.match(detail.body.activity[0].message, /In Progress → Alpha QA: Tests pass/);
  assert.equal(detail.body.activity[0].actor, 'claude');

  const f1 = await call('GET', '/api/v1/tasks?status=alpha_qa&category=Trinket');
  assert.equal(f1.body.tasks.length, 1);
  const f2 = await call('GET', '/api/v1/tasks?q=hourglass');
  assert.equal(f2.body.tasks.length, 1);
  const f3 = await call('GET', `/api/v1/tasks?epoch=${e.body.id}&priority=low`);
  assert.equal(f3.body.tasks.length, 0);
  const f4 = await call('GET', `/api/v1/tasks?q=${key}`);
  assert.equal(f4.body.tasks[0].id, t.body.id);

  const ep = await call('GET', `/api/v1/epochs/${e.body.id}`);
  assert.equal(ep.body.counts.alpha_qa, 1);
  assert.equal(ep.body.taskEstimateMinutes, 90);
});

test('board move ordering', async () => {
  const ids: number[] = [];
  for (const title of ['A', 'B', 'C']) {
    const r = await call('POST', '/api/v1/tasks', { title, status: 'Beta QA' });
    ids.push(r.body.id);
  }
  // Move C before A
  await call('POST', `/api/v1/tasks/${ids[2]}/move`, { status: 'beta_qa', beforeId: ids[0] });
  let list = await call('GET', '/api/v1/tasks?status=beta_qa');
  assert.deepEqual(list.body.tasks.map((t: Json) => t.title), ['C', 'A', 'B']);
  // Move A to end of another column
  await call('POST', `/api/v1/tasks/${ids[0]}/move`, { status: 'ready_to_ship', beforeId: null });
  list = await call('GET', '/api/v1/tasks?status=beta_qa');
  assert.deepEqual(list.body.tasks.map((t: Json) => t.title), ['C', 'B']);
});

test('folders: nesting, cycle prevention, recursive filter, non-destructive delete', async () => {
  const game = (await call('POST', '/api/v1/folders', { name: 'Game' })).body;
  const sub = (await call('POST', '/api/v1/folders', { name: 'Systems', parentId: game.id })).body;
  const cyc = await call('PATCH', `/api/v1/folders/${game.id}`, { parentId: sub.id });
  assert.equal(cyc.status, 400);

  const task = (await call('POST', '/api/v1/tasks', { title: 'Deep task', folderId: sub.id })).body;
  const epoch = (await call('POST', '/api/v1/epochs', { name: 'Sub epoch', folderId: sub.id })).body;
  const inEpoch = (await call('POST', '/api/v1/tasks', { title: 'Epoch task', epochId: epoch.id })).body;
  const filtered = await call('GET', `/api/v1/tasks?folder=${game.id}`);
  const titles = filtered.body.tasks.map((t: Json) => t.title).sort();
  assert.deepEqual(titles, ['Deep task', 'Epoch task']);

  // moving into a folder removes the task from its epoch
  const moved = await call('PATCH', `/api/v1/tasks/${inEpoch.id}`, { folderId: game.id });
  assert.equal(moved.body.epochId, null);
  assert.equal(moved.body.folderId, game.id);

  const del = await call('DELETE', `/api/v1/folders/${sub.id}`);
  assert.equal(del.status, 200);
  const after = await call('GET', `/api/v1/tasks/${task.id}`);
  assert.equal(after.body.folderId, game.id);
  const ep = await call('GET', `/api/v1/epochs/${epoch.id}`);
  assert.equal(ep.body.folderId, game.id);
});

test('time tracking: manual entries, timers, epoch roll-up', async () => {
  const epoch = (await call('POST', '/api/v1/epochs', { name: 'Timed' })).body;
  const task = (await call('POST', '/api/v1/tasks', { title: 'Timed task', epochId: epoch.id })).body;

  const m = await call('POST', '/api/v1/time', { taskId: task.key, duration: '1h15m', note: 'design' }, 'token');
  assert.equal(m.status, 201);
  assert.equal(m.body.minutes, 75);
  const m2 = await call('POST', '/api/v1/time', { epochId: epoch.id, minutes: 30 });
  assert.equal(m2.status, 201);
  const both = await call('POST', '/api/v1/time', { epochId: epoch.id, taskId: task.id, minutes: 5 });
  assert.equal(both.status, 400);
  const badDur = await call('POST', '/api/v1/time', { taskId: task.id, duration: 'soon' });
  assert.equal(badDur.status, 400);

  const start = await call('POST', '/api/v1/time/start', { taskId: task.id }, 'token');
  assert.equal(start.status, 201);
  assert.equal(start.body.running, true);
  const running = await call('GET', '/api/v1/time/running', undefined, 'token');
  assert.equal(running.body.entry.id, start.body.id);
  // the web user's timer is separate from the token's
  const mine = await call('GET', '/api/v1/time/running');
  assert.equal(mine.body.entry, null);
  // starting another timer stops the first
  const start2 = await call('POST', '/api/v1/time/start', { epochId: epoch.id }, 'token');
  const first = await call('GET', `/api/v1/time?taskId=${task.id}`);
  assert.equal(first.body.entries.find((e: Json) => e.id === start.body.id).running, false);
  const stop = await call('POST', '/api/v1/time/stop', { note: 'done' }, 'token');
  assert.equal(stop.body.id, start2.body.id);
  assert.equal(stop.body.running, false);
  const stopAgain = await call('POST', '/api/v1/time/stop', {}, 'token');
  assert.equal(stopAgain.status, 404);

  const t = await call('GET', `/api/v1/tasks/${task.id}`);
  assert.ok(t.body.loggedMinutes >= 76, `task logged ${t.body.loggedMinutes}`);
  const e = await call('GET', `/api/v1/epochs/${epoch.id}`);
  assert.ok(e.body.loggedMinutes >= 107, `epoch logged ${e.body.loggedMinutes}`);
  const list = await call('GET', `/api/v1/time?epochId=${epoch.id}`);
  assert.equal(list.body.entries.length, 4);

  const edit = await call('PATCH', `/api/v1/time/${m.body.id}`, { duration: '2h' });
  assert.equal(edit.body.minutes, 120);
});

test('diagrams: granular node/edge ops and optimistic concurrency', async () => {
  const list = await call('GET', '/api/v1/diagrams');
  const id = list.body.diagrams[0].id;
  const a = await call('POST', `/api/v1/diagrams/${id}/nodes`, { label: 'CombatManager', layer: 'gameplay' }, 'token');
  assert.equal(a.status, 201);
  const b = await call('POST', `/api/v1/diagrams/${id}/nodes`, { label: 'RelicSystem', layer: 'gameplay' }, 'token');
  assert.notDeepEqual([a.body.x, a.body.y], [b.body.x, b.body.y]);
  const dup = await call('POST', `/api/v1/diagrams/${id}/nodes`, { label: 'relicsystem' }, 'token');
  assert.equal(dup.status, 409);
  const edge = await call('POST', `/api/v1/diagrams/${id}/edges`, { source: 'RelicSystem', target: 'CombatManager', label: 'hooks' }, 'token');
  assert.equal(edge.status, 201);
  const upd = await call('PATCH', `/api/v1/diagrams/${id}/nodes/RelicSystem`, { description: 'Applies trinket effects' }, 'token');
  assert.equal(upd.body.description, 'Applies trinket effects');

  const d = (await call('GET', `/api/v1/diagrams/${id}`)).body;
  assert.equal(d.nodes.length, 2);
  assert.equal(d.edges.length, 1);
  const stale = await call('PUT', `/api/v1/diagrams/${id}`, { version: d.version - 1, nodes: d.nodes, edges: d.edges });
  assert.equal(stale.status, 409);
  const ok = await call('PUT', `/api/v1/diagrams/${id}`, { version: d.version, nodes: d.nodes, edges: d.edges });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, d.version + 1);

  await call('DELETE', `/api/v1/diagrams/${id}/nodes/CombatManager`);
  const after = (await call('GET', `/api/v1/diagrams/${id}`)).body;
  assert.equal(after.edges.length, 0);
});

test('diagrams: groups, sizes, path, role, weight and arrow counts', async () => {
  const id = (await call('POST', '/api/v1/diagrams', { name: 'Groups' })).body.id;
  const url = `/api/v1/diagrams/${id}`;
  const combat = await call(
    'POST',
    `${url}/nodes`,
    { label: 'Combat', path: 'src/combat/', role: 'Runs fights\nand more', weight: 1200, width: 10, height: 99999 },
    'token',
  );
  assert.equal(combat.status, 201, JSON.stringify(combat.body));
  assert.deepEqual(
    [combat.body.path, combat.body.role, combat.body.weight, combat.body.width, combat.body.height],
    ['src/combat/', 'Runs fights', 1200, 40, 4000],
  );

  const inner = await call('POST', `${url}/nodes`, { label: 'Damage', parent: 'combat' }, 'token');
  assert.equal(inner.status, 201);
  assert.equal(inner.body.parent, combat.body.id);
  assert.deepEqual([inner.body.x, inner.body.y], [20, 56]); // clear of the group's header
  // A label only has to be unique among the boxes next to it...
  const top = await call('POST', `${url}/nodes`, { label: 'Damage' }, 'token');
  assert.equal(top.status, 201);
  assert.equal(top.body.parent, undefined);
  assert.equal((await call('POST', `${url}/nodes`, { label: 'damage', parent: combat.body.id }, 'token')).status, 409);
  // ...so a label two boxes share can't name one of them.
  assert.equal((await call('PATCH', `${url}/nodes/Damage`, { role: 'x' }, 'token')).status, 409);
  assert.equal((await call('POST', `${url}/nodes`, { label: 'Orphan', parent: 'Nope' }, 'token')).status, 404);
  assert.equal((await call('POST', `${url}/nodes`, { label: 'Long id', id: 'x'.repeat(129) }, 'token')).status, 400);

  // null clears a field, a missing one stays, a wrong type is refused.
  const cleared = await call('PATCH', `${url}/nodes/Combat`, { width: null, weight: null, role: null }, 'token');
  assert.equal(cleared.status, 200);
  assert.deepEqual(
    [cleared.body.width, cleared.body.weight, cleared.body.role, cleared.body.height, cleared.body.path],
    [undefined, undefined, undefined, 4000, 'src/combat/'],
  );
  assert.equal((await call('PATCH', `${url}/nodes/Combat`, { weight: 'heavy' }, 'token')).status, 400);

  // No loops, nothing inside itself, and at most six groups deep.
  assert.equal((await call('PATCH', `${url}/nodes/Combat`, { parent: inner.body.id }, 'token')).status, 400);
  assert.equal((await call('PATCH', `${url}/nodes/Combat`, { parent: 'Combat' }, 'token')).status, 400);
  let parent = combat.body.id;
  for (let level = 2; level <= 7; level++) {
    const r = await call('POST', `${url}/nodes`, { label: `Level ${level}`, parent }, 'token');
    assert.equal(r.status, 201, `level ${level}: ${JSON.stringify(r.body)}`);
    parent = r.body.id;
  }
  assert.equal((await call('POST', `${url}/nodes`, { label: 'Too deep', parent }, 'token')).status, 400);

  // Arrows: never between a box and a group it is in; joining the same two boxes again returns the arrow there is.
  assert.equal((await call('POST', `${url}/edges`, { source: inner.body.id, target: 'Combat' }, 'token')).status, 400);
  const e = await call('POST', `${url}/edges`, { source: top.body.id, target: 'Combat', label: 'calls', count: 42 }, 'token');
  assert.equal(e.status, 201);
  assert.equal(e.body.count, 42);
  assert.equal((await call('POST', `${url}/edges`, { source: top.body.id, target: 'Combat' }, 'token')).body.id, e.body.id);
  const reset = await call('PATCH', `${url}/edges/${e.body.id}`, { count: null }, 'token');
  assert.deepEqual([reset.status, reset.body.count, reset.body.label], [200, undefined, 'calls']);
  const relabelled = await call('PATCH', `${url}/edges/${e.body.id}`, { label: 'hits', count: 3 }, 'token');
  assert.deepEqual([relabelled.body.label, relabelled.body.count], ['hits', 3]);
  assert.equal((await call('PATCH', `${url}/edges/nope`, { count: 2 }, 'token')).status, 404);

  const listed = (await call('GET', '/api/v1/diagrams')).body;
  assert.equal(listed.limits.depth, 6);
  const row = listed.diagrams.find((x: Json) => x.id === id);
  assert.deepEqual([row.nodeCount, row.edgeCount], [9, 1]);
});

test('diagrams: older pages keep the new fields, schema 2 saves exactly what is sent, settings stay put', async () => {
  const id = (await call('POST', '/api/v1/diagrams', { name: 'Compat' })).body.id;
  const url = `/api/v1/diagrams/${id}`;
  const a = (await call('POST', `${url}/nodes`, { label: 'A', width: 300, path: 'src/a/', role: 'Does A', weight: 10 })).body;
  const g = (await call('POST', `${url}/nodes`, { label: 'G' })).body;
  const c = (await call('POST', `${url}/nodes`, { label: 'C', parent: 'G' })).body;
  const e = (await call('POST', `${url}/edges`, { source: 'A', target: 'G', count: 5 })).body;

  const set = await call('PATCH', url, { settings: { layout: 'manual', direction: 'RIGHT' } });
  assert.deepEqual(set.body.settings, { layout: 'manual', direction: 'RIGHT' });
  assert.equal((await call('PATCH', url, { settings: { layout: 'sideways' } })).status, 400);

  // What a page from before groups sends: no sizes, parents, path, role, weight, counts or settings.
  const old = (n: Json) => ({ id: n.id, label: n.label, description: n.description, layer: n.layer, x: n.x, y: n.y, link: null });
  let d = (await call('GET', url)).body;
  const legacy = await call('PUT', url, {
    version: d.version,
    nodes: d.nodes.map(old),
    edges: [
      ...d.edges.map((x: Json) => ({ id: x.id, source: x.source, target: x.target, label: x.label })),
      { id: 'into-own-group', source: c.id, target: g.id, label: '' },
    ],
  });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  d = legacy.body;
  const A = d.nodes.find((n: Json) => n.id === a.id);
  assert.deepEqual([A.width, A.path, A.role, A.weight], [300, 'src/a/', 'Does A', 10]);
  assert.equal(d.nodes.find((n: Json) => n.id === c.id).parent, g.id);
  assert.deepEqual(d.edges.map((x: Json) => [x.id, x.count]), [[e.id, 5]]); // the arrow into its own group is dropped
  assert.deepEqual(d.settings, { layout: 'manual', direction: 'RIGHT' });

  // An older page that deleted the group: what was inside it moves to the top level.
  const noGroup = await call('PUT', url, { version: d.version, nodes: d.nodes.filter((n: Json) => n.id !== g.id).map(old), edges: [] });
  assert.equal(noGroup.status, 200);
  assert.equal(noGroup.body.nodes.find((n: Json) => n.id === c.id).parent, undefined);

  // schema 2: the body is the whole diagram. A field left out is cleared, and what doesn't fit is refused.
  d = noGroup.body;
  const full = await call('PUT', url, { version: d.version, schema: 2, nodes: d.nodes.map(old), edges: [], settings: { layout: 'auto' } });
  assert.equal(full.status, 200);
  assert.equal(full.body.nodes.find((n: Json) => n.id === a.id).width, undefined);
  assert.deepEqual(full.body.settings, { layout: 'auto', direction: 'RIGHT' });
  d = full.body;
  const nested = [...d.nodes.map(old), { id: 'g2', label: 'G2', x: 0, y: 0 }, { id: 'c2', label: 'C2', parent: 'g2', x: 0, y: 0 }];
  const intoGroup = [{ id: 'x', source: 'c2', target: 'g2', label: '' }];
  assert.equal((await call('PUT', url, { version: d.version, schema: 2, nodes: nested, edges: intoGroup })).status, 400);
  const twice = [...nested, { id: 'c2', label: 'Again', x: 0, y: 0 }];
  assert.equal((await call('PUT', url, { version: d.version, schema: 2, nodes: twice, edges: [] })).status, 400);

  // Changing one box or arrow keeps the settings.
  await call('PATCH', url, { settings: { layout: 'manual' } });
  await call('POST', `${url}/nodes`, { label: 'D' });
  await call('PATCH', `${url}/nodes/D`, { role: 'Does D' });
  const de = (await call('POST', `${url}/edges`, { source: 'D', target: 'A' })).body;
  await call('PATCH', `${url}/edges/${de.id}`, { count: 2 });
  await call('DELETE', `${url}/edges/${de.id}`);
  await call('DELETE', `${url}/nodes/D`);
  assert.deepEqual((await call('GET', url)).body.settings, { layout: 'manual', direction: 'RIGHT' });
});

test('diagrams: deleting a group moves what is inside up a level, or deletes all of it', async () => {
  const id = (await call('POST', '/api/v1/diagrams', { name: 'Delete groups' })).body.id;
  const url = `/api/v1/diagrams/${id}`;
  await call('POST', `${url}/nodes`, { label: 'G', x: 100, y: 200 });
  const c1 = (await call('POST', `${url}/nodes`, { label: 'C1', parent: 'G', x: 20, y: 56 })).body;
  await call('POST', `${url}/nodes`, { label: 'C2', parent: 'G' });
  const g2 = (await call('POST', `${url}/nodes`, { label: 'G2', parent: 'G' })).body;
  await call('POST', `${url}/nodes`, { label: 'C3', parent: 'G2' });
  await call('POST', `${url}/nodes`, { label: 'X' });
  await call('POST', `${url}/edges`, { source: 'C1', target: 'C2' });
  await call('POST', `${url}/edges`, { source: 'C3', target: 'X' });
  await call('POST', `${url}/edges`, { source: 'X', target: 'G' });

  assert.deepEqual((await call('DELETE', `${url}/nodes/G`)).body, { ok: true, removed: 1 });
  let d = (await call('GET', url)).body;
  const C1 = d.nodes.find((n: Json) => n.id === c1.id);
  assert.deepEqual([C1.parent, C1.x, C1.y], [undefined, 120, 256]); // the same place on the canvas
  assert.equal(d.nodes.find((n: Json) => n.id === g2.id).parent, undefined);
  assert.equal(d.nodes.find((n: Json) => n.label === 'C3').parent, g2.id);
  assert.equal(d.edges.length, 2); // only the arrow to G went

  // Moving up must not put two boxes with the same label side by side.
  await call('POST', `${url}/nodes`, { label: 'H' });
  await call('POST', `${url}/nodes`, { label: 'X', parent: 'H' });
  assert.equal((await call('DELETE', `${url}/nodes/H`)).status, 409);
  assert.deepEqual((await call('DELETE', `${url}/nodes/H?withChildren=true`)).body, { ok: true, removed: 2 });

  assert.deepEqual((await call('DELETE', `${url}/nodes/G2?withChildren=true`)).body, { ok: true, removed: 2 });
  d = (await call('GET', url)).body;
  assert.deepEqual(d.nodes.map((n: Json) => n.label).sort(), ['C1', 'C2', 'X']);
  assert.equal(d.edges.length, 1); // C1 -> C2; the arrow from C3 went with it
});

test('diagrams: import merges or replaces many boxes and arrows in one save', async () => {
  const id = (await call('POST', '/api/v1/diagrams', { name: 'Import' })).body.id;
  const url = `/api/v1/diagrams/${id}`;
  const combat = (await call('POST', `${url}/nodes`, { label: 'Combat', x: 500, y: 600, width: 320 })).body;
  const combatUtils = (await call('POST', `${url}/nodes`, { label: 'Utils', parent: 'Combat' })).body;
  const ui = (await call('POST', `${url}/nodes`, { label: 'UI' })).body;
  await call('POST', `${url}/nodes`, { label: 'Utils', parent: 'UI' });
  await call('POST', `${url}/nodes`, { label: 'Save' });
  const writes = (await call('POST', `${url}/edges`, { source: 'Combat', target: 'Save', label: 'writes', count: 4 })).body;
  const before = (await call('GET', url)).body;

  // Merge, matching by label (in the same group first). Fields left out stay; an arrow listed twice adds up.
  const merged = await call(
    'POST',
    `${url}/import`,
    {
      nodes: [{ label: 'Combat', role: 'Runs fights' }, { label: 'Utils', parent: 'Combat', path: 'src/combat/utils/' }, { label: 'Audio' }],
      edges: [
        { source: 'Combat', target: 'Audio' },
        { source: 'combat', target: 'audio', count: 2 },
        { source: 'Audio', target: 'Save', label: 'reads' },
      ],
    },
    'token',
  );
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.deepEqual(merged.body.nodes, { added: 1, updated: 2, removed: 0 });
  assert.deepEqual(merged.body.edges, { added: 2, updated: 0, removed: 0 });
  assert.equal(merged.body.version, before.version + 1);
  let d = (await call('GET', url)).body;
  const find = (label: string, parent?: string) => d.nodes.find((n: Json) => n.label === label && n.parent === parent);
  const C = find('Combat');
  assert.deepEqual([C.id, C.x, C.y, C.width, C.role], [combat.id, 500, 600, 320, 'Runs fights']);
  assert.equal(find('Utils', combat.id).path, 'src/combat/utils/');
  assert.equal(find('Utils', ui.id).path, undefined);
  const audio = find('Audio');
  assert.equal(d.edges.find((e: Json) => e.source === combat.id && e.target === audio.id).count, 3);
  assert.equal(d.edges.find((e: Json) => e.id === writes.id).count, 4);

  // A label several boxes share needs an id, as does a reference to one. Nothing is saved when an import fails.
  assert.equal((await call('POST', `${url}/import`, { nodes: [{ label: 'Utils', role: 'x' }] }, 'token')).status, 409);
  assert.equal((await call('POST', `${url}/import`, { nodes: [{ label: 'Z' }], edges: [{ source: 'Z', target: 'Utils' }] }, 'token')).status, 409);
  assert.equal((await call('POST', `${url}/import`, { nodes: [{ id: 'q', label: 'Q' }, { id: 'q', label: 'R' }] }, 'token')).status, 400);
  assert.equal((await call('POST', `${url}/import`, { nodes: [], edges: [{ source: 'Combat', target: 'Nowhere' }] }, 'token')).status, 400);
  assert.equal((await call('POST', `${url}/import`, { version: before.version, nodes: [] }, 'token')).status, 409);
  assert.equal((await call('GET', url)).body.version, d.version);

  // A dry run reports and changes nothing. "updated" counts real changes: Combat keeps every field it has.
  const dry = await call('POST', `${url}/import`, { mode: 'replace', dryRun: true, nodes: [{ label: 'Combat' }] }, 'token');
  assert.deepEqual(dry.body.nodes, { added: 0, updated: 0, removed: d.nodes.length - 1 });
  assert.deepEqual(dry.body.edges, { added: 0, updated: 0, removed: d.edges.length });
  const relabel = await call('POST', `${url}/import`, { dryRun: true, nodes: [{ label: 'Combat', role: 'Runs battles' }] }, 'token');
  assert.deepEqual(relabel.body.nodes, { added: 0, updated: 1, removed: 0 });
  // Importing the diagram's own export changes nothing.
  const same = await call('POST', `${url}/import`, { dryRun: true, nodes: d.nodes, edges: d.edges }, 'token');
  assert.deepEqual([same.body.nodes, same.body.edges], [{ added: 0, updated: 0, removed: 0 }, { added: 0, updated: 0, removed: 0 }]);
  assert.equal(same.body.settingsChanged, false);
  // Settings count as a change too (the export carries them).
  const turn = d.settings.direction === 'DOWN' ? 'RIGHT' : 'DOWN';
  const turned = await call('POST', `${url}/import`, { dryRun: true, nodes: d.nodes, edges: d.edges, settings: { ...d.settings, direction: turn } }, 'token');
  assert.deepEqual([turned.body.nodes.updated, turned.body.edges.updated, turned.body.settingsChanged], [0, 0, true]);
  assert.equal((await call('POST', `${url}/import`, { dryRun: true, nodes: [], settings: d.settings }, 'token')).body.settingsChanged, false);
  assert.equal((await call('GET', url)).body.version, d.version);

  // Replace with an export: what is listed stays exactly as it is; the rest goes.
  const kept = d.nodes.filter((n: Json) => n.label !== 'Save');
  const replaced = await call(
    'POST',
    `${url}/import`,
    { mode: 'replace', version: d.version, nodes: kept, edges: d.edges.filter((e: Json) => e.target === audio.id) },
    'token',
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(replaced.body.nodes, { added: 0, updated: 0, removed: 1 });
  assert.deepEqual(replaced.body.edges, { added: 0, updated: 0, removed: 2 });
  d = (await call('GET', url)).body;
  assert.deepEqual(d.nodes, kept);

  // An id the diagram doesn't have, on a box matched by label, becomes that box's id; what pointed at it follows.
  const renamed = await call('POST', `${url}/import`, { nodes: [{ id: 'combat', label: 'Combat' }] }, 'token');
  assert.deepEqual(renamed.body.nodes, { added: 0, updated: 1, removed: 0 });
  d = (await call('GET', url)).body;
  assert.equal(find('Combat').id, 'combat');
  assert.equal(find('Utils', 'combat').id, combatUtils.id);
  const arrow = d.edges.find((e: Json) => e.target === audio.id);
  assert.deepEqual([arrow.source, arrow.count], ['combat', 3]);

  // An arrow listed once without a count keeps the count it has.
  await call('POST', `${url}/import`, { nodes: [], edges: [{ source: 'combat', target: 'Audio', label: 'plays' }] }, 'token');
  const relabelled = (await call('GET', url)).body.edges.find((e: Json) => e.target === audio.id);
  assert.deepEqual([relabelled.label, relabelled.count], ['plays', 3]);

  // The limits count the boxes already there.
  const over = await call('POST', `${url}/import`, { nodes: Array.from({ length: 1996 }, (_, i) => ({ label: `Box ${i}` })) }, 'token');
  assert.equal(over.status, 400);
  assert.match(over.body.error, /2000/);
});

test('files: upload, safe content type, move, delete', async () => {
  const folder = (await call('POST', '/api/v1/folders', { name: 'Docs' })).body;
  const boundary = '----pmtest';
  const payload =
    `--${boundary}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${folder.id}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evil.html"\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>\r\n` +
    `--${boundary}--\r\n`;
  const up = await app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { cookie, 'x-pm-client': 'web', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(up.statusCode, 201, up.body);
  const file = JSON.parse(up.body).files[0];
  assert.equal(file.folderId, folder.id);
  const content = await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}/content`, headers: { cookie } });
  assert.equal(content.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(content.body, '<script>alert(1)</script>');
  const moved = await call('PATCH', `/api/v1/files/${file.id}`, { folderId: null, name: 'notes.html' });
  assert.equal(moved.body.folderId, null);
  assert.equal(moved.body.name, 'notes.html');
  const del = await call('DELETE', `/api/v1/files/${file.id}`);
  assert.equal(del.status, 200);
});

test('backups produce a restorable snapshot and prune old ones', async () => {
  for (let i = 0; i < 4; i++) await ctx.backups.run();
  const list = ctx.backups.list();
  assert.equal(list.length, 3);
  assert.ok(list[0].size > 0);
});

test('deleting an epoch keeps its tasks', async () => {
  const folder = (await call('POST', '/api/v1/folders', { name: 'Keep' })).body;
  const epoch = (await call('POST', '/api/v1/epochs', { name: 'Doomed', folderId: folder.id })).body;
  const task = (await call('POST', '/api/v1/tasks', { title: 'Survivor', epochId: epoch.id })).body;
  await call('DELETE', `/api/v1/epochs/${epoch.id}`);
  const t = await call('GET', `/api/v1/tasks/${task.id}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.epochId, null);
  assert.equal(t.body.folderId, folder.id);
});

test('colour coding: task types and kanban columns', async () => {
  const meta = await call('GET', '/api/v1/meta');
  assert.equal(meta.body.typeColors.Bug, '#dc2626');
  assert.equal(meta.body.statuses[1].color, '#2563eb');
  const t = await call('PATCH', '/api/v1/types/Bug', { color: '#ABCDEF' });
  assert.equal(t.status, 200);
  const s = await call('PATCH', '/api/v1/statuses/Alpha QA', { color: '#123456' });
  assert.equal(s.status, 200);
  const bad = await call('PATCH', '/api/v1/statuses/alpha_qa', { color: 'red' });
  assert.equal(bad.status, 400);
  const created = await call('POST', '/api/v1/types', { name: 'Design', color: '#00ff00' });
  assert.equal(created.status, 201);
  const after = await call('GET', '/api/v1/meta');
  assert.equal(after.body.typeColors.Bug, '#abcdef');
  assert.equal(after.body.typeColors.Design, '#00ff00');
  assert.equal(after.body.statuses.find((x: Json) => x.id === 'alpha_qa').color, '#123456');
});

test('markdown documents: create, edit, attachments folder for pasted images', async () => {
  const doc = await call('POST', '/api/v1/docs', { name: 'Design notes', content: '# Hello' });
  assert.equal(doc.status, 201);
  assert.equal(doc.body.name, 'Design notes.md');
  const edited = await call('PUT', `/api/v1/files/${doc.body.id}/content`, { content: '# Hello\n\n![img](/api/v1/files/1/content)' });
  assert.equal(edited.status, 200);
  const content = await app.inject({ method: 'GET', url: `/api/v1/files/${doc.body.id}/content`, headers: { cookie } });
  assert.match(content.body, /!\[img\]/);
  const badDoc = await call('POST', '/api/v1/docs', { name: 'evil.exe' });
  assert.equal(badDoc.status, 400);

  const boundary = '----pmimg';
  const payload =
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nattachment\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n` +
    `--${boundary}--\r\n`;
  const up = await app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { cookie, 'x-pm-client': 'web', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(up.statusCode, 201, up.body);
  const file = JSON.parse(up.body).files[0];
  const folders = (await call('GET', '/api/v1/folders')).body.folders;
  const att = folders.find((f: Json) => f.name === 'Attachments' && f.parentId === null);
  assert.ok(att);
  assert.equal(file.folderId, att.id);
  const img = await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}/content`, headers: { cookie } });
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['content-disposition']?.toString().startsWith('inline'), true);
  // binary files cannot be edited as text
  const notText = await call('PUT', `/api/v1/files/${file.id}/content`, { content: 'x' });
  assert.equal(notText.status, 400);
});

test('serves the web UI: root, SPA routes, hashed assets and 404s', async () => {
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const web = await buildApp(
    { port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'web-data'), webDist: dist, backupIntervalHours: 0, backupKeep: 3, maxUploadMb: 5 },
    { dbFile: ':memory:' },
  );
  try {
    for (const url of ['/', '/board', '/epochs?task=3']) {
      const r = await web.app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, url);
      assert.match(r.headers['content-type'] as string, /text\/html/, url);
      assert.equal(r.headers['cache-control'], 'no-cache', url);
      assert.ok(r.headers['content-security-policy'], url);
    }
    const asset = await web.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['cache-control'] as string, /immutable/);
    assert.equal((await web.app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode, 404);
    assert.equal((await web.app.inject({ method: 'GET', url: '/api/v1/nope' })).statusCode, 404);
    assert.equal((await web.app.inject({ method: 'POST', url: '/board' })).statusCode, 404);
  } finally {
    await web.app.close();
  }
});

test('auth cannot be bypassed with encoded or absolute-form URLs', async () => {
  for (const url of ['/%61pi/v1/tasks', '/%61pi/v1/files/1/content', '/api/v1/%74asks', '/%61pi/v1/backups', 'http://evil/api/v1/tasks']) {
    const r = await app.inject({ method: 'GET', url });
    assert.ok([401, 404].includes(r.statusCode), `${url} -> ${r.statusCode}`);
  }
  // Public routes stay public, protected ones stay protected.
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/status' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/events' })).statusCode, 401);
});

test('review fixes: durations, unique actor names, epoch time, types, ids, timers, atomic updates, mime', async () => {
  // Durations: long unit names are not cut short by the single-letter ones.
  const t1 = (await call('POST', '/api/v1/tasks', { title: 'Durations', estimate: '45 min' })).body;
  assert.equal(t1.estimateMinutes, 45);
  assert.equal((await call('PATCH', `/api/v1/tasks/${t1.id}`, { estimate: '2 hours' })).body.estimateMinutes, 120);
  assert.equal((await call('PATCH', `/api/v1/tasks/${t1.id}`, { estimate: '1hr' })).body.estimateMinutes, 60);

  // Token names are actors: they may not repeat or shadow a username.
  assert.equal((await call('POST', '/api/v1/tokens', { name: 'claude' })).status, 409);
  assert.equal((await call('POST', '/api/v1/tokens', { name: 'ALICE' })).status, 409);

  // Deleting an epoch with time logged directly on it needs explicit confirmation.
  const ep = (await call('POST', '/api/v1/epochs', { name: 'Timed epoch' })).body;
  await call('POST', '/api/v1/time', { epochId: ep.id, duration: '2h' });
  const refused = await call('DELETE', `/api/v1/epochs/${ep.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /deleteTime=true/);
  assert.equal((await call('DELETE', `/api/v1/epochs/${ep.id}?deleteTime=true`)).status, 200);

  // Type delete: case-insensitive name still sees tasks using it; the last type can't go.
  await call('POST', '/api/v1/types', { name: 'Spike', color: '#123123' });
  await call('POST', '/api/v1/tasks', { title: 'Uses spike', type: 'Spike' });
  assert.equal((await call('DELETE', '/api/v1/types/spike')).status, 409);

  // Zero/negative ids are a 400, not a 500.
  assert.equal((await call('POST', '/api/v1/tasks', { title: 'Bad', epochId: 0 })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/tasks/${t1.id}`, { folderId: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/v1/diagrams/1', { nodes: [null], edges: [] })).status, 400);

  // A running timer's start can't be moved; totals never go negative.
  const run = (await call('POST', '/api/v1/time/start', { taskId: t1.id })).body;
  assert.equal((await call('PATCH', `/api/v1/time/${run.id}`, { date: '2099-01-01T00:00' })).status, 400);
  await call('POST', '/api/v1/time/stop', {});

  // Date-only entries land on that local day (noon), not UTC midnight (the previous evening west of UTC).
  const dated = (await call('POST', '/api/v1/time', { taskId: t1.id, minutes: 5, date: '2026-03-10' })).body;
  const local = new Date(dated.startedAt);
  assert.deepEqual([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours()], [2026, 2, 10, 12]);
  const inRange = await call('GET', '/api/v1/time?from=2026-03-10&to=2026-03-10');
  assert.ok(inRange.body.entries.some((e: Json) => e.id === dated.id), '"to" includes the whole day');
  assert.equal((await call('POST', '/api/v1/time', { taskId: t1.id, minutes: 5, date: '2026-02-31' })).status, 400);

  // Folder PATCH is all-or-nothing: a rejected move doesn't keep the rename.
  const parent = (await call('POST', '/api/v1/folders', { name: 'Parent' })).body;
  const child = (await call('POST', '/api/v1/folders', { name: 'Child', parentId: parent.id })).body;
  assert.equal((await call('PATCH', `/api/v1/folders/${parent.id}`, { name: 'Renamed', parentId: child.id })).status, 400);
  const tree = (await call('GET', '/api/v1/folders')).body.folders as Json[];
  assert.equal(tree.find((f) => f.id === parent.id)?.name, 'Parent');

  // Uploads without a MIME type (curl, the CLI) get one from the extension, so images preview inline.
  const boundary = '----pmmime';
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { cookie, 'x-pm-client': 'web', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(up.statusCode, 201);
  const file = JSON.parse(up.body).files[0];
  assert.equal(file.mime, 'image/png');
  const content = await app.inject({ method: 'GET', url: `/api/v1/files/${file.id}/content`, headers: { cookie } });
  assert.equal(content.headers['content-type'], 'image/png');
  assert.match(String(content.headers['content-disposition']), /^inline/);
  assert.ok(!fs.readdirSync(path.join(tmp, 'files')).some((f) => f.endsWith('.part')), 'no temp files left behind');
});

test('live events carry the originating tab id; summary lists omit descriptions', async () => {
  const seen: Json[] = [];
  const unsubscribe = ctx.bus.subscribe((e) => seen.push(e));
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { cookie, 'x-pm-client': 'web', 'x-pm-client-id': 'tab-abc12345' },
      payload: { title: 'Origin check', description: 'long markdown' },
    });
    assert.equal(res.statusCode, 201);
    assert.ok(seen.some((e) => e.kind === 'tasks' && e.origin === 'tab-abc12345'), JSON.stringify(seen));
    seen.length = 0;
    await call('POST', '/api/v1/tasks', { title: 'No origin' });
    assert.ok(seen.length && seen.every((e) => e.origin === undefined));
  } finally {
    unsubscribe();
  }
  const full = await call('GET', '/api/v1/tasks?q=Origin%20check');
  assert.equal(full.body.tasks[0].description, 'long markdown');
  const summary = await call('GET', '/api/v1/tasks?q=Origin%20check&summary=1');
  assert.equal(summary.body.tasks[0].description, undefined);
});

test('task keys are never reused after the newest task is deleted', async () => {
  const a = (await call('POST', '/api/v1/tasks', { title: 'Newest task' })).body;
  assert.equal((await call('DELETE', `/api/v1/tasks/${a.id}`)).status, 200);
  const b = (await call('POST', '/api/v1/tasks', { title: 'Next task' })).body;
  assert.ok(b.id > a.id && b.number > a.number, `expected a fresh key after ${a.key}, got ${b.key}`);
  assert.equal(b.key, `T-${b.number}`);
});

test('task links: kinds, both directions, blockers, conflicts, removal and cascade', async () => {
  const mk = async (title: string) => (await call('POST', '/api/v1/tasks', { title })).body;
  const [a, b, c] = [await mk('Link A'), await mk('Link B'), await mk('Link C')];
  const get = async (t: Json) => (await call('GET', `/api/v1/tasks/${t.id}`)).body;
  const listed = async (t: Json) =>
    (await call('GET', `/api/v1/tasks?q=${t.key}`)).body.tasks.find((x: { id: number }) => x.id === t.id);

  // A blocks B: each side reads it its own way, and B shows an open blocker.
  const r1 = await call('POST', `/api/v1/tasks/${a.key}/links`, { task: b.key, kind: 'blocks' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.deepEqual(r1.body.links.map((l: { label: string; task: { key: string } }) => [l.label, l.task.key]), [['blocks', b.key]]);
  assert.equal((await get(b)).links[0].label, 'blocked by');
  assert.equal((await listed(b)).openBlockers, 1);
  assert.equal((await listed(a)).openBlockers, 0);

  // One link per pair, whichever direction or kind; no self links; unknown kinds rejected.
  assert.equal((await call('POST', `/api/v1/tasks/${b.id}/links`, { task: a.id, kind: 'relates' })).status, 409);
  assert.equal((await call('POST', `/api/v1/tasks/${a.id}/links`, { task: a.id })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${a.id}/links`, { task: c.id, kind: 'parent of' })).status, 400);
  assert.equal((await call('POST', `/api/v1/tasks/${a.id}/links`, { task: 99999 })).status, 404);

  // "blocked by" from C's side is stored as A blocks C; "relates to" defaults and reads the same both ways.
  await call('POST', `/api/v1/tasks/${c.id}/links`, { task: a.key, kind: 'Blocked by' });
  assert.ok((await get(a)).links.some((l: { label: string; task: { id: number } }) => l.label === 'blocks' && l.task.id === c.id));
  await call('POST', `/api/v1/tasks/${c.id}/links`, { task: b.id });
  assert.ok((await get(b)).links.some((l: { label: string; task: { id: number } }) => l.label === 'relates to' && l.task.id === c.id));
  assert.ok((await get(c)).links.some((l: { label: string; task: { id: number } }) => l.label === 'relates to' && l.task.id === b.id));

  // A blocker stops counting once it reaches Alpha Complete.
  await call('POST', `/api/v1/tasks/${a.id}/status`, { status: 'Alpha Complete' });
  assert.equal((await listed(b)).openBlockers, 0);

  // Remove by naming the other task, from either side.
  const del = await call('DELETE', `/api/v1/tasks/${b.key}/links/${a.key}`);
  assert.equal(del.status, 200);
  assert.ok(!del.body.links.some((l: { task: { id: number } }) => l.task.id === a.id));
  assert.equal((await call('DELETE', `/api/v1/tasks/${b.id}/links/${a.id}`)).status, 404);

  // Deleting a task drops its links and leaves a note on the tasks it was linked to.
  await call('DELETE', `/api/v1/tasks/${c.id}`);
  const after = await get(a);
  assert.equal(after.links.length, 0);
  assert.ok(after.activity.some((x: { message: string }) => x.message.includes(`${c.key} "Link C" was deleted`)));
});

test('a task can have several blockers and other links at once', async () => {
  const mk = async (title: string) => (await call('POST', '/api/v1/tasks', { title })).body;
  const [target, b1, b2, rel] = [await mk('Boss fight'), await mk('Boss art'), await mk('Boss AI'), await mk('Boss music')];
  for (const b of [b1, b2]) assert.equal((await call('POST', `/api/v1/tasks/${target.id}/links`, { task: b.id, kind: 'blocked by' })).status, 201);
  assert.equal((await call('POST', `/api/v1/tasks/${target.id}/links`, { task: rel.id })).status, 201);
  const detail = (await call('GET', `/api/v1/tasks/${target.id}`)).body;
  assert.deepEqual(detail.links.map((l: Json) => l.label).sort(), ['blocked by', 'blocked by', 'relates to']);
  assert.equal(detail.openBlockers, 2);
  // Each blocker clears independently.
  await call('POST', `/api/v1/tasks/${b1.id}/status`, { status: 'Alpha Complete' });
  assert.equal((await call('GET', `/api/v1/tasks/${target.id}`)).body.openBlockers, 1);
});

test('sub-tasks: own epochs, progress, filters, one level in one project, changing the parent', async () => {
  const sprint = (await call('POST', '/api/v1/epochs', { name: 'Card Sprint' })).body;
  const vfx = (await call('POST', '/api/v1/epochs', { name: 'VFX' })).body;
  const parent = (await call('POST', '/api/v1/tasks', { title: 'Card Creation', epochId: sprint.id })).body;
  assert.equal(parent.parent, null);
  assert.deepEqual(parent.subtasks, { done: 0, total: 0 });
  assert.deepEqual(parent.children, []);

  // By key with a token, in an epoch of its own; by id; and an existing task moved under it.
  const fx = await call('POST', '/api/v1/tasks', { title: 'Card VFX', parent: parent.key, epochId: vfx.id }, 'token');
  assert.equal(fx.status, 201, JSON.stringify(fx.body));
  assert.deepEqual(fx.body.parent, { id: parent.id, key: parent.key, title: 'Card Creation' });
  assert.equal(fx.body.epochId, vfx.id);
  assert.ok(fx.body.activity.some((a: Json) => a.message === `Created in Open as a sub-task of ${parent.key}`));
  const sfx = (await call('POST', '/api/v1/tasks', { title: 'Card SFX', parent: parent.id })).body;
  const art = (await call('POST', '/api/v1/tasks', { title: 'Card art' })).body;
  const made = await call('PATCH', `/api/v1/tasks/${art.key}`, { parent: parent.key });
  assert.equal(made.status, 200);
  assert.equal(made.body.parentId, parent.id);
  assert.ok(made.body.activity.some((a: Json) => a.message === `made a sub-task of ${parent.key}`));

  // Progress counts Alpha Complete and later as done; the parent lists its sub-tasks in the order they were made.
  await call('POST', `/api/v1/tasks/${fx.body.id}/status`, { status: 'Alpha Complete' });
  await call('POST', `/api/v1/tasks/${sfx.id}/status`, { status: 'Alpha QA' });
  const detail = (await call('GET', `/api/v1/tasks/${parent.key}`)).body;
  assert.deepEqual(detail.subtasks, { done: 1, total: 3 });
  assert.deepEqual(detail.children.map((c: Json) => c.key), [fx.body.key, sfx.key, art.key]);
  assert.equal(detail.children[1].statusLabel, 'Alpha QA');
  assert.equal(detail.children[0].description, undefined);
  assert.equal(detail.epochId, sprint.id);
  assert.ok(detail.activity.some((a: Json) => a.kind === 'subtask' && a.message === `Added sub-task ${art.key} "Card art"`));

  // Filters: a parent's sub-tasks, top-level tasks only, sub-tasks only.
  const ids = async (q: string) => (await call('GET', `/api/v1/tasks?${q}`)).body.tasks.map((t: Json) => t.id) as number[];
  assert.deepEqual((await ids(`parent=${parent.key}`)).sort(), [fx.body.id, sfx.id, art.id].sort());
  const top = await ids('parent=none');
  assert.ok(top.includes(parent.id) && !top.includes(sfx.id));
  const subs = await ids('parent=any');
  assert.ok(subs.includes(sfx.id) && !subs.includes(parent.id));
  assert.equal((await call('GET', '/api/v1/tasks?parent=T-99999')).status, 404);

  // One level only, never itself; unknown parents are 404.
  const deep = await call('POST', '/api/v1/tasks', { title: 'Too deep', parent: fx.body.key });
  assert.equal(deep.status, 400);
  assert.match(deep.body.error, /can't have sub-tasks of their own/);
  const other = (await call('POST', '/api/v1/tasks', { title: 'Other parent' })).body;
  const busy = await call('PATCH', `/api/v1/tasks/${parent.id}`, { parent: other.key });
  assert.equal(busy.status, 400);
  assert.match(busy.body.error, /has sub-tasks of its own/);
  assert.equal((await call('PATCH', `/api/v1/tasks/${other.id}`, { parent: other.id })).status, 400);
  assert.equal((await call('POST', '/api/v1/tasks', { title: 'x', parent: 'T-99999' })).status, 404);
  // A parentId in the body is not how the API takes a parent: it is ignored.
  const plain = (await call('POST', '/api/v1/tasks', { title: 'Plain', parentId: parent.id })).body;
  assert.equal(plain.parentId, null);

  // Moving to another parent and detaching leave notes on both parents.
  const moved = await call('PATCH', `/api/v1/tasks/${art.id}`, { parent: other.id, title: 'Card art v2' });
  assert.ok(moved.body.activity.some((a: Json) => a.message.includes(`moved from ${parent.key} to ${other.key}`)));
  const was = (await call('GET', `/api/v1/tasks/${parent.id}`)).body;
  assert.ok(was.activity.some((a: Json) => a.message === `Removed sub-task ${art.key} "Card art v2"`));
  assert.equal(was.subtasks.total, 2);
  const freed = await call('PATCH', `/api/v1/tasks/${art.id}`, { parent: 'none' });
  assert.equal(freed.body.parentId, null);
  assert.ok(freed.body.activity.some((a: Json) => a.message === `detached from ${other.key}`));
  assert.equal((await call('PATCH', `/api/v1/tasks/${art.id}`, { parent: null })).status, 200);

  // A task in another of your projects can't be a parent.
  const side = (await call('POST', '/api/v1/projects', { key: 'SIDE', name: 'Side project' })).body;
  const sideTask = (await call('POST', '/api/v1/tasks?project=SIDE', { title: 'Elsewhere' })).body;
  const cross = await call('PATCH', `/api/v1/tasks/${art.id}`, { parent: sideTask.key });
  assert.equal(cross.status, 400);
  assert.match(cross.body.error, /same project/);
  assert.equal((await call('DELETE', `/api/v1/projects/${side.id}?confirm=SIDE`)).status, 200);
});

test('sub-tasks: deleting a parent keeps its sub-tasks unless asked, and leaves notes on what stays', async () => {
  const mk = async (title: string, parent?: string) => (await call('POST', '/api/v1/tasks', { title, parent })).body;
  const boss = await mk('Boss fight');
  const [bArt, bAi] = [await mk('Boss art', boss.key), await mk('Boss AI', boss.key)];
  // Deleting a sub-task on its own: the parent gets a note and one fewer sub-task.
  await call('DELETE', `/api/v1/tasks/${bAi.key}`);
  const after = (await call('GET', `/api/v1/tasks/${boss.id}`)).body;
  assert.equal(after.subtasks.total, 1);
  assert.ok(after.activity.some((a: Json) => a.message === `Removed sub-task: ${bAi.key} "Boss AI" was deleted`));
  // By default the sub-tasks stay, as top-level tasks.
  const del = await call('DELETE', `/api/v1/tasks/${boss.key}`);
  assert.deepEqual(del.body, { ok: true, deleted: 1 });
  const orphan = (await call('GET', `/api/v1/tasks/${bArt.id}`)).body;
  assert.equal(orphan.parentId, null);
  assert.ok(orphan.activity.some((a: Json) => a.message === `Parent ${boss.key} "Boss fight" was deleted, so this is now a top-level task`));

  // ?withSubtasks=true deletes them too; links to tasks outside get a note, links inside the set don't matter.
  const level = await mk('Level 3');
  const [lArt, lMusic] = [await mk('Level art', level.key), await mk('Level music', level.key)];
  const outside = await mk('Audio pass');
  await call('POST', `/api/v1/tasks/${lMusic.id}/links`, { task: outside.id, kind: 'blocks' });
  await call('POST', `/api/v1/tasks/${lArt.id}/links`, { task: lMusic.id });
  const all = await call('DELETE', `/api/v1/tasks/${level.key}?withSubtasks=true`);
  assert.deepEqual(all.body, { ok: true, deleted: 3 });
  for (const t of [level, lArt, lMusic]) assert.equal((await call('GET', `/api/v1/tasks/${t.id}`)).status, 404);
  const o = (await call('GET', `/api/v1/tasks/${outside.id}`)).body;
  assert.equal(o.openBlockers, 0);
  assert.ok(o.activity.some((a: Json) => a.message === `Removed link: ${lMusic.key} "Level music" was deleted`));
});

test('templates: save fields or a task, unique names, limits, changes and deletes', async () => {
  const card = await call(
    'POST',
    '/api/v1/templates',
    {
      name: 'Card',
      title: 'Card: {title}',
      description: 'Make the {title} card.',
      type: 'Feature',
      priority: 'High',
      categories: ['Combat', ' Combat ', ''],
      estimate: '1h30m',
      checklist: ['Stats for {title}', ' ', 'Playtest'],
      subtasks: [
        { title: 'Art: {title}', epoch: 'Template art', estimate: '2h' },
        { title: 'SFX: {title}', type: 'Polish', categories: ['Missing'] },
      ],
    },
    'token',
  );
  assert.equal(card.status, 201, JSON.stringify(card.body));
  assert.equal(card.body.name, 'Card');
  assert.equal(card.body.priority, 'high');
  assert.deepEqual(card.body.categories, ['Combat']);
  assert.equal(card.body.estimateMinutes, 90);
  assert.deepEqual(card.body.checklist, ['Stats for {title}', 'Playtest']);
  assert.deepEqual(card.body.subtasks.map((s: Json) => [s.title, s.epoch, s.estimateMinutes]), [
    ['Art: {title}', 'Template art', 120],
    ['SFX: {title}', null, null],
  ]);
  assert.equal(card.body.createdBy, 'claude');

  // Names are unique per project (ignoring case) and need a letter; values are checked.
  assert.equal((await call('POST', '/api/v1/templates', { name: 'card' })).status, 409);
  assert.equal((await call('POST', '/api/v1/templates', { name: '42' })).status, 400, 'a bare number means a template id');
  assert.equal((await call('POST', '/api/v1/templates', { name: 'Bad', priority: 'urgent' })).status, 400);
  assert.equal((await call('POST', '/api/v1/templates', { name: 'Bad', subtasks: [{ epoch: 'x' }] })).status, 400, 'sub-tasks need a title');
  const many = Array.from({ length: 51 }, (_, i) => ({ title: `Step ${i}` }));
  assert.equal((await call('POST', '/api/v1/templates', { name: 'Bad', subtasks: many })).status, 400);
  const huge = await call('POST', '/api/v1/templates', {
    name: 'Bad',
    description: 'x'.repeat(90_000),
    subtasks: [{ title: 'a', description: 'y'.repeat(90_000) }, { title: 'b', description: 'z'.repeat(90_000) }],
  });
  assert.equal(huge.status, 400);
  assert.match(huge.body.error, /too big/);

  // Found by id or by name, in any case.
  assert.deepEqual((await call('GET', '/api/v1/templates')).body.templates.map((t: Json) => t.name), ['Card']);
  assert.equal((await call('GET', `/api/v1/templates/${card.body.id}`)).body.name, 'Card');
  assert.equal((await call('GET', '/api/v1/templates/CARD')).body.id, card.body.id);
  assert.equal((await call('GET', '/api/v1/templates/Nope')).status, 404);

  // Saving a task: its fields and, when asked, its sub-tasks. Fields sent along override what it copies.
  const art = (await call('POST', '/api/v1/epochs', { name: 'Template art' })).body;
  const boss = (await call('POST', '/api/v1/tasks', { title: 'Boss: Golem', estimate: '3h', checklist: ['Design', 'Build'], epochId: art.id })).body;
  await call('PATCH', `/api/v1/checklist/${boss.checklistItems[0].id}`, { done: true });
  await call('POST', '/api/v1/tasks', { title: 'Golem art', parent: boss.key, categories: ['Trinket'] });
  const snap = await call('POST', '/api/v1/templates', { name: 'Boss', fromTask: boss.key, includeSubtasks: true, title: 'Boss: {title}' });
  assert.equal(snap.status, 201, JSON.stringify(snap.body));
  assert.equal(snap.body.title, 'Boss: {title}');
  assert.equal(snap.body.epoch, 'Template art');
  assert.equal(snap.body.estimateMinutes, 180);
  assert.deepEqual(snap.body.checklist, ['Design', 'Build']);
  assert.deepEqual(snap.body.subtasks.map((s: Json) => [s.title, s.categories]), [['Golem art', ['Trinket']]]);
  const flat = (await call('POST', '/api/v1/templates', { name: 'Boss only', fromTask: boss.id })).body;
  assert.equal(flat.title, 'Boss: Golem');
  assert.deepEqual(flat.subtasks, []);
  assert.equal((await call('POST', '/api/v1/templates', { name: 'Ghost', fromTask: 'T-99999' })).status, 404);
  // A saved task keeps to the same limits as fields sent one by one.
  const long = (await call('POST', '/api/v1/tasks', { title: 'Long list', checklist: Array.from({ length: 101 }, (_, i) => `Step ${i}`) })).body;
  const tooLong = await call('POST', '/api/v1/templates', { name: 'Long', fromTask: long.key });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /101 checklist items/);
  assert.equal((await call('DELETE', `/api/v1/tasks/${long.key}`)).status, 200);

  // Changing: fields not sent stay; sub-tasks, when sent, replace the list; renaming checks for clashes.
  const changed = await call('PATCH', '/api/v1/templates/Boss only', { name: 'Golem', priority: null, subtasks: [{ title: 'Rig' }] });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.name, 'Golem');
  assert.equal(changed.body.priority, null);
  assert.equal(changed.body.title, 'Boss: Golem');
  assert.deepEqual(changed.body.subtasks.map((s: Json) => s.title), ['Rig']);
  assert.equal((await call('PATCH', '/api/v1/templates/Golem', { name: 'BOSS' })).status, 409);
  assert.equal((await call('PATCH', '/api/v1/templates/Golem', { name: 'golem' })).status, 200, 'a new case of its own name is fine');
  // SQLite's NOCASE folds only A-Z, so "Äpfel" and "äpfel" are two names: renaming one to the other is a clash.
  const upper = await call('POST', '/api/v1/templates', { name: 'Äpfel' });
  const lower = await call('POST', '/api/v1/templates', { name: 'äpfel' });
  assert.deepEqual([upper.status, lower.status], [201, 201]);
  assert.equal((await call('PATCH', `/api/v1/templates/${upper.body.id}`, { name: 'äpfel' })).status, 409);
  for (const t of [upper, lower]) assert.equal((await call('DELETE', `/api/v1/templates/${t.body.id}`)).status, 200);
  assert.equal((await call('PATCH', '/api/v1/templates/Golem', { fromTask: boss.key })).status, 400);
  assert.equal((await call('DELETE', '/api/v1/templates/Golem')).status, 200);
  assert.equal((await call('GET', '/api/v1/templates/Golem')).status, 404);
});

test('templates: tasks made from one fill in {title}, take overrides, place sub-tasks and warn about missing names', async () => {
  const art = (await call('GET', '/api/v1/epochs')).body.epochs.find((e: Json) => e.name === 'Template art');
  const made = await call('POST', '/api/v1/tasks', { template: 'Card', title: 'Fireball' }, 'token');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const t = made.body;
  assert.equal(t.title, 'Card: Fireball');
  assert.equal(t.description, 'Make the Fireball card.');
  assert.equal(t.type, 'Feature');
  assert.equal(t.priority, 'high');
  assert.equal(t.estimateMinutes, 90);
  assert.deepEqual(t.categories.map((c: Json) => c.name), ['Combat']);
  assert.deepEqual(t.checklistItems.map((c: Json) => [c.text, c.done]), [['Stats for Fireball', false], ['Playtest', false]]);
  assert.equal(t.epochId, null);
  assert.deepEqual(t.subtasks, { done: 0, total: 2 });
  assert.deepEqual(t.children.map((c: Json) => c.title), ['Art: Fireball', 'SFX: Fireball']);
  assert.equal(t.children[0].epochId, art.id, 'a sub-task goes to the epoch its template names');
  assert.equal(t.children[0].estimateMinutes, 120);
  assert.equal(t.children[1].type, 'Feature', 'an unknown type falls back to the default');
  assert.deepEqual(t.children[1].categories, []);
  assert.equal(t.warnings.length, 2, JSON.stringify(t.warnings));
  assert.match(t.warnings[0], /^Sub-task "SFX: Fireball": there is no type "Polish"/);
  assert.match(t.warnings[1], /left out the category "Missing"/);
  assert.equal(t.activity.at(-1).message, 'Created in Open from the template "Card" with 2 sub-tasks');
  assert.ok(!t.activity.some((a: Json) => a.kind === 'subtask'), 'one entry on the parent, not one per sub-task');
  const sub = (await call('GET', `/api/v1/tasks/${t.children[0].id}`)).body;
  assert.equal(sub.activity.at(-1).message, `Created in Open from the template "Card" as a sub-task of ${t.key}`);
  assert.equal(sub.createdBy, 'claude');

  // Fields in the request win; sub-tasks still start in the first status, where the parent is unless named.
  const sprint = (await call('POST', '/api/v1/epochs', { name: 'Template sprint' })).body;
  const over = await call('POST', '/api/v1/tasks', {
    template: (await call('GET', '/api/v1/templates/Card')).body.id,
    title: 'Ice wall',
    priority: 'low',
    categories: [],
    checklist: ['Only this'],
    epochId: sprint.id,
    estimate: null,
    status: 'In Progress',
    description: 'Mine',
  });
  assert.equal(over.status, 201, JSON.stringify(over.body));
  assert.equal(over.body.title, 'Card: Ice wall');
  assert.equal(over.body.priority, 'low');
  assert.deepEqual(over.body.categories, []);
  assert.deepEqual(over.body.checklistItems.map((c: Json) => c.text), ['Only this']);
  assert.equal(over.body.epochId, sprint.id);
  assert.equal(over.body.estimateMinutes, null);
  assert.equal(over.body.status, 'in_progress');
  assert.equal(over.body.description, 'Mine');
  assert.deepEqual(over.body.children.map((c: Json) => [c.status, c.epochId]), [['open', art.id], ['open', sprint.id]]);
  const dollar = (await call('POST', '/api/v1/tasks', { template: 'Card', title: 'Costs $& and $1' })).body;
  assert.equal(dollar.title, 'Card: Costs $& and $1');

  // A title is needed when the template's has {title}; otherwise a title sent replaces it.
  const untitled = await call('POST', '/api/v1/tasks', { template: 'Card' });
  assert.equal(untitled.status, 400);
  assert.match(untitled.body.error, /needs a title/);
  assert.equal((await call('POST', '/api/v1/tasks', {})).status, 400, 'still needed without a template');
  const boss = (await call('POST', '/api/v1/tasks', { template: 'Boss', title: 'Hydra' })).body;
  assert.equal(boss.title, 'Boss: Hydra');
  assert.equal(boss.epochId, art.id, "the template's own epoch, found by name");
  assert.deepEqual(boss.checklistItems.map((c: Json) => c.done), [false, false]);
  await call('POST', '/api/v1/templates', { name: 'Fixed', title: 'Weekly build' });
  assert.equal((await call('POST', '/api/v1/tasks', { template: 'Fixed' })).body.title, 'Weekly build');
  assert.equal((await call('POST', '/api/v1/tasks', { template: 'fixed', title: 'Hotfix build' })).body.title, 'Hotfix build');

  // Epoch names that are missing or shared are reported; a template with sub-tasks can't make a sub-task.
  await call('POST', '/api/v1/templates', { name: 'Lost', epoch: 'Gone' });
  const lost = (await call('POST', '/api/v1/tasks', { template: 'Lost', title: 'Where' })).body;
  assert.equal(lost.epochId, null);
  assert.match(lost.warnings[0], /no epoch named "Gone" in this project, so it went to the Inbox/);
  const dup1 = (await call('POST', '/api/v1/epochs', { name: 'Twin' })).body;
  await call('POST', '/api/v1/epochs', { name: 'twin' });
  await call('POST', '/api/v1/templates', { name: 'Twins', epoch: 'TWIN' });
  const twin = (await call('POST', '/api/v1/tasks', { template: 'Twins', title: 'Which' })).body;
  assert.equal(twin.epochId, dup1.id);
  assert.match(twin.warnings[0], /several epochs are named "TWIN"; it went to the first one/);
  const asSub = await call('POST', '/api/v1/tasks', { template: 'Card', title: 'Nested', parent: t.key });
  assert.equal(asSub.status, 400);
  assert.match(asSub.body.error, /has sub-tasks/);
  const leaf = await call('POST', '/api/v1/tasks', { template: 'Lost', title: 'Leaf', parent: t.key });
  assert.equal(leaf.status, 201);
  assert.equal(leaf.body.parentId, t.id);
  assert.equal((await call('POST', '/api/v1/tasks', { template: 'Nope', title: 'x' })).status, 404);

  // New projects copying this one get its templates; names are looked up again there.
  const tId = (await call('GET', '/api/v1/projects')).body.projects.find((p: Json) => p.key === 'T').id;
  const copy = (await call('POST', '/api/v1/projects', { key: 'TPL', name: 'Copied', copyFrom: tId })).body;
  const copied = (await call('GET', '/api/v1/templates?project=TPL')).body.templates;
  assert.deepEqual(copied.map((x: Json) => x.name), ['Boss', 'Card', 'Fixed', 'Lost', 'Twins']);
  const there = (await call('POST', '/api/v1/tasks?project=TPL', { template: 'Card', title: 'Elsewhere' })).body;
  assert.equal(there.key, 'TPL-1');
  assert.ok(there.warnings.some((w: string) => /no epoch named "Template art"/.test(w)));
  assert.equal((await call('DELETE', `/api/v1/projects/${copy.id}?confirm=TPL`)).status, 200);
});

test('bulk: update, move, categories and delete several tasks at once, all or nothing', async () => {
  const bulk = (body: unknown, auth: 'session' | 'token' = 'session') => call('POST', '/api/v1/tasks/bulk', body, auth);
  const mk = async (title: string, extra: Json = {}) => (await call('POST', '/api/v1/tasks', { title, ...extra })).body;
  const get = async (id: number) => (await call('GET', `/api/v1/tasks/${id}`)).body;
  const order = async (status: string) =>
    (await call('GET', `/api/v1/tasks?status=${status}`)).body.tasks.map((t: Json) => t.title).filter((t: string) => t.startsWith('Bulk '));
  const epoch = (await call('POST', '/api/v1/epochs', { name: 'Bulk epoch' })).body;
  const a = await mk('Bulk A', { categories: ['Trinket'] });
  const b = await mk('Bulk B');
  const c = await mk('Bulk C', { status: 'In Progress' });

  // Keys and ids mix, a task named twice counts once, and each task gets its own activity entry.
  const up = await bulk({ action: 'update', ids: [a.key, b.id, c.id, a.id], set: { priority: 'high', epochId: epoch.id, estimate: '2h' } }, 'token');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual(up.body.tasks.map((t: Json) => t.key), [a.key, b.key, c.key]);
  for (const t of up.body.tasks) assert.deepEqual([t.priority, t.epochId, t.estimateMinutes], ['high', epoch.id, 120]);
  for (const t of [a, b, c]) {
    const last = (await get(t.id)).activity[0];
    assert.equal(last.actor, 'claude');
    assert.equal(last.message, 'priority medium → high; estimate 120m; moved to epoch "Bulk epoch"');
  }
  // A status sent this way goes to the end of the column, with the note on each task.
  const st = await bulk({ action: 'update', ids: [a.id, b.id], set: { status: 'Alpha QA', note: 'Batch done' } });
  assert.equal(st.status, 200);
  assert.equal((await get(b.id)).activity[0].message, 'Open → Alpha QA: Batch done');

  // All or nothing: the second task can't become a sub-task, so the first one doesn't either.
  const parent = await mk('Bulk parent');
  const kid = await mk('Bulk kid', { parent: parent.key });
  const bad = await bulk({ action: 'update', ids: [a.id, parent.id], set: { parent: b.key } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /has sub-tasks of its own/);
  assert.equal((await get(a.id)).parentId, null, 'the first change was rolled back');
  // A task that doesn't exist fails the request before anything changes.
  assert.equal((await bulk({ action: 'update', ids: [a.id, 999999], set: { priority: 'low' } })).status, 404);
  assert.equal((await get(a.id)).priority, 'high');

  // Sub-tasks of one parent, then top-level again.
  const sub = await bulk({ action: 'update', ids: [a.key, b.key], set: { parent: c.key } });
  assert.deepEqual(sub.body.tasks.map((t: Json) => t.parentId), [c.id, c.id]);
  assert.deepEqual((await get(c.id)).subtasks, { total: 2, done: 0 });
  const top = await bulk({ action: 'update', ids: [a.key, b.key], set: { parent: null } });
  assert.deepEqual(top.body.tasks.map((t: Json) => t.parentId), [null, null]);

  // A task's own fields, an empty change, an unknown action and too many or no tasks are refused.
  const own = await bulk({ action: 'update', ids: [a.id], set: { title: 'Same for all', priority: 'low' } });
  assert.equal(own.status, 400);
  assert.match(own.body.error, /^title can't be changed on several tasks at once/);
  assert.equal((await bulk({ action: 'update', ids: [a.id], set: {} })).status, 400);
  assert.equal((await bulk({ action: 'update', ids: [a.id] })).status, 400);
  assert.equal((await bulk({ action: 'archive', ids: [a.id] })).status, 400);
  assert.equal((await bulk({ action: 'update', ids: [], set: { priority: 'low' } })).status, 400);
  assert.equal((await bulk({ action: 'delete', ids: Array.from({ length: 501 }, (_, i) => 900000 + i) })).status, 400);
  assert.equal((await get(a.id)).priority, 'high');

  // Move: in the order given, together, before another task or at the end of a column.
  const d = await mk('Bulk D', { status: 'Alpha QA' });
  assert.deepEqual(await order('alpha_qa'), ['Bulk A', 'Bulk B', 'Bulk D']);
  const mv = await bulk({ action: 'move', ids: [d.id, c.key, a.id], status: 'alpha_qa', beforeId: b.id }, 'token');
  assert.equal(mv.status, 200);
  assert.deepEqual(await order('alpha_qa'), ['Bulk D', 'Bulk C', 'Bulk A', 'Bulk B']);
  assert.equal((await get(c.id)).activity[0].message, 'In Progress → Alpha QA');
  assert.equal((await bulk({ action: 'move', ids: [b.id, d.id], status: 'Beta QA' })).status, 200);
  assert.deepEqual(await order('beta_qa'), ['Bulk B', 'Bulk D']);
  assert.deepEqual(await order('alpha_qa'), ['Bulk C', 'Bulk A']);
  assert.equal((await bulk({ action: 'move', ids: [a.id, b.id], status: 'beta_qa', beforeId: b.id })).status, 400);
  assert.equal((await bulk({ action: 'move', ids: [a.id] })).status, 400);
  assert.equal((await bulk({ action: 'move', ids: [a.id], status: 'Nowhere' })).status, 400);

  // Categories: added to and removed from tasks that each have their own.
  const cats = await bulk({ action: 'categories', ids: [a.id, b.id], add: ['Combat'], remove: ['trinket'] });
  assert.equal(cats.status, 200);
  assert.deepEqual(cats.body.tasks.map((t: Json) => t.categories.map((x: Json) => x.name)), [['Combat'], ['Combat']]);
  assert.match((await get(a.id)).activity[0].message, /^categories: Combat$/);
  assert.equal((await bulk({ action: 'categories', ids: [a.id], add: ['Nope'] })).status, 400);
  assert.equal((await bulk({ action: 'categories', ids: [a.id] })).status, 400);

  // Tasks from two projects are refused.
  const other = (await call('POST', '/api/v1/projects', { key: 'BLK', name: 'Bulk other' })).body;
  const there = (await call('POST', '/api/v1/tasks?project=BLK', { title: 'Elsewhere' })).body;
  const mixed = await bulk({ action: 'update', ids: [a.id, there.key], set: { priority: 'low' } });
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error, /one project/);
  assert.equal((await call('DELETE', `/api/v1/projects/${other.id}?confirm=BLK`)).status, 200);
  assert.equal((await get(a.id)).priority, 'high');

  // One live event for the whole request, in the tasks' project.
  const seen: Array<{ kind: string; projectId?: number }> = [];
  const off = ctx.bus.subscribe((e) => seen.push(e));
  await bulk({ action: 'update', ids: [c.id, d.id], set: { priority: 'low' } });
  off();
  assert.deepEqual(seen.map((e) => [e.kind, e.projectId]), [['tasks', c.projectId]]);

  // Delete: sub-tasks stay (as top-level tasks) unless asked; with withSubtasks they go too.
  const p2 = await mk('Bulk P2');
  const k2 = await mk('Bulk K2', { parent: p2.key });
  const del = await bulk({ action: 'delete', ids: [parent.id, a.id] });
  assert.deepEqual(del.body, { ok: true, deleted: 2 });
  assert.equal((await get(kid.id)).parentId, null);
  const delAll = await bulk({ action: 'delete', ids: [p2.key, b.key], withSubtasks: true }, 'token');
  assert.deepEqual(delAll.body, { ok: true, deleted: 3 });
  assert.equal((await call('GET', `/api/v1/tasks/${k2.id}`)).status, 404);
  // A task already gone fails the whole request.
  assert.equal((await bulk({ action: 'delete', ids: [c.id, a.id] })).status, 404);
  assert.equal((await call('GET', `/api/v1/tasks/${c.id}`)).status, 200);
  assert.deepEqual((await bulk({ action: 'delete', ids: [c.id, d.id, kid.id] })).body, { ok: true, deleted: 3 });
  await call('DELETE', `/api/v1/epochs/${epoch.id}`);
});

test('copy: a folder with everything in it, epochs, tasks with their sub-tasks and files; all or nothing', async () => {
  const copy = (body: unknown, auth: 'session' | 'token' = 'session') => call('POST', '/api/v1/copy', body, auth);
  const mk = async (title: string, extra: Json = {}) => (await call('POST', '/api/v1/tasks', { title, ...extra })).body;
  const get = async (id: number) => (await call('GET', `/api/v1/tasks/${id}`)).body;
  const tree = async () => (await call('GET', '/api/v1/tree')).body;
  const content = async (id: number) => (await app.inject({ method: 'GET', url: `/api/v1/files/${id}/content`, headers: { cookie } })).body;
  const blobs = () => fs.readdirSync(ctx.filesDir).length;

  // Src/      "Card" with two sub-tasks: "Card text" here, "Card VFX" in an epoch outside Src; the epoch "Src epoch"
  // Src/Art/  the epoch "Sprites" with "Draw hero"; "Loose art"; "Orphan", a sub-task of a task outside Src;
  //           hero.png, and notes.md, which shows hero.png and links to a file outside Src
  const src = (await call('POST', '/api/v1/folders', { name: 'Src' })).body;
  const art = (await call('POST', '/api/v1/folders', { name: 'Art', parentId: src.id })).body;
  const outside = (await call('POST', '/api/v1/folders', { name: 'Outside' })).body;
  const readme = await upload(outside.id, 'readme.txt', 'outside', 'text/plain');
  const hero = await upload(art.id, 'hero.png', 'PNGDATA', 'image/png');
  const notesText = `![hero](/api/v1/files/${hero.id}/content)\n[readme](/api/v1/files/${readme.id}/content)`;
  const notes = (await call('POST', '/api/v1/docs', { name: 'notes', folderId: art.id, content: notesText })).body;
  const vfx = (await call('POST', '/api/v1/epochs', { name: 'Outside VFX' })).body;
  await call('POST', '/api/v1/epochs', { name: 'Src epoch', folderId: src.id, description: `Hero: /api/v1/files/${hero.id}/content` });
  const sprites = (await call('POST', '/api/v1/epochs', { name: 'Sprites', folderId: art.id, color: '#123456' })).body;
  const draw = await mk('Draw hero', {
    epochId: sprites.id, status: 'In Progress', priority: 'high', estimate: '2h', categories: ['Combat'],
    checklist: ['sketch', 'ink'], description: `Use /api/v1/files/${hero.id}/content`,
  });
  await call('PATCH', `/api/v1/checklist/${draw.checklistItems[0].id}`, { done: true });
  const loose = await mk('Loose art', { folderId: art.id });
  const outer = await mk('Outer parent');
  await mk('Orphan', { folderId: art.id, parent: outer.key });
  const card = await mk('Card', { folderId: src.id });
  const cardText = await mk('Card text', { folderId: src.id, parent: card.key });
  const cardVfx = await mk('Card VFX', { epochId: vfx.id, parent: card.key });

  // A dry run only counts.
  const start = { tree: await tree(), blobs: blobs() };
  const bytes = start.tree.files.filter((f: Json) => f.id === hero.id || f.id === notes.id).reduce((n: number, f: Json) => n + f.size, 0);
  const dry = await copy({ item: { kind: 'folder', id: src.id }, to: { folderId: null }, dryRun: true });
  // "Card VFX" lives outside Src: its copy goes to its own epoch, which the count says.
  assert.deepEqual(dry.body, { ok: true, dryRun: true, folders: 2, epochs: 2, tasks: 6, files: 2, bytes, subtasksElsewhere: 1 });
  assert.deepEqual(await tree(), start.tree);
  assert.equal(blobs(), start.blobs);

  // The copy: one live event per kind of thing made, in the project.
  const seen: Array<{ kind: string; projectId?: number }> = [];
  const off = ctx.bus.subscribe((e) => seen.push(e));
  const res = await copy({ item: { kind: 'folder', id: src.id }, to: { folderId: null } }, 'token');
  off();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual([res.body.folders, res.body.epochs, res.body.tasks, res.body.files], [2, 2, 6, 2]);
  assert.deepEqual([res.body.item.kind, res.body.item.name], ['folder', 'Src (copy)'], '"Src" is taken at the top level');
  assert.deepEqual(seen.map((e) => e.kind).sort(), ['epochs', 'files', 'folders', 'tasks']);
  assert.ok(seen.every((e) => e.projectId === card.projectId));

  const t = await tree();
  const newSrc = res.body.item.id;
  const newArt = t.folders.find((f: Json) => f.parentId === newSrc);
  assert.equal(newArt.name, 'Art', 'only the item copied is renamed');
  const epochsIn = (folderId: number) => t.epochs.filter((e: Json) => e.folderId === folderId);
  assert.deepEqual(epochsIn(newSrc).map((e: Json) => e.name), ['Src epoch']);
  const newSprites = epochsIn(newArt.id)[0];
  assert.deepEqual([newSprites.name, newSprites.color], ['Sprites', '#123456']);
  const newHero = t.files.find((f: Json) => f.folderId === newArt.id && f.name === 'hero.png');
  const newNotes = t.files.find((f: Json) => f.folderId === newArt.id && f.name === 'notes.md');

  // Copied tasks: new keys, first status, checklists unticked, the same fields; the originals are untouched.
  const fresh = new Map<string, Json>(t.tasks.filter((x: Json) => x.id > cardVfx.id).map((x: Json) => [x.title, x]));
  assert.deepEqual([...fresh.keys()].sort(), ['Card', 'Card VFX', 'Card text', 'Draw hero', 'Loose art', 'Orphan']);
  const d = await get(fresh.get('Draw hero')!.id);
  assert.deepEqual([d.epochId, d.status, d.priority, d.estimateMinutes], [newSprites.id, 'open', 'high', 120]);
  assert.deepEqual(d.checklistItems.map((i: Json) => [i.text, i.done]), [['sketch', false], ['ink', false]]);
  assert.deepEqual(d.categories.map((c: Json) => c.name), ['Combat']);
  assert.equal(d.description, `Use /api/v1/files/${newHero.id}/content`, 'links to copied files point at the copies');
  assert.deepEqual(d.activity.map((a: Json) => [a.actor, a.message]), [['claude', `Created in Open as a copy of ${draw.key}`]]);
  assert.equal((await get(draw.id)).status, 'in_progress');
  assert.equal(fresh.get('Loose art')!.folderId, newArt.id);
  // Sub-tasks: under the parent's copy, with it if they lived with it, else in their own epoch...
  const c2 = await get(fresh.get('Card')!.id);
  assert.deepEqual([c2.folderId, c2.subtasks], [newSrc, { total: 2, done: 0 }]);
  const ct2 = await get(fresh.get('Card text')!.id);
  assert.deepEqual([ct2.parentId, ct2.folderId], [c2.id, newSrc]);
  assert.equal(ct2.activity[0].message, `Created in Open as a copy of ${cardText.key} as a sub-task of ${c2.key}`);
  const cv2 = await get(fresh.get('Card VFX')!.id);
  assert.deepEqual([cv2.parentId, cv2.epochId], [c2.id, vfx.id]);
  assert.deepEqual((await get(card.id)).subtasks, { total: 2, done: 0 });
  // ...and one copied without its parent keeps that parent, which hears about it.
  const o2 = await get(fresh.get('Orphan')!.id);
  assert.deepEqual([o2.parentId, o2.folderId], [outer.id, newArt.id]);
  const outerNow = await get(outer.id);
  assert.deepEqual(outerNow.subtasks, { total: 2, done: 0 });
  assert.equal(outerNow.activity[0].message, `Added sub-task ${o2.key} "Orphan"`);

  // Files: each copy has its own stored content; documents point at the copies of files that were copied too.
  assert.equal(await content(newHero.id), 'PNGDATA');
  const notesCopy = await content(newNotes.id);
  assert.equal(notesCopy, `![hero](/api/v1/files/${newHero.id}/content)\n[readme](/api/v1/files/${readme.id}/content)`);
  assert.equal(newNotes.size, Buffer.byteLength(notesCopy));
  assert.equal(await content(notes.id), notesText);
  const stored = ctx.db.prepare('SELECT DISTINCT stored_name FROM files WHERE id IN (?, ?, ?, ?)').all(hero.id, notes.id, newHero.id, newNotes.id);
  assert.equal(stored.length, 4);
  assert.equal(blobs(), start.blobs + 2);
  const e2 = (await call('GET', `/api/v1/epochs/${epochsIn(newSrc)[0].id}`)).body;
  assert.equal(e2.description, `Hero: /api/v1/files/${newHero.id}/content`);

  // Names change only for the item copied, only when taken where it lands; files keep their extension.
  const dup1 = await copy({ item: { kind: 'file', id: hero.id }, to: { folderId: art.id } });
  const dup2 = await copy({ item: { kind: 'file', id: hero.id }, to: { folderId: art.id } });
  assert.deepEqual([dup1.body.item.name, dup2.body.item.name, dup1.body.files, dup1.body.tasks], ['hero (copy).png', 'hero (copy 2).png', 1, 0]);
  const notesAlone = await copy({ item: { kind: 'file', id: notes.id }, to: { folderId: null } });
  assert.equal(notesAlone.body.item.name, 'notes.md');
  assert.equal(await content(notesAlone.body.item.id), notesText, 'links to files that were not copied stay as they are');

  // An epoch, with its tasks.
  const ep = await copy({ item: { kind: 'epoch', id: sprites.id }, to: { folderId: art.id } });
  assert.deepEqual([ep.body.item.name, ep.body.epochs, ep.body.tasks], ['Sprites (copy)', 1, 1]);
  assert.equal((await tree()).tasks.filter((x: Json) => x.epochId === ep.body.item.id)[0].title, 'Draw hero');

  // A task: its sub-task that lived with it follows it into the epoch, the one in another epoch stays there.
  const into = await copy({ item: { kind: 'task', id: card.id }, to: { epochId: sprites.id } });
  assert.deepEqual([into.status, into.body.item.name, into.body.tasks, into.body.subtasksElsewhere], [201, 'Card', 3, 1]);
  const c3 = await get(into.body.item.id);
  assert.deepEqual([c3.epochId, c3.folderId], [sprites.id, null]);
  const kids = await Promise.all(c3.children.map((k: Json) => get(k.id)));
  assert.deepEqual(kids.map((k) => [k.title, k.epochId]).sort(), [['Card VFX', vfx.id], ['Card text', sprites.id]]);
  assert.equal((await copy({ item: { kind: 'task', id: card.id }, to: { folderId: src.id } })).body.item.name, 'Card (copy)');
  // A sub-task on its own stays a sub-task of the same parent.
  const alone = await copy({ item: { kind: 'task', id: cardText.id }, to: { folderId: null } });
  assert.deepEqual([alone.body.tasks, (await get(alone.body.item.id)).parentId], [1, card.id]);
  assert.equal((await get(card.id)).subtasks.total, 3);

  // Where a copy can't go.
  const refused: Array<[unknown, number]> = [
    [{ item: { kind: 'folder', id: src.id }, to: { folderId: src.id } }, 400],
    [{ item: { kind: 'folder', id: src.id }, to: { folderId: art.id } }, 400],
    [{ item: { kind: 'epoch', id: sprites.id }, to: { epochId: vfx.id } }, 400],
    [{ item: { kind: 'file', id: hero.id }, to: { epochId: vfx.id } }, 400],
    [{ item: { kind: 'task', id: card.id }, to: {} }, 400],
    [{ item: { kind: 'task', id: card.id }, to: { folderId: null, epochId: vfx.id } }, 400],
    [{ item: { kind: 'board', id: card.id }, to: { folderId: null } }, 400],
    [{ item: { kind: 'task', id: card.id }, to: { folderId: 999999 } }, 404],
    [{ item: { kind: 'task', id: card.id }, to: { epochId: 999999 } }, 404],
    [{ item: { kind: 'file', id: 999999 }, to: { folderId: null } }, 404],
  ];
  for (const [body, status] of refused) assert.equal((await copy(body)).status, status, JSON.stringify(body));

  // Limits on what one copy makes.
  const limits = { ...COPY_LIMITS };
  try {
    COPY_LIMITS.items = 5;
    const many = await copy({ item: { kind: 'folder', id: src.id }, to: { folderId: null }, dryRun: true });
    assert.equal(many.status, 400);
    assert.match(many.body.error, /more than 5 items/);
    Object.assign(COPY_LIMITS, limits, { bytes: 10 });
    const big = await copy({ item: { kind: 'folder', id: src.id }, to: { folderId: null } });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /one copy can hold/);
  } finally {
    Object.assign(COPY_LIMITS, limits);
  }

  // All or nothing: a failure while the rows are written leaves no rows and no stored files behind...
  ctx.db.prepare('UPDATE tasks SET type = ? WHERE id = ?').run('Ghost', loose.id);
  const beforeFail = { tree: await tree(), blobs: blobs() };
  const failed = await copy({ item: { kind: 'folder', id: src.id }, to: { folderId: null } });
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /Unknown type "Ghost"/);
  assert.deepEqual(await tree(), beforeFail.tree);
  assert.equal(blobs(), beforeFail.blobs);
  ctx.db.prepare('UPDATE tasks SET type = ? WHERE id = ?').run(loose.type, loose.id);
  // ...and so does a stored file that has gone missing, after the files before it were copied.
  const lost = await upload(art.id, 'zzz-lost.txt', 'gone', 'text/plain');
  const lostName = (ctx.db.prepare('SELECT stored_name FROM files WHERE id = ?').get(lost.id) as { stored_name: string }).stored_name;
  fs.renameSync(path.join(ctx.filesDir, lostName), path.join(tmp, 'lost-blob'));
  const beforeMissing = blobs();
  const missing = await copy({ item: { kind: 'folder', id: art.id }, to: { folderId: null } });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /zzz-lost\.txt/);
  assert.equal(blobs(), beforeMissing);
  fs.renameSync(path.join(tmp, 'lost-blob'), path.join(ctx.filesDir, lostName));
});

test('copy: a page saved in another encoding keeps every byte when its links are repointed', async () => {
  const folder = (await call('POST', '/api/v1/folders', { name: 'Old pages' })).body;
  const b = '----latin';
  const upload = async (filename: string, type: string, data: Buffer) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { cookie, 'x-pm-client': 'web', 'content-type': `multipart/form-data; boundary=${b}` },
      payload: Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${folder.id}\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${b}--\r\n`),
      ]),
    });
    assert.equal(res.statusCode, 201, res.body);
    return JSON.parse(res.body).files[0] as Json;
  };
  // "Café" in Windows-1252: the é is the single byte E9, which isn't valid UTF-8.
  const page = (imageId: number) =>
    Buffer.concat([Buffer.from(`<img src="/api/v1/files/${imageId}/content"> Caf`), Buffer.from([0xe9]), Buffer.from('\n')]);
  const image = await upload('logo.png', 'image/png', Buffer.from('PNGDATA'));
  await upload('guide.html', 'text/html', page(image.id));

  const res = await call('POST', '/api/v1/copy', { item: { kind: 'folder', id: folder.id }, to: { folderId: null } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const copies = (await call('GET', '/api/v1/tree')).body.files.filter((f: Json) => f.folderId === res.body.item.id);
  const newImage = copies.find((f: Json) => f.name === 'logo.png');
  const newPage = copies.find((f: Json) => f.name === 'guide.html');
  const stored = await app.inject({ method: 'GET', url: `/api/v1/files/${newPage.id}/content`, headers: { cookie } });
  assert.deepEqual(stored.rawPayload, page(newImage.id), 'only the link changed');
  assert.equal(newPage.size, page(newImage.id).length);
});

test('explorer: move several items of any kind at once; what is inside goes along; all or nothing', async () => {
  const move = (items: Json[], to: Json, auth: 'session' | 'token' = 'session') => call('POST', '/api/v1/explorer/move', { items, to }, auth);
  const folder = async (name: string, parentId: number | null = null) => (await call('POST', '/api/v1/folders', { name, parentId })).body;
  const mk = async (title: string, extra: Json = {}) => (await call('POST', '/api/v1/tasks', { title, ...extra })).body;
  const get = async (id: number) => (await call('GET', `/api/v1/tasks/${id}`)).body;
  const tree = async () => (await call('GET', '/api/v1/tree')).body;
  const ref = (kind: string, x: Json) => ({ kind, id: x.id });
  const where = async () => {
    const t = await tree();
    return {
      folder: (x: Json) => t.folders.find((f: Json) => f.id === x.id).parentId,
      epoch: (x: Json) => t.epochs.find((e: Json) => e.id === x.id).folderId,
      task: (x: Json) => {
        const found = t.tasks.find((k: Json) => k.id === x.id);
        return [found.epochId, found.folderId];
      },
      file: (x: Json) => t.files.find((f: Json) => f.id === x.id).folderId,
    };
  };

  // A/ holds B/ (with b.txt), the epoch "Move epoch" (with a task), a task and a.txt. C/ holds a task.
  const a = await folder('Move A');
  const b = await folder('Move B', a.id);
  const c = await folder('Move C');
  const epochA = (await call('POST', '/api/v1/epochs', { name: 'Move epoch', folderId: a.id })).body;
  const epochTop = (await call('POST', '/api/v1/epochs', { name: 'Move top epoch' })).body;
  const inA = await mk('Move in A', { folderId: a.id });
  const inEpoch = await mk('Move in epoch', { epochId: epochA.id });
  const inbox = await mk('Move inbox');
  const inC = await mk('Move in C', { folderId: c.id });
  const aFile = await upload(a.id, 'move-a.txt', 'a');
  const bFile = await upload(b.id, 'move-b.txt', 'b');
  const topFile = await upload(null, 'move-top.txt', 'top');

  // Mixed kinds into one folder in one request, with one live event per kind that moved.
  const seen: string[] = [];
  const off = ctx.bus.subscribe((e) => seen.push(e.kind));
  const r = await move([ref('folder', a), ref('file', topFile), ref('task', inbox)], { folderId: c.id }, 'token');
  off();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.moved, 3);
  assert.deepEqual(seen.sort(), ['files', 'folders', 'tasks']);
  let w = await where();
  assert.deepEqual([w.folder(a), w.file(topFile), w.task(inbox)], [c.id, c.id, [null, c.id]]);
  assert.match((await get(inbox.id)).activity[0].message, /moved to folder/);
  // What was inside A went with it.
  assert.deepEqual([w.folder(b), w.epoch(epochA), w.task(inA), w.file(aFile)], [a.id, a.id, [null, a.id], a.id]);

  // Items inside another item that moves keep their place inside it; items already there stay put.
  const r2 = await move([ref('folder', a), ref('folder', b), ref('file', bFile), ref('task', inEpoch)], { folderId: null });
  assert.equal(r2.body.moved, 1);
  w = await where();
  assert.deepEqual([w.folder(a), w.folder(b), w.file(bFile), w.task(inEpoch)], [null, a.id, b.id, [epochA.id, null]]);
  assert.equal((await move([ref('file', topFile), ref('task', inC)], { folderId: c.id })).body.moved, 0);

  // Tasks into an epoch, from a folder or from another epoch.
  assert.equal((await move([ref('task', inA), ref('task', inEpoch)], { epochId: epochTop.id })).body.moved, 2);
  w = await where();
  assert.deepEqual([w.task(inA), w.task(inEpoch)], [[epochTop.id, null], [epochTop.id, null]]);
  assert.match((await get(inA.id)).activity[0].message, /moved to epoch "Move top epoch"/);

  // Refused, and nothing moves: a folder into itself or a folder inside it (even with other items), anything but
  // tasks into an epoch, an item or destination that isn't there, a bad destination or list.
  const before = await tree();
  const refused: Array<[Json[], Json, number, RegExp?]> = [
    [[ref('file', topFile), ref('folder', a)], { folderId: b.id }, 400, /"Move A" can't go inside itself or a folder inside it/],
    [[ref('folder', c), ref('folder', a)], { folderId: a.id }, 400],
    [[ref('task', inC), ref('file', topFile)], { epochId: epochTop.id }, 400, /Only tasks can go inside an epoch: "move-top\.txt" isn't a task/],
    [[ref('task', inC), { kind: 'file', id: 999999 }], { folderId: null }, 404],
    [[ref('task', inC)], { epochId: 999999 }, 404],
    [[ref('task', inC)], { folderId: 999999 }, 404],
    [[ref('task', inC)], {}, 400],
    [[ref('task', inC)], { folderId: null, epochId: epochTop.id }, 400],
    [[], { folderId: null }, 400],
    [[{ kind: 'board', id: 1 }], { folderId: null }, 400],
  ];
  for (const [items, to, status, error] of refused) {
    const res = await move(items, to);
    assert.equal(res.status, status, JSON.stringify({ items, to, body: res.body }));
    if (error) assert.match(res.body.error, error);
  }
  assert.deepEqual(await tree(), before);

  // Items from two projects are refused.
  const other = (await call('POST', '/api/v1/projects', { key: 'MOV', name: 'Move other' })).body;
  const there = (await call('POST', '/api/v1/tasks?project=MOV', { title: 'Elsewhere' })).body;
  const mixed = await move([ref('task', inC), ref('task', there)], { folderId: null });
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error, /one project/);
  assert.equal((await call('DELETE', `/api/v1/projects/${other.id}?confirm=MOV`)).status, 200);
  assert.equal((await get(inC.id)).folderId, c.id);
});

test('explorer: delete several items of any kind at once; folders and epochs keep the rest of what is inside', async () => {
  const del = (items: Json[], extra: Json = {}, auth: 'session' | 'token' = 'session') =>
    call('POST', '/api/v1/explorer/delete', { items, ...extra }, auth);
  const folder = async (name: string, parentId: number | null = null) => (await call('POST', '/api/v1/folders', { name, parentId })).body;
  const mk = async (title: string, extra: Json = {}) => (await call('POST', '/api/v1/tasks', { title, ...extra })).body;
  const tree = async () => (await call('GET', '/api/v1/tree')).body;
  const blobs = () => fs.readdirSync(ctx.filesDir).length;
  const ref = (kind: string, x: Json) => ({ kind, id: x.id });
  const ids = (list: Json[]) => list.map((x) => x.id);

  // P/ holds Q/ (with a task and a file), the epoch "Del epoch" (two tasks), a task and a file.
  const p = await folder('Del P');
  const q = await folder('Del Q', p.id);
  const epoch = (await call('POST', '/api/v1/epochs', { name: 'Del epoch', folderId: p.id })).body;
  const e1 = await mk('Del e1', { epochId: epoch.id });
  const e2 = await mk('Del e2', { epochId: epoch.id });
  const inP = await mk('Del in P', { folderId: p.id });
  const inQ = await mk('Del in Q', { folderId: q.id });
  const pFile = await upload(p.id, 'del-p.txt', 'p');
  const qFile = await upload(q.id, 'del-q.txt', 'q');
  const parent = await mk('Del parent');
  const kid = await mk('Del kid', { parent: parent.key });

  const startBlobs = blobs();
  const seen: string[] = [];
  const off = ctx.bus.subscribe((e) => seen.push(e.kind));
  const r = await del([ref('folder', p), ref('task', e1), ref('file', pFile), ref('task', parent)], {}, 'token');
  off();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted, { folders: 1, epochs: 0, tasks: 2, files: 1 });
  assert.deepEqual([...new Set(seen)].sort(), ['epochs', 'files', 'folders', 'tasks']);
  assert.equal(blobs(), startBlobs - 1, 'the stored file goes too');
  const t = await tree();
  assert.ok(!ids(t.folders).includes(p.id) && !ids(t.files).includes(pFile.id));
  assert.ok(!ids(t.tasks).includes(e1.id) && !ids(t.tasks).includes(parent.id));
  // The rest of P moved up to the top level, its task to the Inbox; the rest of the epoch stayed in it.
  const task = (x: Json) => t.tasks.find((k: Json) => k.id === x.id);
  assert.equal(t.folders.find((f: Json) => f.id === q.id).parentId, null);
  assert.equal(t.epochs.find((e: Json) => e.id === epoch.id).folderId, null);
  assert.deepEqual([task(inP).epochId, task(inP).folderId], [null, null]);
  assert.deepEqual([task(e2).epochId, task(inQ).folderId, t.files.find((f: Json) => f.id === qFile.id).folderId], [epoch.id, q.id, q.id]);
  // The sub-task that stays is now a top-level task, and says why.
  const k = (await call('GET', `/api/v1/tasks/${kid.id}`)).body;
  assert.equal(k.parentId, null);
  assert.match(k.activity[0].message, /now a top-level task/);

  // withSubtasks deletes sub-tasks too.
  const p2 = await mk('Del parent 2');
  await mk('Del kid 2', { parent: p2.key });
  assert.deepEqual((await del([ref('task', p2)], { withSubtasks: true })).body.deleted, { folders: 0, epochs: 0, tasks: 2, files: 0 });

  // A folder and a folder inside it: both go, and what was inside the inner one ends up where the outer one was.
  const x = await folder('Del X');
  const y = await folder('Del Y', x.id);
  const yFile = await upload(y.id, 'del-y.txt', 'y');
  assert.deepEqual((await del([ref('folder', x), ref('folder', y)])).body.deleted, { folders: 2, epochs: 0, tasks: 0, files: 0 });
  assert.equal((await tree()).files.find((f: Json) => f.id === yFile.id).folderId, null);

  // An epoch with time logged directly on it needs deleteTime, which deletes that time too.
  const timed = (await call('POST', '/api/v1/epochs', { name: 'Del timed' })).body;
  assert.equal((await call('POST', '/api/v1/time', { epochId: timed.id, minutes: 30 })).status, 201);
  const refusedTime = await del([ref('epoch', timed), ref('folder', q)]);
  assert.equal(refusedTime.status, 409);
  assert.match(refusedTime.body.error, /"Del timed" has time logged directly on it/);
  assert.ok(ids((await tree()).folders).includes(q.id), 'nothing deleted');
  assert.deepEqual((await del([ref('epoch', timed)], { deleteTime: true })).body.deleted, { folders: 0, epochs: 1, tasks: 0, files: 0 });
  assert.equal((await call('GET', '/api/v1/time')).body.entries.filter((e: Json) => e.epochId === timed.id).length, 0);

  // All or nothing: one item that isn't there and nothing is deleted.
  const before = await tree();
  const bad = await del([ref('folder', q), ref('task', e2), { kind: 'file', id: 999999 }]);
  assert.equal(bad.status, 404);
  assert.deepEqual(await tree(), before);
  assert.equal((await del([])).status, 400);
});

test('copy: several items at once, each copied once, and duplicates next to their originals', async () => {
  const copy = (body: Json) => call('POST', '/api/v1/copy', body);
  const folder = async (name: string, parentId: number | null = null) => (await call('POST', '/api/v1/folders', { name, parentId })).body;
  const mk = async (title: string, extra: Json = {}) => (await call('POST', '/api/v1/tasks', { title, ...extra })).body;
  const tree = async () => (await call('GET', '/api/v1/tree')).body;
  const ref = (kind: string, x: Json) => ({ kind, id: x.id });

  // S1/ holds notes.txt, art.png, the epoch "Copy epoch" and the task "Copy card", whose sub-task "Copy card VFX"
  // lives in S2/, which has a notes.txt of its own.
  const s1 = await folder('Copy S1');
  const s2 = await folder('Copy S2');
  const notes1 = await upload(s1.id, 'notes.txt', 'one');
  const notes2 = await upload(s2.id, 'notes.txt', 'two');
  const art = await upload(s1.id, 'art.png', 'PNG', 'image/png');
  const epoch = (await call('POST', '/api/v1/epochs', { name: 'Copy epoch', folderId: s1.id })).body;
  const card = await mk('Copy card', { folderId: s1.id });
  const vfx = await mk('Copy card VFX', { folderId: s2.id, parent: card.key });

  // Two files with one name into one folder: each gets a free name there, in the order given.
  const two = await copy({ items: [ref('file', notes1), ref('file', notes2)], to: { folderId: s2.id } });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  assert.deepEqual(two.body.items.map((i: Json) => i.name), ['notes (copy).txt', 'notes (copy 2).txt']);
  assert.deepEqual(two.body.item, two.body.items[0]);
  assert.equal(two.body.files, 2);

  // What is inside an item is copied once, with it, even when it is asked for too: the folder brings its files,
  // epoch and task, and the task its sub-task (whose copy goes to S2, like its original).
  const alone = await copy({ item: ref('folder', s1), to: { folderId: null }, dryRun: true });
  assert.deepEqual([alone.body.folders, alone.body.epochs, alone.body.tasks, alone.body.files, alone.body.subtasksElsewhere], [1, 1, 2, 2, 1]);
  const all = [ref('folder', s1), ref('file', art), ref('task', card), ref('epoch', epoch), ref('task', vfx)];
  assert.deepEqual((await copy({ items: all, to: { folderId: null }, dryRun: true })).body, alone.body);
  // A sub-task asked for with its parent comes along with the parent.
  const pair = await copy({ items: [ref('task', vfx), ref('task', card)], to: { folderId: null } });
  assert.equal(pair.status, 201, JSON.stringify(pair.body));
  assert.equal(pair.body.tasks, 2);
  assert.deepEqual(pair.body.items.map((i: Json) => i.name), ['Copy card']);

  // Duplicates of items in different places: each copy goes next to its original.
  const inbox = await mk('Copy inbox task');
  const dup = await copy({ items: [ref('file', art), ref('task', inbox), ref('epoch', epoch)], to: { inPlace: true } });
  assert.equal(dup.status, 201, JSON.stringify(dup.body));
  assert.deepEqual(dup.body.items.map((i: Json) => i.name), ['art (copy).png', 'Copy inbox task (copy)', 'Copy epoch (copy)']);
  const t = await tree();
  const dupTask = t.tasks.find((x: Json) => x.id === dup.body.items[1].id);
  assert.equal(t.files.find((f: Json) => f.id === dup.body.items[0].id).folderId, s1.id);
  assert.deepEqual([dupTask.epochId, dupTask.folderId], [null, null]);
  assert.equal(t.epochs.find((e: Json) => e.id === dup.body.items[2].id).folderId, s1.id);

  // Refused.
  const refused: Array<[Json, number]> = [
    [{ item: ref('task', card), items: [ref('task', card)], to: { folderId: null } }, 400],
    [{ to: { folderId: null } }, 400],
    [{ items: [], to: { folderId: null } }, 400],
    [{ items: [ref('task', card)], to: { inPlace: true, folderId: null } }, 400],
    [{ items: [ref('task', card), ref('file', art)], to: { epochId: epoch.id } }, 400],
    [{ items: [ref('folder', s2), ref('folder', s1)], to: { folderId: s1.id } }, 400],
    [{ items: [ref('task', card), { kind: 'file', id: 999999 }], to: { inPlace: true } }, 404],
  ];
  for (const [body, status] of refused) assert.equal((await copy(body)).status, status, JSON.stringify(body));
  const intoItself = await copy({ items: [ref('folder', s2), ref('folder', s1)], to: { folderId: s1.id } });
  assert.match(intoItself.body.error, /"Copy S1" can't be copied into itself or into a folder inside it/);
});

test('passwords and tokens are stored only as hashes', async () => {
  createUser(ctx.db, 'hash-check', 'plain-text-password');
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('hash-check') as { password_hash: string };
  assert.match(row.password_hash, /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!row.password_hash.includes('plain-text-password'));
  // Same password, different salt: two users never share a hash.
  createUser(ctx.db, 'hash-check-2', 'plain-text-password');
  const row2 = ctx.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('hash-check-2') as { password_hash: string };
  assert.notEqual(row.password_hash, row2.password_hash);
  // Login still works against the hash.
  assert.equal((await call('POST', '/api/auth/login', { username: 'hash-check', password: 'plain-text-password' }, 'none')).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'hash-check', password: 'wrong-password' }, 'none')).status, 401);
  for (const t of ctx.db.prepare('SELECT token_hash FROM api_tokens').all() as Array<{ token_hash: string }>) assert.match(t.token_hash, /^[0-9a-f]{64}$/);
  for (const s of ctx.db.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>) assert.match(s.token_hash, /^[0-9a-f]{64}$/);
});

test('integration files are served without login from a fixed list only', async () => {
  // Plain text, not JSON, so these go through app.inject directly rather than the JSON call() helper.
  const fetchText = (url: string) => app.inject({ method: 'GET', url });
  for (const name of ['install.mjs', 'SKILL.md', 'pm.mjs', 'API.md', 'instructions.md']) {
    const r = await fetchText(`/integration/${name}`);
    assert.equal(r.statusCode, 200, name);
    assert.match(String(r.headers['content-type']), /^text\/plain; charset=utf-8/);
    assert.ok(r.body.length > 100, `${name} has content`);
  }
  assert.match((await fetchText('/integration/SKILL.md')).body, /^---\r?\nname: project-tracker/);
  for (const bad of ['package.json', 'install.ps1', '..%2Fpackage.json', '..%5C..%5Cdata%5Cpm.db', 'constructor', '__proto__']) {
    assert.equal((await fetchText(`/integration/${bad}`)).statusCode, 404, bad);
  }
  // The installer defaults to the server it came from; a Host header that isn't a plain host is ignored.
  const served = (host: string) => app.inject({ method: 'GET', url: '/integration/install.mjs', headers: { host } });
  assert.match((await served('192.168.1.50:9000')).body, /const SERVED_FROM = "http:\/\/192\.168\.1\.50:9000";/);
  assert.match((await served('pm.local')).body, /const SERVED_FROM = "http:\/\/pm\.local";/);
  for (const evil of ["x'+process.exit()+'", 'a b', 'host/path']) {
    assert.match((await served(evil)).body, /const SERVED_FROM = '%%PM_SERVER_URL%%';/, evil);
  }
});

test('HTML preview: sandboxed, inlines files from its own folder, still needs a login', async () => {
  const readme = (await call('POST', '/api/v1/folders', { name: 'Readme' })).body;
  const images = (await call('POST', '/api/v1/folders', { name: 'images', parentId: readme.id })).body;
  const uploadTo = async (folderId: number, name: string, type: string, data: string) => {
    const b = '----pmrender';
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { cookie, 'x-pm-client': 'web', 'content-type': `multipart/form-data; boundary=${b}` },
      payload:
        `--${b}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${folderId}\r\n` +
        `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${data}\r\n--${b}--\r\n`,
    });
    assert.equal(r.statusCode, 201, r.body);
    return JSON.parse(r.body).files[0];
  };
  const shot = await uploadTo(images.id, 'Shot.png', 'image/png', 'PNGDATA');
  await uploadTo(readme.id, 'style.css', 'text/css', 'body{color:red}');
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>' +
    '<h1>Héllo</h1><img src="images/shot.png"><img src=\'/api/v1/files/' + shot.id + '/content\'>' +
    '<img src="missing.png"><img src="https://example.com/x.png"><a href="images/shot.png">link</a>' +
    '<a href="Guide/Setup.html#install">setup</a><a href=\'readme.html#faq\'>faq</a><a href="#top">top</a>' +
    '<a href="https://example.com/a.html">ext</a><a href="nope.html">missing page</a>' +
    '<script>document.title = "ran"</script></body></html>';
  const guide = (await call('POST', '/api/v1/folders', { name: 'guide', parentId: readme.id })).body;
  const setup = (await call('POST', '/api/v1/docs', { name: 'setup.html', folderId: guide.id, content: '<a href="../readme.html">back</a>' })).body;
  const doc = (await call('POST', '/api/v1/docs', { name: 'readme.html', folderId: readme.id, content: html })).body;

  const r = await app.inject({ method: 'GET', url: `/api/v1/files/${doc.id}/render`, headers: { cookie } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  const csp = String(r.headers['content-security-policy']);
  assert.match(csp, /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
  assert.ok(!csp.includes('allow-same-origin') && !csp.includes('allow-top-navigation') && !csp.includes('allow-forms'));
  assert.match(csp, /connect-src 'none'/);
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  const pngUri = `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`;
  assert.ok(r.body.includes(`href="data:text/css;base64,${Buffer.from('body{color:red}').toString('base64')}"`), 'stylesheet inlined');
  assert.ok(r.body.includes(`<img src="${pngUri}">`), 'relative image inlined (case-insensitive names)');
  assert.ok(r.body.includes(`<img src='${pngUri}'>`), 'pasted /api/v1/files/N/content image inlined');
  assert.ok(r.body.includes('<img src="missing.png">') && r.body.includes('src="https://example.com/x.png"'), 'others untouched');
  assert.ok(r.body.includes('<a href="images/shot.png">'), 'links to non-page files are not rewritten');
  assert.ok(r.body.includes('<h1>Héllo</h1>') && r.body.includes('<script>document.title'), 'content and encoding preserved');

  // Links between uploaded pages go to their preview; a link to the page itself keeps only its fragment.
  assert.ok(r.body.includes(`<a href="/api/v1/files/${setup.id}/render#install" data-pm-file="${setup.id}">setup</a>`), r.body);
  assert.ok(r.body.includes(`<a href='#faq'>faq</a>`) && r.body.includes('<a href="#top">top</a>'), 'self links');
  assert.ok(r.body.includes('<a href="https://example.com/a.html">') && r.body.includes('<a href="nope.html">'), 'others untouched');
  assert.match(r.body, /postMessage\(\{type:"pm-open-file"[\s\S]*<\/script><\/body><\/html>$/, 'navigation script added before </body>');
  const back = await app.inject({ method: 'GET', url: `/api/v1/files/${setup.id}/render`, headers: { cookie } });
  assert.ok(back.body.startsWith(`<a href="/api/v1/files/${doc.id}/render" data-pm-file="${doc.id}">back</a><script>`), back.body);

  // Login is still required, only HTML/SVG can be previewed, and the rest of the app keeps its own headers.
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/files/${doc.id}/render` })).statusCode, 401);
  assert.equal((await call('GET', `/api/v1/files/${shot.id}/render`)).status, 400);

  // Uploads without a MIME type (the pm CLI) get a label from the extension, but /content still serves them as text.
  const svg = await uploadTo(readme.id, 'logo.svg', 'application/octet-stream', '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
  const htm = await uploadTo(readme.id, 'old.htm', 'application/octet-stream', '<p>old page</p>');
  assert.equal(svg.mime, 'image/svg+xml');
  assert.equal(htm.mime, 'text/html');
  for (const f of [svg, htm]) {
    const c = await app.inject({ method: 'GET', url: `/api/v1/files/${f.id}/content`, headers: { cookie } });
    assert.equal(c.headers['content-type'], 'text/plain; charset=utf-8');
  }
  const svgRender = await app.inject({ method: 'GET', url: `/api/v1/files/${svg.id}/render`, headers: { cookie } });
  assert.equal(svgRender.headers['content-type'], 'image/svg+xml; charset=utf-8');
  assert.match(String(svgRender.headers['content-security-policy']), /^sandbox /);
  // An SVG pasted into an HTML page by its render URL is embedded too.
  await call('PUT', `/api/v1/files/${htm.id}/content`, { content: `<img src="/api/v1/files/${svg.id}/render">` });
  const htmRender = await app.inject({ method: 'GET', url: `/api/v1/files/${htm.id}/render`, headers: { cookie } });
  assert.ok(htmRender.body.startsWith('<img src="data:image/svg+xml;base64,'), htmRender.body);

  const other = await call('GET', '/api/v1/tasks');
  assert.equal(other.res.headers['x-frame-options'], 'DENY');
  assert.match(String(other.res.headers['content-security-policy']), /^default-src 'self'/);
});

// ---- Projects: per-project keys and settings, and nobody sees anyone else's project ----------------------

/** Logs in and returns a request helper for that account (session cookie, or one of its API tokens). */
async function loginAs(username: string, password: string) {
  const res = await call('POST', '/api/auth/login', { username, password }, 'none');
  assert.equal(res.status, 200, res.res.body);
  const raw = res.res.headers['set-cookie'];
  const userCookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  let userToken = '';
  const req = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = userToken ? { authorization: `Bearer ${userToken}` } : { cookie: userCookie, 'x-pm-client': 'web' };
    const r = await app.inject({ method: method as 'GET', url, headers: { ...h, ...headers }, ...(body !== undefined ? { payload: body as Json } : {}) });
    const isJson = String(r.headers['content-type'] ?? '').includes('application/json');
    return { status: r.statusCode, body: isJson && r.body ? (JSON.parse(r.body) as Json) : {}, raw: r };
  };
  return {
    req,
    cookie: userCookie,
    useToken: (t: string) => {
      userToken = t;
    },
  };
}

test('projects: each has its own keys, types and categories; new accounts start with none', async () => {
  createUser(ctx.db, 'pat', 'pat-password-1');
  const pat = await loginAs('pat', 'pat-password-1');
  const none = await pat.req('GET', '/api/v1/tasks');
  assert.equal(none.status, 400);
  assert.match(none.body.error, /no projects yet/);

  assert.equal((await pat.req('POST', '/api/v1/projects', { key: 'bad key', name: 'x' })).status, 400);
  assert.equal((await pat.req('POST', '/api/v1/projects', { key: 't', name: 'Taken' })).status, 409, 'keys are unique on the server');
  const a = await pat.req('POST', '/api/v1/projects', { key: 'pa', name: 'Pat A' });
  assert.equal(a.status, 201);
  assert.equal(a.body.key, 'PA');
  // With one project, it is used when none is named.
  const t1 = (await pat.req('POST', '/api/v1/tasks', { title: 'First in A' })).body;
  assert.equal(t1.key, 'PA-1');
  assert.equal((await pat.req('POST', '/api/v1/categories', { name: 'Level' })).status, 201);

  const b = (await pat.req('POST', '/api/v1/projects', { key: 'PB', name: 'Pat B', copyFrom: a.body.id })).body;
  // With two, a request must say which.
  const which = await pat.req('GET', '/api/v1/tasks');
  assert.equal(which.status, 400);
  assert.match(which.body.error, /PA \(Pat A\), PB \(Pat B\)/);
  const inB = (await pat.req('POST', '/api/v1/tasks', { title: 'First in B', categories: ['Level'] }, { 'x-pm-project': 'pb' })).body;
  assert.equal(inB.key, 'PB-1', 'numbering is per project');
  assert.equal(inB.categories[0].name, 'Level', 'categories were copied');
  assert.equal((await pat.req('GET', `/api/v1/tasks/PB-1`)).body.id, inB.id);
  assert.equal((await pat.req('GET', '/api/v1/tasks?project=PA')).body.tasks.length, 1);
  assert.deepEqual((await pat.req('GET', '/api/v1/tasks?q=PA-1', undefined, { 'x-pm-project': 'PB' })).body.tasks, [], 'keys only match in their project');
  // Settings are per project.
  await pat.req('DELETE', `/api/v1/categories/${(await pat.req('GET', '/api/v1/categories?project=PB')).body.categories[0].id}`);
  assert.equal((await pat.req('GET', '/api/v1/categories?project=PA')).body.categories.length, 1);
  assert.equal((await pat.req('POST', `/api/v1/tasks/${t1.id}/links`, { task: inB.key })).status, 400, 'no links across projects');

  // A new key renames task keys; deleting needs the web app and the key repeated.
  assert.equal((await pat.req('PATCH', `/api/v1/projects/${b.id}`, { key: 'PBX' })).body.key, 'PBX');
  assert.equal((await pat.req('GET', `/api/v1/tasks/${inB.id}`)).body.key, 'PBX-1');
  assert.equal((await pat.req('DELETE', `/api/v1/projects/${b.id}`)).status, 400);
  assert.equal((await pat.req('DELETE', `/api/v1/projects/${b.id}?confirm=pbx`)).status, 200);
  assert.equal((await pat.req('GET', `/api/v1/tasks/${inB.id}`)).status, 404);
  assert.equal((await pat.req('GET', '/api/v1/tasks')).body.tasks.length, 1, 'back to one project: no header needed');
});

test('projects are private: another account gets "not found" for everything in them', async () => {
  // Things in alice's project T.
  const epoch = (await call('POST', '/api/v1/epochs', { name: 'Private epoch' })).body;
  const folder = (await call('POST', '/api/v1/folders', { name: 'Private folder' })).body;
  const task = (await call('POST', '/api/v1/tasks', { title: 'Private task', checklist: ['secret step'], epochId: epoch.id })).body;
  const item = task.checklistItems[0];
  const doc = (await call('POST', '/api/v1/docs', { name: 'secret.html', folderId: folder.id, content: '<p>secret</p>' })).body;
  const diagram = (await call('GET', '/api/v1/diagrams')).body.diagrams[0];
  const category = (await call('GET', '/api/v1/categories')).body.categories[0];
  const entry = (await call('POST', '/api/v1/time', { taskId: task.id, minutes: 5 })).body;
  const project = (await call('GET', '/api/v1/projects')).body.projects.find((p: Json) => p.key === 'T');
  const aliceToken = (await call('GET', '/api/v1/tokens')).body.tokens[0];
  const template = (await call('POST', '/api/v1/templates', { name: 'Private template' })).body;

  createUser(ctx.db, 'mallory', 'mallory-password');
  const m = await loginAs('mallory', 'mallory-password');
  const own = (await m.req('POST', '/api/v1/projects', { key: 'MAL', name: 'Mine' })).body;
  const ownTask = (await m.req('POST', '/api/v1/tasks', { title: 'My task' })).body;
  const mToken = (await m.req('POST', '/api/v1/tokens', { name: 'mallory-bot' })).body.token;

  const probes: Array<[string, string, unknown?]> = [
    ['GET', `/api/v1/projects/${project.id}`],
    ['GET', '/api/v1/projects/T'],
    ['PATCH', `/api/v1/projects/${project.id}`, { name: 'pwned' }],
    ['DELETE', `/api/v1/projects/${project.id}?confirm=T`],
    ['GET', '/api/v1/tasks?project=T'],
    ['GET', '/api/v1/tree?project=T'],
    ['GET', `/api/v1/tasks/${task.id}`],
    ['GET', `/api/v1/tasks/${task.key}`],
    ['PATCH', `/api/v1/tasks/${task.id}`, { title: 'pwned' }],
    ['POST', `/api/v1/tasks/${task.id}/move`, { status: 'open' }],
    ['POST', `/api/v1/tasks/${task.id}/advance`, {}],
    ['POST', `/api/v1/tasks/${task.id}/status`, { status: 'Alpha QA' }],
    ['POST', `/api/v1/tasks/${task.id}/comments`, { message: 'hi' }],
    ['POST', `/api/v1/tasks/${task.id}/checklist`, { text: 'x' }],
    ['PATCH', `/api/v1/checklist/${item.id}`, { done: true }],
    ['DELETE', `/api/v1/checklist/${item.id}`],
    ['POST', `/api/v1/tasks/${ownTask.id}/links`, { task: task.key }],
    ['DELETE', `/api/v1/tasks/${task.id}`],
    ['DELETE', `/api/v1/tasks/${task.id}?withSubtasks=true`],
    ['GET', `/api/v1/tasks?parent=${task.key}`],
    ['GET', `/api/v1/epochs/${epoch.id}`],
    ['PATCH', `/api/v1/epochs/${epoch.id}`, { name: 'pwned' }],
    ['DELETE', `/api/v1/epochs/${epoch.id}`],
    ['PATCH', `/api/v1/folders/${folder.id}`, { name: 'pwned' }],
    ['DELETE', `/api/v1/folders/${folder.id}`],
    ['GET', `/api/v1/files/${doc.id}`],
    ['GET', `/api/v1/files/${doc.id}/content`],
    ['GET', `/api/v1/files/${doc.id}/render`],
    ['PUT', `/api/v1/files/${doc.id}/content`, { content: 'pwned' }],
    ['PATCH', `/api/v1/files/${doc.id}`, { name: 'pwned.html' }],
    ['DELETE', `/api/v1/files/${doc.id}`],
    ['GET', `/api/v1/diagrams/${diagram.id}`],
    ['PUT', `/api/v1/diagrams/${diagram.id}`, { nodes: [], edges: [] }],
    ['POST', `/api/v1/diagrams/${diagram.id}/nodes`, { label: 'X' }],
    ['DELETE', `/api/v1/diagrams/${diagram.id}/nodes/X`],
    ['PATCH', `/api/v1/diagrams/${diagram.id}`, { name: 'pwned' }],
    ['POST', `/api/v1/diagrams/${diagram.id}/import`, { nodes: [{ label: 'pwned' }] }],
    ['PATCH', `/api/v1/diagrams/${diagram.id}/edges/x`, { label: 'pwned' }],
    ['DELETE', `/api/v1/diagrams/${diagram.id}`],
    ['PATCH', `/api/v1/categories/${category.id}`, { name: 'pwned' }],
    ['DELETE', `/api/v1/categories/${category.id}`],
    ['PATCH', `/api/v1/time/${entry.id}`, { note: 'pwned' }],
    ['DELETE', `/api/v1/time/${entry.id}`],
    ['POST', '/api/v1/time', { taskId: task.id, minutes: 5 }],
    ['POST', '/api/v1/time/start', { epochId: epoch.id }],
    ['GET', `/api/v1/time?taskId=${task.key}`],
    // References from Mallory's own project to Alice's things.
    ['POST', '/api/v1/tasks', { title: 'x', epochId: epoch.id }],
    ['POST', '/api/v1/tasks', { title: 'x', folderId: folder.id }],
    ['PATCH', `/api/v1/tasks/${ownTask.id}`, { folderId: folder.id }],
    ['POST', '/api/v1/tasks', { title: 'x', parent: task.key }],
    ['POST', '/api/v1/tasks', { title: 'x', parent: task.id }],
    ['PATCH', `/api/v1/tasks/${ownTask.id}`, { parent: task.key }],
    ['GET', `/api/v1/templates/${template.id}`],
    ['GET', '/api/v1/templates/Private%20template'],
    ['GET', '/api/v1/templates?project=T'],
    ['PATCH', `/api/v1/templates/${template.id}`, { name: 'pwned' }],
    ['DELETE', `/api/v1/templates/${template.id}`],
    ['POST', '/api/v1/templates', { name: 'x', fromTask: task.key }],
    ['POST', '/api/v1/tasks', { template: template.id, title: 'x' }],
    ['POST', '/api/v1/tasks/bulk', { action: 'update', ids: [task.id], set: { priority: 'low' } }],
    ['POST', '/api/v1/tasks/bulk', { action: 'move', ids: [task.key], status: 'open' }],
    ['POST', '/api/v1/tasks/bulk', { action: 'categories', ids: [task.id], add: ['x'] }],
    ['POST', '/api/v1/tasks/bulk', { action: 'delete', ids: [ownTask.id, task.id] }],
    ['POST', '/api/v1/tasks/bulk', { action: 'update', ids: [ownTask.id], set: { parent: task.key } }],
    ['POST', '/api/v1/tasks/bulk', { action: 'update', ids: [ownTask.id], set: { epochId: epoch.id } }],
    ['POST', '/api/v1/epochs', { name: 'x', folderId: folder.id }],
    ['POST', '/api/v1/folders', { name: 'x', parentId: folder.id }],
    ['POST', '/api/v1/docs', { name: 'x.md', folderId: folder.id }],
    ['POST', '/api/v1/copy', { item: { kind: 'folder', id: folder.id }, to: { folderId: null } }],
    ['POST', '/api/v1/copy', { item: { kind: 'folder', id: folder.id }, to: { folderId: null }, dryRun: true }],
    ['POST', '/api/v1/copy', { item: { kind: 'epoch', id: epoch.id }, to: { folderId: null } }],
    ['POST', '/api/v1/copy', { item: { kind: 'task', id: task.id }, to: { folderId: null } }],
    ['POST', '/api/v1/copy', { item: { kind: 'file', id: doc.id }, to: { folderId: null } }],
    ['POST', '/api/v1/copy', { item: { kind: 'task', id: ownTask.id }, to: { epochId: epoch.id } }],
    ['POST', '/api/v1/copy', { item: { kind: 'task', id: ownTask.id }, to: { folderId: folder.id } }],
    ['POST', '/api/v1/copy', { items: [{ kind: 'task', id: ownTask.id }, { kind: 'folder', id: folder.id }], to: { folderId: null } }],
    ['POST', '/api/v1/copy', { items: [{ kind: 'epoch', id: epoch.id }], to: { inPlace: true } }],
    ['POST', '/api/v1/explorer/move', { items: [{ kind: 'folder', id: folder.id }], to: { folderId: null } }],
    ['POST', '/api/v1/explorer/move', { items: [{ kind: 'task', id: ownTask.id }], to: { epochId: epoch.id } }],
    ['POST', '/api/v1/explorer/move', { items: [{ kind: 'task', id: ownTask.id }], to: { folderId: folder.id } }],
    ['POST', '/api/v1/explorer/delete', { items: [{ kind: 'task', id: ownTask.id }, { kind: 'task', id: task.id }] }],
    ['POST', '/api/v1/explorer/delete', { items: [{ kind: 'file', id: doc.id }] }],
  ];
  for (const auth of ['session', 'token'] as const) {
    if (auth === 'token') m.useToken(mToken);
    for (const [method, url, body] of probes) {
      if (auth === 'token' && method === 'DELETE' && url.startsWith('/api/v1/projects')) continue; // web-only route: 403 for tokens
      const r = await m.req(method, url, body);
      assert.equal(r.status, 404, `${auth} ${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  // Uploads into someone else's folder, and pages that point at someone else's files.
  const b = '----iso';
  const up = await app.inject({
    method: 'POST',
    url: '/api/v1/files',
    headers: { authorization: `Bearer ${mToken}`, 'content-type': `multipart/form-data; boundary=${b}` },
    payload: `--${b}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${folder.id}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhi\r\n--${b}--\r\n`,
  });
  assert.equal(up.statusCode, 404);
  const page = (await m.req('POST', '/api/v1/docs', { name: 'steal.html', content: `<img src="/api/v1/files/${doc.id}/content">` })).body;
  const rendered = await m.req('GET', `/api/v1/files/${page.id}/render`);
  assert.ok(rendered.raw.body.includes(`src="/api/v1/files/${doc.id}/content"`), 'not inlined from another project');

  // Lists only show Mallory's own things; account and token admin is off limits.
  assert.deepEqual((await m.req('GET', '/api/v1/projects')).body.projects.map((p: Json) => p.key), ['MAL']);
  assert.deepEqual((await m.req('GET', '/api/v1/templates')).body.templates, []);
  const mTree = (await m.req('GET', '/api/v1/tree')).body;
  assert.deepEqual(mTree.tasks.map((t: Json) => t.key), [ownTask.key]);
  assert.equal(mTree.files.length, 1);
  m.useToken('');
  assert.equal((await m.req('GET', '/api/v1/users')).status, 403);
  assert.equal((await m.req('POST', '/api/v1/users', { username: 'x2', password: 'long-enough-pw' })).status, 403);
  assert.equal((await m.req('GET', '/api/v1/backups')).status, 403);
  assert.deepEqual((await m.req('GET', '/api/v1/tokens')).body.tokens.map((t: Json) => t.name), ['mallory-bot']);
  assert.equal((await m.req('DELETE', `/api/v1/tokens/${aliceToken.id}`)).status, 404);
  // A raw parentId is ignored rather than checked, so it can't be used to probe for other people's tasks.
  const probe = await m.req('POST', '/api/v1/tasks', { title: 'Probe', parentId: task.id });
  assert.equal(probe.status, 201);
  assert.equal(probe.body.parentId, null);

  // Nothing changed on Alice's side.
  const after = (await call('GET', `/api/v1/tasks/${task.id}`)).body;
  assert.equal(after.title, 'Private task');
  assert.equal(after.checklistItems.length, 1);
  assert.equal((await call('GET', `/api/v1/time?taskId=${task.id}`)).body.entries.length, 1);

  // Live updates: Mallory hears about her own project only.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  const abort = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers: { cookie: m.cookie }, signal: abort.signal });
  const reader = stream.body!.getReader();
  let text = '';
  const collect = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch {
      /* aborted */
    }
  })();
  await new Promise((r) => setTimeout(r, 100));
  await call('PATCH', `/api/v1/tasks/${task.id}`, { title: 'Private task, renamed' });
  await m.req('PATCH', `/api/v1/tasks/${ownTask.id}`, { title: 'My task, renamed' });
  await new Promise((r) => setTimeout(r, 200));
  abort.abort();
  await collect;
  const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Json);
  assert.ok(events.some((e) => e.kind === 'tasks' && e.id === ownTask.id), text);
  assert.ok(events.every((e) => e.projectId === own.id || e.userId !== undefined), `leaked: ${text}`);

  // An admin can remove the account, but only together with its projects when asked to.
  const mUser = (await call('GET', '/api/v1/users')).body.users.find((u: Json) => u.username === 'mallory');
  assert.equal(mUser.projectCount, 1);
  assert.equal((await call('DELETE', `/api/v1/users/${mUser.id}`)).status, 409);
  assert.equal((await call('DELETE', `/api/v1/users/${mUser.id}?deleteProjects=true`)).status, 200);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(own.id)?.n, 0);
});

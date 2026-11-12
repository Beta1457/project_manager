/**
 * Fills an EMPTY data folder with generic demo content, for trying the app, checking changes on a
 * scratch server and taking README screenshots: an account, a project with folders, epochs, tasks
 * (statuses, checklists, links, comments, logged time), a document and an architecture diagram.
 *
 * It never touches real data: it stops unless PM_DATA_DIR names a folder that has no database yet.
 *
 *   PM_DATA_DIR=../pm-demo PM_PASSWORD=<8+ characters> node scripts/demo-seed.ts [username]
 *   PM_DATA_DIR=../pm-demo PM_PORT=8099 PM_HOST=127.0.0.1 node server/index.ts    (sign in as "demo")
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server/app.ts';
import { createUser } from '../server/auth.ts';
import { createProject } from '../server/routes/projects.ts';

type Json = Record<string, any>;

function fail(message: string): never {
  console.error(`demo-seed: ${message}`);
  process.exit(1);
}

const dirSetting = process.env.PM_DATA_DIR;
if (!dirSetting) fail('set PM_DATA_DIR to a new, empty folder for the demo (never your real data folder)');
const dataDir = path.resolve(dirSetting);
// Opening a database runs migrations, so this check must come before anything opens one.
if (fs.existsSync(path.join(dataDir, 'pm.db'))) fail(`${dataDir} already has a database; the demo only fills an empty data folder`);
const password = process.env.PM_PASSWORD ?? '';
if (password.length < 8) fail('set PM_PASSWORD (at least 8 characters) for the demo account');
const username = process.argv[2] ?? 'demo';

fs.mkdirSync(dataDir, { recursive: true });
const { app, ctx } = await buildApp({
  port: 0,
  host: '127.0.0.1',
  dataDir,
  webDist: path.join(dataDir, 'no-web'),
  backupIntervalHours: 0,
  backupKeep: 1,
  maxUploadMb: 50,
});

const userId = createUser(ctx.db, username, password, { admin: true });
const projectId = createProject(ctx.db, userId, {
  key: 'DEMO',
  name: 'Demo game',
  categories: [
    ['Gameplay', '#7c3aed'],
    ['Art', '#db2777'],
    ['Audio', '#0891b2'],
    ['UI', '#d97706'],
  ],
});

const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
if (login.statusCode !== 200) fail(`could not sign in (HTTP ${login.statusCode})`);
const setCookie = login.headers['set-cookie'];
const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];

/** Calls the API the way the web app does; stops the script on any error. */
async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Json> {
  const res = await app.inject({
    method,
    url,
    headers: { cookie, 'x-pm-client': 'web', 'x-pm-project': String(projectId) },
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  if (res.statusCode >= 400) fail(`${method} ${url} failed (HTTP ${res.statusCode}): ${res.body}`);
  return res.body ? (JSON.parse(res.body) as Json) : {};
}

// ---- Folders and epochs --------------------------------------------------

const design = await call('POST', '/api/v1/folders', { name: 'Design' });
const levels = await call('POST', '/api/v1/folders', { name: 'Levels', parentId: design.id });
const production = await call('POST', '/api/v1/folders', { name: 'Production' });

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const slice = await call('POST', '/api/v1/epochs', {
  name: 'Vertical slice',
  color: '#6366f1',
  folderId: production.id,
  targetDate: inDays(30),
  estimate: '40h',
  description: 'One polished level that shows the whole game: movement, enemies, a menu and saving.',
});
const artPass = await call('POST', '/api/v1/epochs', { name: 'Art pass', color: '#db2777', folderId: production.id, targetDate: inDays(45) });
const audioPass = await call('POST', '/api/v1/epochs', { name: 'Audio pass', color: '#0891b2', folderId: production.id, targetDate: inDays(60) });

// ---- Tasks -----------------------------------------------------------------

interface TaskSeed {
  title: string;
  type?: string;
  status?: string;
  priority?: string;
  epoch?: Json;
  folder?: Json;
  categories?: string[];
  checklist?: string[];
  /** How many checklist items (from the top) are ticked. */
  ticked?: number;
  estimate?: string;
  description?: string;
}

const seeds: Record<string, TaskSeed> = {
  movement: {
    title: 'Player movement and jumping',
    status: 'alpha_complete',
    epoch: slice,
    categories: ['Gameplay'],
    checklist: ['Walk and run', 'Jump with variable height', 'Coyote time', 'Jump buffering'],
    ticked: 4,
    estimate: '6h',
    description: 'Tight, responsive controls. Tune the numbers in `PlayerTuning`.',
  },
  enemies: {
    title: 'Enemy patrol AI',
    status: 'in_progress',
    priority: 'high',
    epoch: slice,
    categories: ['Gameplay'],
    checklist: ['Waypoint paths', 'Notice the player', 'Chase and give up', 'Return to the path'],
    ticked: 1,
    estimate: '8h',
  },
  saving: { title: 'Save and load', epoch: slice, categories: ['Gameplay'], estimate: '5h' },
  menu: { title: 'Main menu', status: 'alpha_qa', epoch: slice, categories: ['UI'], estimate: '3h' },
  settings: { title: 'Settings screen: audio, controls, display', epoch: slice, categories: ['UI'], estimate: '4h' },
  sprites: {
    title: 'Character sprites',
    type: 'Art',
    status: 'in_progress',
    epoch: artPass,
    categories: ['Art'],
    checklist: ['Idle', 'Run', 'Jump', 'Hurt'],
    ticked: 2,
  },
  tileset: { title: 'Forest tileset', type: 'Art', epoch: artPass, categories: ['Art'] },
  footsteps: { title: 'Footstep sounds for each ground type', type: 'Audio', epoch: audioPass, categories: ['Audio'] },
  music: { title: 'Title screen music', type: 'Audio', epoch: audioPass, categories: ['Audio'], priority: 'low' },
  levelOne: { title: 'Level 1 layout', type: 'Content', folder: levels, categories: ['Gameplay'], estimate: '6h' },
  pauseCrash: {
    title: 'Game crashes when pausing during a cutscene',
    type: 'Bug',
    priority: 'critical',
    description: 'Steps: start the intro cutscene, press Esc. Expected: the pause menu. Actual: a crash.',
  },
  controller: { title: 'Controller support', priority: 'low', categories: ['Gameplay', 'UI'] },
};

const tasks: Record<string, Json> = {};
for (const [name, s] of Object.entries(seeds)) {
  const t = await call('POST', '/api/v1/tasks', {
    title: s.title,
    description: s.description ?? '',
    type: s.type ?? 'Feature',
    status: s.status ?? 'open',
    priority: s.priority ?? 'medium',
    epochId: s.epoch?.id ?? null,
    folderId: s.epoch ? null : (s.folder?.id ?? null),
    categories: s.categories ?? [],
    checklist: s.checklist ?? [],
    ...(s.estimate ? { estimate: s.estimate } : {}),
  });
  for (const item of (t.checklistItems ?? []).slice(0, s.ticked ?? 0)) {
    await call('PATCH', `/api/v1/checklist/${item.id}`, { done: true });
  }
  tasks[name] = t;
}

await call('POST', `/api/v1/tasks/${tasks.saving.id}/links`, { task: tasks.enemies.id, kind: 'blocked_by' });
await call('POST', `/api/v1/tasks/${tasks.sprites.id}/links`, { task: tasks.tileset.id, kind: 'relates' });
await call('POST', `/api/v1/tasks/${tasks.enemies.id}/comments`, { message: 'Patrol paths work. Next: losing track of the player behind walls.' });
await call('POST', `/api/v1/tasks/${tasks.pauseCrash.id}/comments`, { message: 'Only happens when the cutscene has audio playing.' });

await call('POST', '/api/v1/time', { taskId: tasks.movement.id, minutes: 330, note: 'Controls and tuning' });
await call('POST', '/api/v1/time', { taskId: tasks.enemies.id, minutes: 150, note: 'Waypoints and detection' });
await call('POST', '/api/v1/time', { taskId: tasks.sprites.id, minutes: 95, note: 'Idle and run cycles' });
await call('POST', '/api/v1/time', { epochId: slice.id, minutes: 45, note: 'Planning the slice' });

// ---- Documents -------------------------------------------------------------

await call('POST', '/api/v1/docs', {
  name: 'Game design.md',
  folderId: design.id,
  content: [
    '# Demo game',
    '',
    'A short platformer: run, jump and sneak past patrolling enemies to reach the end of each level.',
    '',
    '## Pillars',
    '',
    '- **Responsive controls**: every jump feels fair.',
    '- **Readable enemies**: you can always tell what an enemy is about to do.',
    '- **Short levels**: each one takes two to four minutes.',
    '',
  ].join('\n'),
});

// ---- Architecture diagram ------------------------------------------------------

const diagram = await call('POST', '/api/v1/diagrams', { name: 'Game architecture' });
const box = async (label: string, layer: string, description: string) =>
  (await call('POST', `/api/v1/diagrams/${diagram.id}/nodes`, { label, layer, description })).id as string;
const loop = await box('Game loop', 'core', 'Fixed-step update, then render');
const input = await box('Input', 'core', 'Keyboard, mouse and controller');
const player = await box('Player', 'gameplay', 'Movement, health and abilities');
const ai = await box('Enemy AI', 'gameplay', 'Patrol, chase and give up');
const hud = await box('HUD', 'ui', 'Health and pause menu');
const saves = await box('Save system', 'data', 'Slots on disk, versioned');
const audio = await box('Audio', 'services', 'Music and sound effects');
const connect = (source: string, target: string, label = '') =>
  call('POST', `/api/v1/diagrams/${diagram.id}/edges`, { source, target, label });
await connect(loop, input, 'polls');
await connect(loop, player, 'updates');
await connect(loop, ai, 'updates');
await connect(player, input, 'reads');
await connect(ai, player, 'tracks');
await connect(hud, player, 'shows');
await connect(saves, player, 'stores');
await connect(player, audio, 'plays');

// ---- Two big diagrams, for trying groups, folding and the automatic layout on something sizeable ----

/** The same "random" numbers every run, so the demo looks the same each time. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
const rnd = seeded(7);
const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Nested: 30 systems (groups) of 10 classes each, with sizes, paths and roles.
const SYSTEMS: Array<[string, string]> = [
  ['Rendering', 'core'], ['Physics', 'core'], ['Input', 'core'], ['Camera', 'core'], ['Animation', 'core'], ['Lighting', 'core'], ['Shaders', 'core'],
  ['Combat', 'gameplay'], ['Enemy AI', 'gameplay'], ['Pathfinding', 'gameplay'], ['Quests', 'gameplay'], ['Inventory', 'gameplay'],
  ['Dialogue', 'gameplay'], ['Weather', 'gameplay'], ['Terrain', 'gameplay'],
  ['Menus', 'ui'], ['HUD', 'ui'], ['Localization', 'ui'], ['Achievements', 'ui'],
  ['Save games', 'data'], ['Assets', 'data'], ['Streaming', 'data'], ['Telemetry', 'data'],
  ['Audio', 'services'], ['Networking', 'services'], ['Matchmaking', 'services'], ['Particles', 'services'],
  ['Level editor', 'tools'], ['Build pipeline', 'tools'], ['Replays', 'tools'],
];
const PARTS: Array<[string, string]> = [
  ['Manager', 'Owns the {s} state and runs its update'],
  ['Config', 'Tunable numbers for {s}'],
  ['Cache', 'Keeps recent {s} results to skip repeat work'],
  ['Loader', 'Reads {s} data from disk'],
  ['Debugger', 'Draws {s} overlays in debug builds'],
  ['Events', 'Messages other systems can listen to'],
  ['Pool', 'Reuses objects instead of allocating new ones'],
  ['Settings', 'What the player can change about {s}'],
  ['Utils', 'Small helpers shared inside {s}'],
  ['Tests', 'Automated checks for {s}'],
];
const nestedNodes: Json[] = [];
const nestedEdges: Json[] = [];
for (const [name, layer] of SYSTEMS) {
  const system = `sys-${slug(name)}`;
  nestedNodes.push({ id: system, label: name, layer, path: `src/${slug(name)}/`, role: `Everything to do with ${name.toLowerCase()}` });
  for (const [part, role] of PARTS) {
    const className = name.replace(/[^A-Za-z]/g, '') + part;
    const id = `${slug(name)}-${part.toLowerCase()}`;
    nestedNodes.push({
      id,
      label: className,
      layer,
      parent: system,
      path: `src/${slug(name)}/${className}.cs`,
      role: role.replace('{s}', name.toLowerCase()),
      weight: Math.round(40 + rnd() ** 2 * 2500),
    });
    if (part !== 'Manager') nestedEdges.push({ source: `${slug(name)}-manager`, target: id, label: 'uses' });
  }
}
// Systems use the ones below them (tools > ui > gameplay > services > data > core), now and then one beside
// them, and rarely one above (a callback), like real code; each use is a few arrows between their classes.
const TIER: Record<string, number> = { core: 0, data: 1, services: 2, gameplay: 3, ui: 4, tools: 5 };
const VERB: Record<string, string> = { Events: 'listens to', Config: 'reads', Settings: 'reads', Loader: 'loads with', Cache: 'asks', Pool: 'borrows from' };
const used = new Set<string>();
for (const [name, layer] of SYSTEMS) {
  const below = SYSTEMS.filter(([, l]) => TIER[l] < TIER[layer]);
  const beside = SYSTEMS.filter(([other, l]) => l === layer && other !== name);
  const above = SYSTEMS.filter(([, l]) => TIER[l] > TIER[layer]);
  for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
    const r = rnd();
    const from = r < 0.06 && above.length ? above : r < 0.25 || !below.length ? beside : below;
    const [other] = pick(from);
    if (used.has(`${name}>${other}`)) continue;
    used.add(`${name}>${other}`);
    for (let c = 1 + Math.floor(rnd() * 3); c > 0; c--) {
      const [fromPart] = pick(PARTS);
      const [toPart] = rnd() < 0.5 ? PARTS[0] : pick(PARTS);
      nestedEdges.push({
        source: `${slug(name)}-${fromPart.toLowerCase()}`,
        target: `${slug(other)}-${toPart.toLowerCase()}`,
        label: VERB[toPart] ?? 'calls',
        count: 1 + Math.floor(rnd() ** 3 * 12),
      });
    }
  }
}
// Arrows stored between two whole systems (counted), as an agent summing up call sites would add them.
nestedEdges.push({ source: 'sys-combat', target: 'sys-physics', label: 'queries', count: 64 });
nestedEdges.push({ source: 'sys-rendering', target: 'sys-shaders', label: 'compiles', count: 40 });
const nested = await call('POST', '/api/v1/diagrams', { name: 'Engine systems (nested)' });
await call('POST', `/api/v1/diagrams/${nested.id}/import`, { mode: 'replace', nodes: nestedNodes, edges: nestedEdges });

// Flat: 650 boxes in 7 layers and 1200 arrows, no groups of its own (it opens folded into its layers).
const LAYERS = ['core', 'gameplay', 'ui', 'data', 'services', 'tools', 'external'];
const flatNodes: Json[] = [];
const byLayer = new Map<string, Json[]>(LAYERS.map((l) => [l, []]));
for (let i = 1; i <= 650; i++) {
  const layer = LAYERS[Math.floor(rnd() ** 1.3 * LAYERS.length)];
  const n = { id: `m${i}`, label: `Module ${String(i).padStart(3, '0')}`, layer, role: `Part of the ${layer} layer` };
  flatNodes.push(n);
  byLayer.get(layer)!.push(n);
}
const flatEdges: Json[] = [];
const joined = new Set<string>();
while (flatEdges.length < 1200) {
  const a = pick(flatNodes);
  const b = pick(rnd() < 0.7 ? byLayer.get(a.layer)! : flatNodes); // mostly within a layer
  const key = `${a.id}>${b.id}`;
  if (a.id === b.id || joined.has(key)) continue;
  joined.add(key);
  flatEdges.push({ source: a.id, target: b.id, label: pick(['calls', 'reads', 'writes', '']) });
}
const flat = await call('POST', '/api/v1/diagrams', { name: 'Everything (flat)' });
await call('POST', `/api/v1/diagrams/${flat.id}/import`, { mode: 'replace', nodes: flatNodes, edges: flatEdges });

await app.close();
console.log(`Demo data is in ${dataDir}. Sign in as "${username}" with the password from PM_PASSWORD.`);

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DB } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { has, nonEmpty, parseId } from '../lib/util.ts';

type LinkKind = 'task' | 'epoch' | 'folder' | 'file';
const LINK_KINDS: readonly string[] = ['task', 'epoch', 'folder', 'file'];

export interface DiagramNode {
  id: string;
  label: string;
  description: string;
  layer: string;
  /** Position inside the parent box (or on the canvas). Only the manual layout uses it. */
  x: number;
  y: number;
  /** A fixed size in px. Without one, the size comes from the text and the weight. */
  width?: number;
  height?: number;
  link?: { kind: LinkKind; id: number } | null;
  /** Id of the box this one sits inside. A box with boxes inside it is a group. */
  parent?: string;
  /** Where it is in the code, e.g. "src/combat/". */
  path?: string;
  /** One line on what it does. */
  role?: string;
  /** How big it is (lines of code, say). Heavier boxes are drawn bigger. */
  weight?: number;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  /** How many connections the arrow stands for (call sites, say). Absent means 1. */
  count?: number;
}

export interface DiagramSettings {
  layout: 'auto' | 'manual';
  direction: 'DOWN' | 'RIGHT';
}

interface DiagramData {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  settings: DiagramSettings;
}

/** A node or edge as a client sends it: any field may be missing, null (which clears it) or the wrong type. */
type Input = Record<string, unknown>;

/** Suggested layers; any string is accepted. The UI colours these. */
export const LAYERS = ['core', 'gameplay', 'ui', 'data', 'services', 'tools', 'external'];

/** `depth` is how many groups a box may sit inside, one within another. */
export const DIAGRAM_LIMITS = { nodes: 2000, edges: 5000, depth: 6 } as const;
const DEFAULT_SETTINGS: DiagramSettings = { layout: 'auto', direction: 'DOWN' };
/** Node fields a web page from before groups and sizes leaves out of its saves; they are kept from the stored node. */
const KEPT_NODE_FIELDS = ['width', 'height', 'link', 'parent', 'path', 'role', 'weight'] as const;

const shortId = () => crypto.randomBytes(5).toString('hex');
const blank = (v: unknown) => v === undefined || v === null || v === '';
const labelKey = (label: unknown) => String(label ?? '').trim().toLowerCase();

function load(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id) as
    | { id: number; name: string; data: string; version: number; created_at: string; updated_at: string }
    | undefined;
  if (!row) throw notFound(`Diagram ${id}`);
  const data = JSON.parse(row.data) as Partial<DiagramData>;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nodes: data.nodes ?? [],
    edges: data.edges ?? [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
  };
}

/** Writes the whole diagram (boxes, arrows and settings) and bumps its version. */
function save(db: DB, id: number, data: DiagramData, name?: string): void {
  const { nodes, edges, settings } = data;
  db.prepare(
    'UPDATE diagrams SET data = ?, name = COALESCE(?, name), version = version + 1, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify({ nodes, edges, settings }), name ?? null, nowIso(), id);
}

/** Whether a node may link to that item (it must be in the diagram's project). */
type LinkCheck = (kind: LinkKind, id: number) => boolean;

/** A number from a request, kept within [min, max]. Missing, null or "" gives undefined; any other non-number is a 400. */
function optionalNumber(v: unknown, what: string, min: number, max: number, integer = false): number | undefined {
  if (blank(v)) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest(`${what} must be a number`);
  return Math.min(max, Math.max(min, integer ? Math.round(v) : v));
}

/** Text from a request, trimmed and cut to `max` characters; empty gives undefined. */
function optionalText(v: unknown, max: number, oneLine = false): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s = String(v);
  if (oneLine) s = s.split(/\r?\n/)[0];
  s = s.trim().slice(0, max);
  return s || undefined;
}

function sanitizeNode(n: Input, linkOk: LinkCheck, fallback?: DiagramNode): DiagramNode {
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw badRequest('Each node must be an object');
  // A field in the request wins, even null (which clears it); a missing field keeps the stored value.
  const pick = (k: keyof DiagramNode): unknown => (has(n, k) ? n[k] : fallback?.[k]);
  const coord = (v: unknown, stored?: number) => (typeof v === 'number' && Number.isFinite(v) ? v : (stored ?? 0));
  const id = String(pick('id') ?? shortId());
  if (!id || id.length > 128) throw badRequest('A node id must be 1-128 characters');
  const node: DiagramNode = {
    id,
    label: String(pick('label') ?? '').trim().slice(0, 200),
    description: String(pick('description') ?? '').slice(0, 5000),
    layer: String(pick('layer') ?? 'core').trim().slice(0, 40) || 'core',
    x: coord(n.x, fallback?.x),
    y: coord(n.y, fallback?.y),
  };
  if (!node.label) throw badRequest('Node label is required');
  const width = optionalNumber(pick('width'), 'width', 40, 4000);
  const height = optionalNumber(pick('height'), 'height', 24, 4000);
  if (width !== undefined) node.width = width;
  if (height !== undefined) node.height = height;
  const link = pick('link') as { kind?: unknown; id?: unknown } | null | undefined;
  if (link && typeof link === 'object' && LINK_KINDS.includes(String(link.kind)) && Number.isInteger(link.id)) {
    const kind = link.kind as LinkKind;
    if (linkOk(kind, link.id as number)) node.link = { kind, id: link.id as number };
  }
  // An id; the routes turn a parent given by label into its id before this point. checkStructure checks it exists.
  const parent = pick('parent');
  if (!blank(parent)) node.parent = String(parent);
  const path = optionalText(pick('path'), 300);
  if (path) node.path = path;
  const role = optionalText(pick('role'), 200, true);
  if (role) node.role = role;
  const weight = optionalNumber(pick('weight'), 'weight', 0, 1e9);
  if (weight !== undefined) node.weight = weight;
  return node;
}

function sanitizeEdge(e: Input, fallback?: DiagramEdge): DiagramEdge {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw badRequest('Each edge must be an object');
  const pick = (k: keyof DiagramEdge): unknown => (has(e, k) ? e[k] : fallback?.[k]);
  const edge: DiagramEdge = {
    id: String(pick('id') ?? '').slice(0, 128) || shortId(),
    source: String(pick('source') ?? ''),
    target: String(pick('target') ?? ''),
    label: String(pick('label') ?? '').slice(0, 200),
  };
  const count = optionalNumber(pick('count'), 'count', 1, 1e6, true);
  if (count !== undefined && count > 1) edge.count = count;
  return edge;
}

function sanitizeSettings(input: unknown, base: DiagramSettings): DiagramSettings {
  if (input === undefined || input === null) return base;
  if (typeof input !== 'object' || Array.isArray(input)) throw badRequest('settings must be an object');
  const s = input as Input;
  const out = { ...base };
  if (has(s, 'layout')) {
    if (s.layout !== 'auto' && s.layout !== 'manual') throw badRequest('settings.layout must be "auto" or "manual"');
    out.layout = s.layout;
  }
  if (has(s, 'direction')) {
    if (s.direction !== 'DOWN' && s.direction !== 'RIGHT') throw badRequest('settings.direction must be "DOWN" or "RIGHT"');
    out.direction = s.direction;
  }
  return out;
}

/**
 * Makes boxes and arrows consistent and returns the arrows to keep. Every parent must exist, with no
 * loops and no box inside more than DIAGRAM_LIMITS.depth groups, and no arrow may join a box to a group
 * it sits in. Arrows to boxes that don't exist are dropped. Strict (an API caller, who can fix the
 * request) answers 400 for anything else; lenient (an older web page saving the whole diagram) moves a
 * box whose parent doesn't fit to the top level and drops an arrow that doesn't fit.
 */
function checkStructure(nodes: DiagramNode[], edges: DiagramEdge[], strict: boolean): DiagramEdge[] {
  if (nodes.length > DIAGRAM_LIMITS.nodes) throw badRequest(`A diagram can have at most ${DIAGRAM_LIMITS.nodes} boxes`);
  if (edges.length > DIAGRAM_LIMITS.edges) throw badRequest(`A diagram can have at most ${DIAGRAM_LIMITS.edges} arrows`);
  const byId = new Map<string, DiagramNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) throw badRequest(`Duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }
  const problem = (message: string, n: DiagramNode) => {
    if (strict) throw badRequest(message);
    delete n.parent;
  };
  for (const n of nodes) {
    if (n.parent === undefined) continue;
    if (n.parent === n.id) problem(`"${n.label}" can't be inside itself`, n);
    else if (!byId.has(n.parent)) problem(`"${n.label}" is inside "${n.parent}", which doesn't exist`, n);
  }
  // Loops: a walk up from a box that comes back to it. A loop higher up is caught when one of its own boxes is walked.
  for (const n of nodes) {
    const seen = new Set([n.id]);
    for (let p = n.parent; p !== undefined; p = byId.get(p)?.parent) {
      if (p === n.id) {
        problem(`"${n.label}" ends up inside itself through its parents`, n);
        break;
      }
      if (seen.has(p)) break;
      seen.add(p);
    }
  }
  // Depth, now that every walk up ends.
  for (const n of nodes) {
    let depth = 0;
    for (let p = n.parent; p !== undefined; p = byId.get(p)?.parent) {
      if (++depth > DIAGRAM_LIMITS.depth) {
        problem(`"${n.label}" is inside more than ${DIAGRAM_LIMITS.depth} levels of groups`, n);
        break;
      }
    }
  }
  const isInside = (node: string, group: string) => {
    for (let p = byId.get(node)?.parent; p !== undefined; p = byId.get(p)?.parent) if (p === group) return true;
    return false;
  };
  const label = (id: string) => byId.get(id)?.label ?? id;
  return edges.filter((e) => {
    if (!byId.has(e.source) || !byId.has(e.target)) return false;
    if (isInside(e.source, e.target) || isInside(e.target, e.source)) {
      if (strict) throw badRequest(`An arrow can't join "${label(e.source)}" and "${label(e.target)}": one is inside the other`);
      return false;
    }
    return true;
  });
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/** Finds a box by id, or by label (ignoring case) when only one box has that label. */
function nodeFinder(nodes: DiagramNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byLabel = groupBy(nodes, (n) => labelKey(n.label));
  return (ref: unknown): DiagramNode => {
    const s = String(ref ?? '');
    const hit = byId.get(s);
    if (hit) return hit;
    const matches = byLabel.get(labelKey(s)) ?? [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw conflict(`${matches.length} boxes are labelled "${s}" (ids ${matches.map((m) => m.id).join(', ')}); use an id instead`);
    }
    throw notFound(`Node "${s}"`);
  };
}

/** Labels are unique among the boxes in the same group (or at the top level). */
function assertUniqueAmongSiblings(nodes: DiagramNode[], node: DiagramNode): void {
  const key = labelKey(node.label);
  if (nodes.some((n) => n.id !== node.id && n.parent === node.parent && labelKey(n.label) === key)) {
    throw conflict(`A node labelled "${node.label}" already exists ${node.parent ? 'in that group' : 'at the top level'}; update it instead`);
  }
}

/** A free spot among a box's siblings, for the manual layout (the automatic one ignores positions). */
function autoPosition(nodes: DiagramNode[], parent: string | undefined): { x: number; y: number } {
  const siblings = nodes.filter((n) => n.parent === parent);
  // Inside a group, start clear of its header.
  const start = parent ? { x: 20, y: 56 } : { x: 0, y: 0 };
  if (!siblings.length) return start;
  const maxX = Math.max(...siblings.map((n) => n.x));
  const column = siblings.filter((n) => n.x === maxX);
  if (column.length < 5) return { x: maxX, y: Math.max(...column.map((n) => n.y)) + 120 };
  return { x: maxX + 260, y: start.y };
}

interface ImportBody {
  mode?: 'replace' | 'merge';
  version?: number;
  dryRun?: boolean;
  nodes: Input[];
  edges?: Input[];
  settings?: unknown;
}

/** What an import does. `updated` counts only the boxes and arrows it actually changes. */
interface Counts {
  added: number;
  updated: number;
  removed: number;
}

/** Whether two stored records are the same, whatever order their fields are in. */
function sameRecord(a: object, b: object): boolean {
  const sorted = (_key: string, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : v;
  return JSON.stringify(a, sorted) === JSON.stringify(b, sorted);
}

/**
 * Works out the diagram an import produces.
 *
 * Each imported box is matched to a box already in the diagram: one with the same id; failing that, one with
 * the same label in a parent with the same label; failing that, one with the same label anywhere. A label only
 * matches when neither side has it twice. A matched box takes the import's id if it gives one, and keeps any
 * field the import leaves out (position, size, link...). Boxes that match nothing are added. "replace" then
 * removes every box and arrow the import doesn't list, and a box listed without a parent goes to the top
 * level; "merge" keeps them. Parents and arrow ends may be ids or labels. An arrow listed more than once is
 * one arrow whose count is the total; one listed once without a count keeps the count it has.
 */
function planImport(cur: DiagramData, body: ImportBody, linkOk: LinkCheck) {
  const replace = body.mode === 'replace';
  const byId = new Map(cur.nodes.map((n) => [n.id, n]));

  const items = body.nodes.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Each node must be an object');
    const label = String(input.label ?? '').trim().slice(0, 200);
    if (!label) throw badRequest('Every imported node needs a label');
    const givenId = blank(input.id) ? undefined : String(input.id);
    return { input, label, givenId, old: undefined as DiagramNode | undefined };
  });
  type Item = (typeof items)[number];
  const byGivenId = new Map<string, Item>();
  for (const it of items) {
    if (it.givenId === undefined) continue;
    if (byGivenId.has(it.givenId)) throw badRequest(`Two imported nodes have the id "${it.givenId}"`);
    byGivenId.set(it.givenId, it);
  }

  // 1. Match imported boxes to stored ones.
  const taken = new Set<string>();
  for (const it of items) {
    it.old = it.givenId === undefined ? undefined : byId.get(it.givenId);
    if (it.old) taken.add(it.old.id);
  }
  /** The label of the parent an imported box names ("" for the top level), or undefined if it names none. */
  const importedParentLabel = (it: Item): string | undefined => {
    if (!has(it.input, 'parent')) return replace ? '' : undefined;
    const p = it.input.parent;
    if (blank(p)) return '';
    const s = String(p);
    return byId.get(s)?.label ?? byGivenId.get(s)?.label ?? s;
  };
  const matchBy = (storedKey: (n: DiagramNode) => string, importedKey: (it: Item) => string | undefined) => {
    const stored = groupBy(cur.nodes.filter((n) => !taken.has(n.id)), storedKey);
    const waiting = items.filter((it) => !it.old && importedKey(it) !== undefined);
    for (const [key, list] of groupBy(waiting, (it) => importedKey(it) as string)) {
      const same = stored.get(key);
      if (list.length === 1 && same?.length === 1) {
        list[0].old = same[0];
        taken.add(same[0].id);
      }
    }
  };
  const parentLabel = (n: DiagramNode) => (n.parent === undefined ? '' : (byId.get(n.parent)?.label ?? ''));
  matchBy(
    (n) => `${labelKey(parentLabel(n))}\u0000${labelKey(n.label)}`,
    (it) => {
      const p = importedParentLabel(it);
      return p === undefined ? undefined : `${labelKey(p)}\u0000${labelKey(it.label)}`;
    },
  );
  matchBy((n) => labelKey(n.label), (it) => labelKey(it.label));
  // Without an id, a label that several stored boxes still share can't be placed: ask rather than guess.
  const freeByLabel = groupBy(cur.nodes.filter((n) => !taken.has(n.id)), (n) => labelKey(n.label));
  for (const it of items) {
    if (it.old || it.givenId !== undefined) continue;
    const same = freeByLabel.get(labelKey(it.label)) ?? [];
    if (same.length > 1) {
      throw conflict(
        `${same.length} boxes are labelled "${it.label}" (ids ${same.map((n) => n.id).join(', ')}); give the imported one the id of the box it means`,
      );
    }
  }

  // 2. Final ids. A matched box takes the id the import gives it; anything that pointed at its old id follows.
  const renamed = new Map<string, string>();
  const planned = items.map((it) => {
    const id = it.givenId ?? it.old?.id ?? shortId();
    if (it.old && it.old.id !== id) renamed.set(it.old.id, id);
    return { ...it, id };
  });
  const follow = (id: string) => renamed.get(id) ?? id;
  const kept = replace
    ? []
    : cur.nodes.filter((n) => !taken.has(n.id)).map((n) => (n.parent === undefined ? n : { ...n, parent: follow(n.parent) }));

  // 3. References (parents, arrow ends): an id, or a label only one box has. Imported boxes come first.
  const finalIds = new Set([...planned.map((p) => p.id), ...kept.map((n) => n.id)]);
  const importedByLabel = groupBy(planned, (p) => labelKey(p.label));
  const keptByLabel = groupBy(kept, (n) => labelKey(n.label));
  const resolve = (ref: unknown, what: string): string => {
    const s = String(ref ?? '').trim();
    if (!s) throw badRequest(`${what} is empty`);
    if (finalIds.has(s)) return s;
    const moved = renamed.get(s);
    if (moved !== undefined) return moved;
    for (const [list, where] of [
      [importedByLabel.get(labelKey(s)), 'imported '],
      [keptByLabel.get(labelKey(s)), ''],
    ] as const) {
      if (!list?.length) continue;
      if (list.length > 1) throw conflict(`${what}: ${list.length} ${where}boxes are labelled "${s}"; use an id instead`);
      return list[0].id;
    }
    throw badRequest(`${what}: there is no box "${s}" in the import${replace ? '' : ' or the diagram'}`);
  };

  // 4. The boxes.
  const nodes: DiagramNode[] = [...kept];
  let nodesChanged = 0;
  for (const { input, label, id, old } of planned) {
    const n: Input = { ...input, id };
    if (has(input, 'parent')) n.parent = blank(input.parent) ? null : resolve(input.parent, `The parent of "${label}"`);
    else if (replace) n.parent = null; // "replace" means exactly what the import says
    else if (old?.parent !== undefined) n.parent = follow(old.parent);
    // A new box, or one moved to another group (its x/y were relative to the old one), needs a spot unless it brings one.
    const parent = typeof n.parent === 'string' ? n.parent : undefined;
    const moved = !old || parent !== (old.parent === undefined ? undefined : follow(old.parent));
    if (moved && (typeof input.x !== 'number' || typeof input.y !== 'number')) Object.assign(n, autoPosition(nodes, parent));
    const node = sanitizeNode(n, linkOk, old);
    if (old && !sameRecord(node, old)) nodesChanged++;
    nodes.push(node);
  }
  const fromImport = new Set(planned.map((p) => p.id));
  for (const same of groupBy(nodes, (n) => `${n.parent ?? ''}\u0000${labelKey(n.label)}`).values()) {
    if (same.length > 1 && same.some((n) => fromImport.has(n.id))) {
      throw badRequest(`Two boxes labelled "${same[0].label}" would be in the same ${same[0].parent ? 'group' : 'top level'}`);
    }
  }

  // 5. The arrows.
  const pairKey = (source: string, target: string) => `${source}\u0000${target}`;
  const incoming = new Map<
    string,
    { id?: string; source: string; target: string; label: string; labelGiven: boolean; count: number; countGiven: boolean; used: boolean }
  >();
  for (const e of body.edges ?? []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw badRequest('Each edge must be an object');
    const source = resolve(e.source, 'The start of an arrow');
    const target = resolve(e.target, 'The end of an arrow');
    const label = blank(e.label) ? undefined : String(e.label).trim().slice(0, 200);
    const count = optionalNumber(e.count, 'count', 1, 1e6, true);
    const key = pairKey(source, target);
    const prev = incoming.get(key);
    if (prev) {
      prev.count = Math.min(1e6, prev.count + (count ?? 1));
      prev.countGiven = true; // listed more than once: the total is the count
      if (label !== undefined && !prev.label) {
        prev.label = label;
        prev.labelGiven = true;
      }
    } else {
      incoming.set(key, {
        id: blank(e.id) ? undefined : String(e.id),
        source,
        target,
        label: label ?? '',
        labelGiven: label !== undefined,
        count: count ?? 1,
        countGiven: count !== undefined,
        used: false,
      });
    }
  }
  const edgeCounts: Counts = { added: 0, updated: 0, removed: 0 };
  const edges: DiagramEdge[] = [];
  const edgeIds = new Set<string>();
  const push = (edge: DiagramEdge) => {
    if (edgeIds.has(edge.id)) edge.id = shortId();
    edgeIds.add(edge.id);
    edges.push(edge);
  };
  // Stored arrows first, so the ones the import lists again keep their ids.
  for (const stored of cur.edges) {
    const e = { ...stored, source: follow(stored.source), target: follow(stored.target) };
    const inc = incoming.get(pairKey(e.source, e.target));
    if (inc && !inc.used) {
      inc.used = true;
      const edge = sanitizeEdge({ label: inc.labelGiven ? inc.label : e.label, count: inc.countGiven ? inc.count : (e.count ?? null) }, e);
      if (!sameRecord(edge, stored)) edgeCounts.updated++;
      push(edge);
    } else if (!inc && !replace) push(sanitizeEdge({}, e));
    else edgeCounts.removed++;
  }
  for (const inc of incoming.values()) {
    if (inc.used) continue;
    edgeCounts.added++;
    push(sanitizeEdge({ id: inc.id, source: inc.source, target: inc.target, label: inc.label, count: inc.count }));
  }

  const settings = sanitizeSettings(body.settings, cur.settings);
  return {
    data: { nodes, edges: checkStructure(nodes, edges, true), settings },
    counts: {
      nodes: {
        added: planned.filter((p) => !p.old).length,
        updated: nodesChanged,
        removed: replace ? cur.nodes.length - taken.size : 0,
      } satisfies Counts,
      edges: edgeCounts,
      /** Whether the import changes the layout or the direction of the arrows. */
      settingsChanged: !sameRecord(settings, cur.settings),
    },
  };
}

export function registerDiagramRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, bus, access } = ctx;
  const changed = (id: number, actor: string) => bus.emit({ kind: 'diagrams', id, actor });
  const LINK_TABLES = { task: 'tasks', epoch: 'epochs', folder: 'folders', file: 'files' } as const;
  /** A diagram the caller may see, plus a check that node links stay inside its project. */
  const diagramIn = (req: FastifyRequest, raw: string) => {
    const id = parseId(raw, 'diagram');
    const pid = access.of(req, 'diagrams', id, `Diagram ${id}`).id;
    const linkOk: LinkCheck = (kind, linkId) =>
      !!db.prepare(`SELECT 1 FROM ${LINK_TABLES[kind]} WHERE id = ? AND project_id = ?`).get(linkId, pid);
    return { id, linkOk };
  };
  const checkVersion = (sent: number | undefined, current: number) => {
    if (sent !== undefined && sent !== current) throw conflict('Diagram was changed elsewhere. Reload to get the latest version.');
  };
  /** A parent given by id or label, as the id to store; null or "" means the top level. */
  const parentRef = (body: Input, find: (ref: unknown) => DiagramNode): Input => {
    if (!has(body, 'parent')) return body;
    return { ...body, parent: blank(body.parent) ? null : find(body.parent).id };
  };
  const newName = (name: string | undefined) => (name !== undefined ? nonEmpty(name, 'Name', 200) : undefined);

  app.get('/api/v1/diagrams', async (req) => ({
    layers: LAYERS,
    limits: DIAGRAM_LIMITS,
    diagrams: db
      .prepare(
        `SELECT id, name, version, updated_at AS updatedAt,
           COALESCE(json_array_length(data, '$.nodes'), 0) AS nodeCount,
           COALESCE(json_array_length(data, '$.edges'), 0) AS edgeCount
         FROM diagrams WHERE project_id = ? ORDER BY id`,
      )
      .all(access.current(req).id),
  }));

  app.post<{ Body: { name: string } }>(
    '/api/v1/diagrams',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 200 } } } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const pid = access.current(req).id;
      const res = db.prepare('INSERT INTO diagrams (project_id, name) VALUES (?, ?)').run(pid, nonEmpty(req.body.name, 'Name', 200));
      const id = Number(res.lastInsertRowid);
      changed(id, actor);
      reply.code(201);
      return load(db, id);
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/diagrams/:id', async (req) => load(db, diagramIn(req, req.params.id).id));

  /** Renames a diagram or changes its settings (layout, direction). */
  app.patch<{ Params: { id: string }; Body: { name?: string; settings?: unknown } }>(
    '/api/v1/diagrams/:id',
    { schema: { body: { type: 'object', properties: { name: { type: 'string', maxLength: 200 }, settings: { type: 'object' } } } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id } = diagramIn(req, req.params.id);
      tx(db, () => {
        const d = load(db, id);
        save(db, id, { ...d, settings: sanitizeSettings(req.body.settings, d.settings) }, newName(req.body.name));
      });
      changed(id, actor);
      return load(db, id);
    },
  );

  /**
   * Full replace (used by the web editor). Send the `version` you loaded; 409 if someone else saved since.
   * Send `schema: 2` to say the body has every field (groups, sizes, settings). Without it, the body comes
   * from an older page: fields it doesn't know about are kept from the stored diagram, and anything that
   * no longer fits (an arrow into a group it sits in, say) is dropped instead of refused.
   */
  app.put<{
    Params: { id: string };
    Body: { name?: string; version?: number; schema?: number; nodes: Input[]; edges: Input[]; settings?: unknown };
  }>(
    '/api/v1/diagrams/:id',
    {
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['nodes', 'edges'],
          properties: {
            name: { type: 'string', maxLength: 200 },
            version: { type: 'integer' },
            schema: { type: 'integer' },
            nodes: { type: 'array', maxItems: DIAGRAM_LIMITS.nodes, items: { type: 'object' } },
            edges: { type: 'array', maxItems: DIAGRAM_LIMITS.edges, items: { type: 'object' } },
            settings: { type: 'object' },
          },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, linkOk } = diagramIn(req, req.params.id);
      tx(db, () => {
        const cur = load(db, id);
        checkVersion(req.body.version, cur.version);
        const full = req.body.schema === 2;
        let inNodes = req.body.nodes;
        let inEdges = req.body.edges;
        if (!full) {
          const oldNodes = new Map(cur.nodes.map((n) => [n.id, n]));
          inNodes = inNodes.map((n) => {
            const old = oldNodes.get(String(n.id));
            if (!old) return n;
            const merged: Input = { ...n };
            for (const k of KEPT_NODE_FIELDS) if (!has(n, k) && old[k] !== undefined) merged[k] = old[k];
            return merged;
          });
          const oldCounts = new Map(cur.edges.filter((e) => e.count !== undefined).map((e) => [e.id, e.count]));
          inEdges = inEdges.map((e) => (!has(e, 'count') && oldCounts.has(String(e.id)) ? { ...e, count: oldCounts.get(String(e.id)) } : e));
        }
        const nodes = inNodes.map((n) => sanitizeNode(n, linkOk));
        const edges = checkStructure(nodes, inEdges.map((e) => sanitizeEdge(e)), full);
        const settings = full ? sanitizeSettings(req.body.settings, cur.settings) : cur.settings;
        save(db, id, { nodes, edges, settings }, newName(req.body.name));
      });
      changed(id, actor);
      return load(db, id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/diagrams/:id', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = diagramIn(req, req.params.id);
    if (!db.prepare('DELETE FROM diagrams WHERE id = ?').run(id).changes) throw notFound(`Diagram ${id}`);
    changed(id, actor);
    return { ok: true };
  });

  /** Adds, updates and (with mode "replace") removes many boxes and arrows in one go: one save, one version. */
  app.post<{ Params: { id: string }; Body: ImportBody }>(
    '/api/v1/diagrams/:id/import',
    {
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['nodes'],
          properties: {
            mode: { type: 'string', enum: ['replace', 'merge'] },
            version: { type: 'integer' },
            dryRun: { type: 'boolean' },
            nodes: { type: 'array', maxItems: DIAGRAM_LIMITS.nodes, items: { type: 'object' } },
            edges: { type: 'array', maxItems: DIAGRAM_LIMITS.edges, items: { type: 'object' } },
            settings: { type: 'object' },
          },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, linkOk } = diagramIn(req, req.params.id);
      const dryRun = req.body.dryRun === true;
      const result = tx(db, () => {
        const cur = load(db, id);
        checkVersion(req.body.version, cur.version);
        const { data, counts } = planImport(cur, req.body, linkOk);
        if (!dryRun) save(db, id, data);
        return { ...counts, version: load(db, id).version };
      });
      if (!dryRun) changed(id, actor);
      return { mode: req.body.mode ?? 'merge', dryRun, ...result };
    },
  );

  // ---- Granular operations (friendly for Claude / scripts) -------------------

  /** `parent` may be a node id or label. Labels are unique within a group (or at the top level). */
  app.post<{ Params: { id: string }; Body: Input }>(
    '/api/v1/diagrams/:id/nodes',
    { schema: { body: { type: 'object', required: ['label'] } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { id, linkOk } = diagramIn(req, req.params.id);
      const node = tx(db, () => {
        const d = load(db, id);
        const body = parentRef(req.body, nodeFinder(d.nodes));
        const parent = typeof body.parent === 'string' ? body.parent : undefined;
        const pos = typeof body.x === 'number' && typeof body.y === 'number' ? {} : autoPosition(d.nodes, parent);
        const node = sanitizeNode({ ...body, ...pos, id: blank(body.id) ? shortId() : body.id }, linkOk);
        if (d.nodes.some((n) => n.id === node.id)) throw conflict(`Node id "${node.id}" already exists`);
        assertUniqueAmongSiblings(d.nodes, node);
        d.nodes.push(node);
        checkStructure(d.nodes, d.edges, true);
        save(db, id, d);
        return node;
      });
      changed(id, actor);
      reply.code(201);
      return node;
    },
  );

  /** `:node` and `parent` may be ids or labels. Fields you leave out keep their values; null clears one. */
  app.patch<{ Params: { id: string; node: string }; Body: Input }>(
    '/api/v1/diagrams/:id/nodes/:node',
    { schema: { body: { type: 'object' } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, linkOk } = diagramIn(req, req.params.id);
      const node = tx(db, () => {
        const d = load(db, id);
        const find = nodeFinder(d.nodes);
        const cur = find(req.params.node);
        const next = sanitizeNode({ ...parentRef(req.body, find), id: cur.id }, linkOk, cur);
        if (next.parent !== cur.parent) {
          // Moved to another group: x/y were relative to the old one.
          if (!(typeof req.body.x === 'number' && typeof req.body.y === 'number')) {
            Object.assign(next, autoPosition(d.nodes.filter((n) => n.id !== cur.id), next.parent));
          }
          assertUniqueAmongSiblings(d.nodes, next);
        } else if (labelKey(next.label) !== labelKey(cur.label)) assertUniqueAmongSiblings(d.nodes, next);
        d.nodes = d.nodes.map((n) => (n.id === cur.id ? next : n));
        checkStructure(d.nodes, d.edges, true);
        save(db, id, d);
        return next;
      });
      changed(id, actor);
      return node;
    },
  );

  /**
   * Removes a box and its arrows. The boxes inside it move up a level, keeping their place on the canvas;
   * with `?withChildren=true` they are removed too, at every depth.
   */
  app.delete<{ Params: { id: string; node: string }; Querystring: { withChildren?: string } }>(
    '/api/v1/diagrams/:id/nodes/:node',
    async (req) => {
      const { actor } = requireAuth(req);
      const { id } = diagramIn(req, req.params.id);
      const withChildren = req.query.withChildren === 'true';
      const removed = tx(db, () => {
        const d = load(db, id);
        const cur = nodeFinder(d.nodes)(req.params.node);
        const gone = new Set([cur.id]);
        if (withChildren) {
          for (let grew = true; grew; ) {
            grew = false;
            for (const n of d.nodes) {
              if (n.parent !== undefined && gone.has(n.parent) && !gone.has(n.id)) {
                gone.add(n.id);
                grew = true;
              }
            }
          }
        } else {
          const there = new Set(d.nodes.filter((n) => n.parent === cur.parent && n.id !== cur.id).map((n) => labelKey(n.label)));
          const clash = d.nodes.find((n) => n.parent === cur.id && there.has(labelKey(n.label)));
          if (clash) {
            throw conflict(
              `"${clash.label}" would move up next to another box with that label. Rename one of them first, or delete "${cur.label}" with everything inside it (withChildren=true).`,
            );
          }
        }
        d.nodes = d.nodes
          .filter((n) => !gone.has(n.id))
          .map((n) => {
            if (n.parent !== cur.id) return n;
            const { parent: _inside, ...rest } = n;
            return { ...rest, ...(cur.parent !== undefined ? { parent: cur.parent } : {}), x: n.x + cur.x, y: n.y + cur.y };
          });
        d.edges = d.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
        save(db, id, d);
        return gone.size;
      });
      changed(id, actor);
      return { ok: true, removed };
    },
  );

  /** source/target may be node ids or labels. Joining two boxes that already have an arrow returns that arrow. */
  app.post<{ Params: { id: string }; Body: { source: string; target: string; label?: string; count?: number } }>(
    '/api/v1/diagrams/:id/edges',
    {
      schema: {
        body: {
          type: 'object',
          required: ['source', 'target'],
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            label: { type: 'string', maxLength: 200 },
            count: { type: 'number' },
          },
        },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { id } = diagramIn(req, req.params.id);
      const edge = tx(db, () => {
        const d = load(db, id);
        const find = nodeFinder(d.nodes);
        const s = find(req.body.source);
        const t = find(req.body.target);
        const existing = d.edges.find((e) => e.source === s.id && e.target === t.id);
        if (existing) return existing;
        const edge = sanitizeEdge({ source: s.id, target: t.id, label: req.body.label ?? '', count: req.body.count });
        d.edges = checkStructure(d.nodes, [...d.edges, edge], true);
        save(db, id, d);
        return edge;
      });
      changed(id, actor);
      reply.code(201);
      return edge;
    },
  );

  /** Changes an arrow's label or count (null resets the count to 1). */
  app.patch<{ Params: { id: string; edge: string }; Body: { label?: string; count?: number | null } }>(
    '/api/v1/diagrams/:id/edges/:edge',
    {
      schema: {
        body: {
          type: 'object',
          properties: { label: { type: 'string', maxLength: 200 }, count: { type: ['number', 'null'] } },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id } = diagramIn(req, req.params.id);
      const edge = tx(db, () => {
        const d = load(db, id);
        const cur = d.edges.find((e) => e.id === req.params.edge);
        if (!cur) throw notFound(`Edge "${req.params.edge}"`);
        const change: Input = {};
        if (has(req.body, 'label')) change.label = req.body.label;
        if (has(req.body, 'count')) change.count = req.body.count;
        const next = sanitizeEdge(change, cur);
        d.edges = d.edges.map((e) => (e.id === cur.id ? next : e));
        save(db, id, d);
        return next;
      });
      changed(id, actor);
      return edge;
    },
  );

  app.delete<{ Params: { id: string; edge: string } }>('/api/v1/diagrams/:id/edges/:edge', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = diagramIn(req, req.params.id);
    tx(db, () => {
      const d = load(db, id);
      const edges = d.edges.filter((e) => e.id !== req.params.edge);
      if (edges.length === d.edges.length) throw notFound(`Edge "${req.params.edge}"`);
      save(db, id, { ...d, edges });
    });
    changed(id, actor);
    return { ok: true };
  });
}

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import type { DB } from '../db.ts';
import { nowIso, tx } from '../db.ts';
import { requireAuth } from '../auth.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { has, nonEmpty, parseId } from '../lib/util.ts';

export interface DiagramNode {
  id: string;
  label: string;
  description: string;
  layer: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  link?: { kind: 'task' | 'epoch' | 'folder' | 'file'; id: number } | null;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

interface DiagramData {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** Suggested layers; any string is accepted. The UI colours these. */
export const LAYERS = ['core', 'gameplay', 'ui', 'data', 'services', 'tools', 'external'];

const shortId = () => crypto.randomBytes(5).toString('hex');

function load(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id) as
    | { id: number; name: string; data: string; version: number; created_at: string; updated_at: string }
    | undefined;
  if (!row) throw notFound(`Diagram ${id}`);
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(JSON.parse(row.data) as DiagramData),
  };
}

function save(db: DB, id: number, data: DiagramData, name?: string): void {
  db.prepare(
    'UPDATE diagrams SET data = ?, name = COALESCE(?, name), version = version + 1, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(data), name ?? null, nowIso(), id);
}

/** Whether a node may link to that item (it must be in the diagram's project). */
type LinkCheck = (kind: 'task' | 'epoch' | 'folder' | 'file', id: number) => boolean;

function sanitizeNode(n: Partial<DiagramNode>, linkOk: LinkCheck, fallback?: DiagramNode): DiagramNode {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const node: DiagramNode = {
    id: String(n.id ?? fallback?.id ?? shortId()).slice(0, 64),
    label: String(n.label ?? fallback?.label ?? '').slice(0, 200),
    description: String(n.description ?? fallback?.description ?? '').slice(0, 5000),
    layer: String(n.layer ?? fallback?.layer ?? 'core').slice(0, 40),
    x: num(n.x, fallback?.x ?? 0),
    y: num(n.y, fallback?.y ?? 0),
  };
  const w = n.width ?? fallback?.width;
  const h = n.height ?? fallback?.height;
  if (typeof w === 'number') node.width = w;
  if (typeof h === 'number') node.height = h;
  const link = has(n, 'link') ? n.link : fallback?.link;
  if (link && ['task', 'epoch', 'folder', 'file'].includes(link.kind) && Number.isInteger(link.id) && linkOk(link.kind, link.id)) {
    node.link = { kind: link.kind, id: link.id };
  }
  if (!node.label) throw badRequest('Node label is required');
  return node;
}

function validate(data: DiagramData, linkOk: LinkCheck): DiagramData {
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw badRequest('nodes and edges must be arrays');
  const nodes = data.nodes.map((n) => sanitizeNode(n, linkOk));
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) throw badRequest('Duplicate node ids');
  const edges = data.edges
    .filter((e) => ids.has(String(e.source)) && ids.has(String(e.target)))
    .map((e) => ({
      id: String(e.id ?? shortId()).slice(0, 64),
      source: String(e.source),
      target: String(e.target),
      label: String(e.label ?? '').slice(0, 200),
    }));
  return { nodes, edges };
}

/** Finds a node by id, or by label (case-insensitive) for convenience in API/CLI use. */
function findNode(data: DiagramData, ref: string): DiagramNode {
  const n = data.nodes.find((x) => x.id === ref) ?? data.nodes.find((x) => x.label.toLowerCase() === ref.toLowerCase());
  if (!n) throw notFound(`Node "${ref}"`);
  return n;
}

/** Places a new node to the right of the existing layout when no position is given. */
function autoPosition(data: DiagramData): { x: number; y: number } {
  if (!data.nodes.length) return { x: 0, y: 0 };
  const maxX = Math.max(...data.nodes.map((n) => n.x));
  const col = data.nodes.filter((n) => n.x === maxX);
  if (col.length < 5) return { x: maxX, y: Math.max(...col.map((n) => n.y)) + 120 };
  return { x: maxX + 260, y: 0 };
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

  app.get('/api/v1/diagrams', async (req) => ({
    layers: LAYERS,
    diagrams: db
      .prepare('SELECT id, name, version, updated_at AS updatedAt FROM diagrams WHERE project_id = ? ORDER BY id')
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

  /** Full replace (used by the web editor). Send the `version` you loaded; 409 if someone else saved since. */
  app.put<{ Params: { id: string }; Body: { name?: string; version?: number; nodes: DiagramNode[]; edges: DiagramEdge[] } }>(
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
            nodes: { type: 'array', maxItems: 2000, items: { type: 'object' } },
            edges: { type: 'array', maxItems: 5000, items: { type: 'object' } },
          },
        },
      },
    },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, linkOk } = diagramIn(req, req.params.id);
      tx(db, () => {
        const cur = load(db, id);
        if (req.body.version !== undefined && req.body.version !== cur.version) {
          throw conflict('Diagram was changed elsewhere. Reload to get the latest version.');
        }
        const data = validate({ nodes: req.body.nodes, edges: req.body.edges }, linkOk);
        save(db, id, data, req.body.name !== undefined ? nonEmpty(req.body.name, 'Name', 200) : undefined);
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

  // ---- Granular operations (friendly for Claude / scripts) -------------------

  app.post<{ Params: { id: string }; Body: Partial<DiagramNode> }>(
    '/api/v1/diagrams/:id/nodes',
    { schema: { body: { type: 'object', required: ['label'] } } },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { id, linkOk } = diagramIn(req, req.params.id);
      const node = tx(db, () => {
        const d = load(db, id);
        if (d.nodes.some((n) => n.label.toLowerCase() === String(req.body.label).toLowerCase())) {
          throw conflict(`A node labelled "${req.body.label}" already exists; update it instead`);
        }
        const pos = req.body.x === undefined || req.body.y === undefined ? autoPosition(d) : { x: req.body.x, y: req.body.y };
        const node = sanitizeNode({ ...req.body, ...pos, id: req.body.id ?? shortId() }, linkOk);
        if (d.nodes.some((n) => n.id === node.id)) throw conflict(`Node id "${node.id}" already exists`);
        d.nodes.push(node);
        save(db, id, { nodes: d.nodes, edges: d.edges });
        return node;
      });
      changed(id, actor);
      reply.code(201);
      return node;
    },
  );

  app.patch<{ Params: { id: string; node: string }; Body: Partial<DiagramNode> }>(
    '/api/v1/diagrams/:id/nodes/:node',
    { schema: { body: { type: 'object' } } },
    async (req) => {
      const { actor } = requireAuth(req);
      const { id, linkOk } = diagramIn(req, req.params.id);
      const node = tx(db, () => {
        const d = load(db, id);
        const cur = findNode(d, req.params.node);
        const next = sanitizeNode({ ...req.body, id: cur.id }, linkOk, cur);
        d.nodes = d.nodes.map((n) => (n.id === cur.id ? next : n));
        save(db, id, { nodes: d.nodes, edges: d.edges });
        return next;
      });
      changed(id, actor);
      return node;
    },
  );

  app.delete<{ Params: { id: string; node: string } }>('/api/v1/diagrams/:id/nodes/:node', async (req) => {
    const { actor } = requireAuth(req);
    const { id } = diagramIn(req, req.params.id);
    tx(db, () => {
      const d = load(db, id);
      const cur = findNode(d, req.params.node);
      save(db, id, {
        nodes: d.nodes.filter((n) => n.id !== cur.id),
        edges: d.edges.filter((e) => e.source !== cur.id && e.target !== cur.id),
      });
    });
    changed(id, actor);
    return { ok: true };
  });

  /** source/target may be node ids or labels. */
  app.post<{ Params: { id: string }; Body: { source: string; target: string; label?: string } }>(
    '/api/v1/diagrams/:id/edges',
    {
      schema: {
        body: {
          type: 'object',
          required: ['source', 'target'],
          properties: { source: { type: 'string' }, target: { type: 'string' }, label: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const { actor } = requireAuth(req);
      const { id } = diagramIn(req, req.params.id);
      const edge = tx(db, () => {
        const d = load(db, id);
        const s = findNode(d, req.body.source);
        const t = findNode(d, req.body.target);
        const existing = d.edges.find((e) => e.source === s.id && e.target === t.id);
        if (existing) return existing;
        const edge = { id: shortId(), source: s.id, target: t.id, label: req.body.label ?? '' };
        d.edges.push(edge);
        save(db, id, { nodes: d.nodes, edges: d.edges });
        return edge;
      });
      changed(id, actor);
      reply.code(201);
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
      save(db, id, { nodes: d.nodes, edges });
    });
    changed(id, actor);
    return { ok: true };
  });
}

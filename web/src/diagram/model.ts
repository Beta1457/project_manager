/**
 * The pure logic behind the architecture diagram page: the diagram's data types, which boxes are visible
 * (groups open or shut, layers hidden), arrows added up between what is visible, box sizes, the graph handed
 * to the ELK layout engine and the layout read back from it. No React, DOM or imports, so the server's test
 * runner can check it too (test/diagram-view.test.ts).
 */

// ---- What the server stores ------------------------------------------------------------------------------

export type LinkKind = 'task' | 'epoch' | 'folder' | 'file';

export interface DiagramNode {
  id: string;
  label: string;
  description: string;
  layer: string;
  /** Position inside the parent box (or on the canvas). Only the manual layout uses it. */
  x: number;
  y: number;
  /** A fixed size. Without one, the size comes from the text and the weight. */
  width?: number;
  height?: number;
  link?: { kind: LinkKind; id: number } | null;
  /** The box this one sits inside. A box with boxes inside it is a group. */
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

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Point, Size {}

// ---- What the viewer has chosen to see (kept per diagram in the browser) ------------------------------------

export interface ViewState {
  /** Whether groups start open. The groups listed in `flipped` are the other way round. */
  openByDefault: boolean;
  flipped: string[];
  /** Layers whose boxes are left out. */
  hiddenLayers: string[];
  /** Puts the top-level boxes into one made-up group per layer. */
  byLayer: boolean;
}

/** Above this many boxes a diagram opens folded up, so the first picture is an overview. */
export const BIG_DIAGRAM = 150;

/** How a diagram looks the first time it is opened: small ones fully open, big ones folded up. */
export function defaultView(nodes: DiagramNode[]): ViewState {
  const parents = new Set<string>();
  for (const n of nodes) if (n.parent !== undefined) parents.add(n.parent);
  if (parents.size) {
    const leaves = nodes.filter((n) => !parents.has(n.id)).length;
    return { openByDefault: leaves <= BIG_DIAGRAM, flipped: [], hiddenLayers: [], byLayer: false };
  }
  // No groups of its own: a big one is folded into its layers instead.
  const big = nodes.length > BIG_DIAGRAM;
  return { openByDefault: !big, flipped: [], hiddenLayers: [], byLayer: big };
}

export const isOpen = (view: ViewState, id: string) => view.openByDefault !== view.flipped.includes(id);

export function toggleOpen(view: ViewState, id: string): ViewState {
  const flipped = view.flipped.includes(id) ? view.flipped.filter((f) => f !== id) : [...view.flipped, id];
  return { ...view, flipped };
}

export const openAll = (view: ViewState, open: boolean): ViewState => ({ ...view, openByDefault: open, flipped: [] });

const LAYER_GROUP = '#layer:';
/** The id of the made-up group that holds a layer's boxes when grouping by layer. */
export const layerGroupId = (layer: string) => LAYER_GROUP + layer;
export const isLayerGroup = (id: string) => id.startsWith(LAYER_GROUP);

// ---- What is visible -------------------------------------------------------------------------------------

/** box: a plain box. closed: a group shown shut, as one box. group: an open group with its boxes inside it. */
export type ViewKind = 'box' | 'closed' | 'group';

export interface ViewNode {
  id: string;
  kind: ViewKind;
  /** The stored box; null for a group made up for "group by layer". */
  node: DiagramNode | null;
  label: string;
  layer: string;
  /** The visible group this one is drawn inside. */
  parent?: string;
  /** How many boxes are inside it, at every depth (not counting hidden layers). */
  inside: number;
  /** Its weight; for a closed group without one of its own, the total of what is inside. */
  weight?: number;
}

export interface ViewEdge {
  /** The stored arrow's id when it stands for exactly one (the one counted); otherwise "agg:<source>><target>". */
  id: string;
  source: string;
  target: string;
  /** What to write on the arrow, e.g. "uses ×42". */
  text: string;
  count: number;
  /** The stored arrows it stands for (the ones counted). */
  members: DiagramEdge[];
}

export interface View {
  /** Every visible box and group, each group before the boxes inside it. */
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** Stored box id -> the visible box it is drawn as: itself, or the closed group it is folded into. */
  shownAs: Map<string, string>;
  /** Boxes left out because their layer is hidden. */
  hiddenCount: number;
  /** Open groups the automatic layout arranges on their own (see packedGroups). Empty for the manual layout. */
  packed: Set<string>;
}

interface Item {
  id: string;
  node: DiagramNode | null;
  label: string;
  layer: string;
  children: Item[];
}

/**
 * Works out what to draw: which boxes are visible, which groups are open, and the arrows between them.
 * `pack` (the automatic layout) arranges big open groups on their own, with arrows across their border summed.
 */
export function buildView(nodes: DiagramNode[], edges: DiagramEdge[], view: ViewState, pack = false): View {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string | undefined, DiagramNode[]>();
  for (const n of nodes) {
    const p = n.parent !== undefined && byId.has(n.parent) ? n.parent : undefined;
    const list = kids.get(p);
    if (list) list.push(n);
    else kids.set(p, [n]);
  }
  const item = (n: DiagramNode): Item => ({ id: n.id, node: n, label: n.label, layer: n.layer, children: (kids.get(n.id) ?? []).map(item) });
  let roots = (kids.get(undefined) ?? []).map(item);
  if (view.byLayer) {
    const groups = new Map<string, Item>();
    for (const r of roots) {
      let g = groups.get(r.layer);
      if (!g) groups.set(r.layer, (g = { id: layerGroupId(r.layer), node: null, label: r.layer, layer: r.layer, children: [] }));
      g.children.push(r);
    }
    roots = [...groups.values()];
  }

  const flipped = new Set(view.flipped);
  const open = (id: string) => view.openByDefault !== flipped.has(id);
  const hiddenLayers = new Set(view.hiddenLayers);
  const visible = (it: Item) => !hiddenLayers.has(it.layer);
  const countAll = (it: Item): number => it.children.reduce((sum, c) => sum + 1 + countAll(c), 0);
  const countVisible = (it: Item): number => it.children.reduce((sum, c) => sum + (visible(c) ? 1 + countVisible(c) : 0), 0);
  const weightOf = (it: Item): number | undefined => {
    if (it.node?.weight !== undefined) return it.node.weight;
    let total: number | undefined;
    for (const c of it.children) {
      const w = visible(c) ? weightOf(c) : undefined;
      if (w !== undefined) total = (total ?? 0) + w;
    }
    return total;
  };

  const out: ViewNode[] = [];
  const shownAs = new Map<string, string>();
  let hiddenCount = 0;
  const hide = (it: Item) => {
    hiddenCount += (it.node ? 1 : 0) + countAll(it);
  };
  const push = (it: Item, kind: ViewKind, parent: string | undefined, inside: number, weight: number | undefined) => {
    const v: ViewNode = { id: it.id, kind, node: it.node, label: it.label, layer: it.layer, inside };
    if (parent !== undefined) v.parent = parent;
    if (weight !== undefined) v.weight = weight;
    out.push(v);
  };
  /** Draws everything inside `it` as the closed group `into`; returns how many boxes that is. */
  const fold = (it: Item, into: string): number => {
    shownAs.set(it.id, into);
    let inside = 0;
    for (const c of it.children) {
      if (visible(c)) inside += 1 + fold(c, into);
      else hide(c);
    }
    return inside;
  };
  const show = (it: Item, parent: string | undefined) => {
    shownAs.set(it.id, it.id);
    const shownKids = it.children.filter(visible);
    for (const c of it.children) if (!visible(c)) hide(c);
    if (!it.children.length) push(it, 'box', parent, 0, it.node?.weight);
    else if (open(it.id) && shownKids.length) {
      push(it, 'group', parent, countVisible(it), it.node?.weight);
      for (const c of shownKids) show(c, it.id);
    } else {
      // Shut, or open with nothing left to show inside: one box standing for everything in it.
      let inside = 0;
      for (const c of shownKids) inside += 1 + fold(c, it.id);
      push(it, 'closed', parent, inside, weightOf(it));
    }
  };
  for (const r of roots) {
    if (visible(r)) show(r, undefined);
    else hide(r);
  }
  const packed = pack ? packedGroups(out, edges, shownAs) : new Set<string>();
  return { nodes: out, edges: bundleEdges(out, edges, shownAs, packed), shownAs, hiddenCount, packed };
}

/** An open group with more boxes than this directly inside it is arranged on its own (automatic layout)… */
export const PACK_GROUP_ABOVE = 40;
/** …and so is one with more boxes than this that no arrow joins to anything else in the group. */
export const PACK_LOOSE_ABOVE = 8;

/**
 * The open groups the automatic layout arranges on their own: big ones, ones with many loose boxes, every open
 * group when more than BIG_DIAGRAM boxes are visible, and every open group inside one of those. Arranged with
 * everything else, such a group becomes one very long row (its loose boxes, and the boxes whose arrows lead
 * out of it, all line up); on its own, its unconnected parts are packed into a block. ELK can't route arrows
 * across its border then, so those are drawn from the border, summed (bundleEdges); a selected box shows its
 * own (revealedEdges).
 */
function packedGroups(nodes: ViewNode[], edges: DiagramEdge[], shownAs: Map<string, string>): Set<string> {
  const parentOf = new Map(nodes.map((v) => [v.id, v.parent]));
  const upFrom = (id: string) => {
    const out = [id];
    for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) out.push(p);
    return out;
  };
  // An arrow joins the two boxes just inside the innermost group that holds both of its ends.
  const joined = new Set<string>();
  for (const e of edges) {
    const s = shownAs.get(e.source);
    const t = shownAs.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const fromS = upFrom(s);
    const fromT = upFrom(t);
    const i = fromS.findIndex((id) => fromT.includes(id));
    const j = i > 0 ? fromT.indexOf(fromS[i]) : -1;
    if (j > 0) joined.add(fromS[i - 1]).add(fromT[j - 1]);
  }
  const inside = new Map<string, number>();
  const loose = new Map<string, number>();
  for (const v of nodes) {
    if (v.parent === undefined) continue;
    inside.set(v.parent, (inside.get(v.parent) ?? 0) + 1);
    if (!joined.has(v.id)) loose.set(v.parent, (loose.get(v.parent) ?? 0) + 1);
  }
  const all = nodes.length > BIG_DIAGRAM;
  const packed = new Set<string>();
  // Each group comes before what is inside it, so its own group has been decided already.
  for (const v of nodes) {
    if (v.kind !== 'group') continue;
    const crowded = (inside.get(v.id) ?? 0) > PACK_GROUP_ABOVE || (loose.get(v.id) ?? 0) > PACK_LOOSE_ABOVE;
    if (all || crowded || (v.parent !== undefined && packed.has(v.parent))) packed.add(v.id);
  }
  return packed;
}

/**
 * Arrows between visible boxes. An arrow whose ends are folded into closed groups is drawn between those
 * groups, and one leaving a packed group starts (or ends) at that group's border; arrows between the same
 * two visible boxes become one, whose count is their total. An arrow stored between exactly those two boxes
 * says it all, so the ones from inside them aren't added to it.
 */
function bundleEdges(nodes: ViewNode[], edges: DiagramEdge[], shownAs: Map<string, string>, packed: Set<string>): ViewEdge[] {
  const parentOf = new Map(nodes.map((v) => [v.id, v.parent]));
  const within = (id: string, group: string) => {
    for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) if (p === group) return true;
    return false;
  };
  /** The outermost packed group holding `id` but not `other`, or `id` itself if there is none. */
  const border = (id: string, other: string) => {
    let at = id;
    for (let p = parentOf.get(id); p !== undefined && !within(other, p); p = parentOf.get(p)) if (packed.has(p)) at = p;
    return at;
  };
  const bundles = new Map<string, { source: string; target: string; members: DiagramEdge[]; direct: DiagramEdge[] }>();
  for (const e of edges) {
    let s = shownAs.get(e.source);
    let t = shownAs.get(e.target);
    if (s === undefined || t === undefined) continue;
    // Inside one box (unless it really is an arrow from a box to itself), or between a box and its own group.
    if (s === t ? e.source !== e.target || s !== e.source : within(s, t) || within(t, s)) continue;
    if (packed.size) [s, t] = [border(s, t), border(t, s)];
    const key = `${s}\u0000${t}`;
    let b = bundles.get(key);
    if (!b) bundles.set(key, (b = { source: s, target: t, members: [], direct: [] }));
    b.members.push(e);
    if (e.source === s && e.target === t) b.direct.push(e);
  }
  const out: ViewEdge[] = [];
  for (const b of bundles.values()) {
    const counted = b.direct.length ? b.direct : b.members;
    const count = counted.reduce((sum, e) => sum + (e.count ?? 1), 0);
    const label = commonLabel(counted);
    out.push({
      id: counted.length === 1 ? counted[0].id : `agg:${b.source}>${b.target}`,
      source: b.source,
      target: b.target,
      text: count > 1 ? (label ? `${label} ×${count}` : `×${count}`) : label,
      count,
      members: counted,
    });
  }
  return out;
}

/**
 * The arrows of the visible box `id` that are drawn summed at a packed group's border, each as an arrow of its
 * own between the box and what is drawn for the other end (shown while the box is selected). Ids start "rev:".
 */
export function revealedEdges(view: View, edges: DiagramEdge[], id: string): ViewEdge[] {
  if (!view.packed.size) return [];
  const drawn = new Set(view.edges.map((e) => `${e.source}\u0000${e.target}`));
  const mine = edges.filter((e) => view.shownAs.get(e.source) === id || view.shownAs.get(e.target) === id);
  return bundleEdges(view.nodes, mine, view.shownAs, new Set())
    .filter((e) => !drawn.has(`${e.source}\u0000${e.target}`))
    .map((e) => ({ ...e, id: `rev:${e.source}>${e.target}` }));
}

/** The label most of the arrows (weighted by their counts) carry. */
function commonLabel(edges: DiagramEdge[]): string {
  const tally = new Map<string, number>();
  let best = '';
  let bestCount = 0;
  for (const e of edges) {
    const label = e.label.trim();
    if (!label) continue;
    const n = (tally.get(label) ?? 0) + (e.count ?? 1);
    tally.set(label, n);
    if (n > bestCount) {
      best = label;
      bestCount = n;
    }
  }
  return best;
}

/** Stroke width for an arrow standing for `count` connections. */
export const arrowWidth = (count: number) => Math.min(6, 1.25 + Math.log2(Math.max(1, count)));

// ---- Box sizes -------------------------------------------------------------------------------------------

/**
 * Box measurements in px. The page sets them as CSS variables on the diagram, so the boxes drawn are exactly
 * the size the layout planned for.
 */
export const BOX = {
  minWidth: 140,
  maxWidth: 280,
  padX: 10,
  padY: 6,
  border: 2,
  /** The small line on top: layer, link, "▸ 12 inside". */
  caption: 14,
  labelLine: 17,
  pathLine: 15,
  roleLine: 16,
  /** The most a weight widens a box: a box this many times squared heavier than the typical one, or more. */
  maxScale: 2.5,
  groupHeader: 34,
  groupPad: 14,
  groupMinWidth: 180,
  edgeLabelHeight: 16,
} as const;

export type TextStyle = 'caption' | 'label' | 'path' | 'role' | 'header' | 'edge';
/** Width in px of `text` drawn in the given style. The page measures with a canvas; tests use a stand-in. */
export type Measure = (text: string, style: TextStyle) => number;

/** The one-line role, or for boxes from before roles existed, the first line of the description. */
export function roleOf(node: DiagramNode | null): string {
  if (!node) return '';
  const firstLine = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200);
  return firstLine(node.role ?? '') || firstLine(node.description);
}

/** The small line at the top of a box. */
export function captionOf(v: ViewNode): string {
  const parts = [v.layer];
  if (v.node?.link) parts.push('🔗');
  if (v.kind === 'closed') parts.push(`▸ ${v.inside} inside`);
  return parts.join(' · ');
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The size a box needs for its text: the caption, up to two lines of label, the path, up to two lines of role. */
export function textSize(v: ViewNode, measure: Measure): Size {
  const role = roleOf(v.node);
  const path = v.node?.path ?? '';
  const labelW = measure(v.label, 'label');
  const roleW = role ? measure(role, 'role') : 0;
  const chrome = 2 * (BOX.padX + BOX.border);
  const want = Math.max(labelW, path ? measure(path, 'path') : 0, roleW, measure(captionOf(v).toUpperCase(), 'caption'));
  // A little room to spare: the browser may lay text out a fraction of a pixel wider than it was measured.
  const width = clamp(Math.ceil(want + chrome + 2), BOX.minWidth, BOX.maxWidth);
  const lines = (w: number) => (w > width - chrome ? 2 : 1);
  const height =
    2 * (BOX.padY + BOX.border) + BOX.caption + lines(labelW) * BOX.labelLine + (path ? BOX.pathLine : 0) + (role ? lines(roleW) * BOX.roleLine : 0);
  return { width, height };
}

/**
 * Sizes of the visible boxes (not open groups, which the layout sizes to fit what is inside). A box heavier
 * than the typical (median) weighted box in view is wider by the square root of how many times heavier, up to
 * BOX.maxScale; typical and lighter boxes are as wide as their text needs. A size stored on a plain box wins.
 */
export function boxSizes(view: View, measure: Measure): Map<string, Size> {
  const weights = view.nodes
    .filter((v) => v.kind !== 'group' && v.weight !== undefined && v.weight > 0)
    .map((v) => v.weight as number)
    .sort((a, b) => a - b);
  const typical = weights.length ? weights[Math.floor((weights.length - 1) / 2)] : 0;
  const out = new Map<string, Size>();
  for (const v of view.nodes) {
    if (v.kind === 'group') continue;
    const base = textSize(v, measure);
    const scale = v.weight !== undefined && typical > 0 && v.weight > typical ? Math.min(BOX.maxScale, Math.sqrt(v.weight / typical)) : 1;
    // A stored size on a group is its size when open (manual layout); shut, it is just a box.
    const stored = v.kind === 'box' ? v.node : null;
    out.set(v.id, {
      width: stored?.width ?? Math.round(base.width * scale),
      height: stored?.height ?? Math.round(base.height * (1 + (scale - 1) / 2)),
    });
  }
  return out;
}

/** The narrowest an open group can be and still show its header: name, count and the shut button. */
export function groupMinWidth(v: ViewNode, measure: Measure): number {
  const header = measure(v.label, 'header') + measure(String(v.inside), 'caption') + 64;
  return Math.max(BOX.groupMinWidth, Math.ceil(header + 2 * BOX.groupPad));
}

// ---- Automatic layout (ELK) ------------------------------------------------------------------------------

export interface ElkLabel {
  text: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}
export interface ElkSection {
  startPoint: Point;
  endPoint: Point;
  bendPoints?: Point[];
}
export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkLabel[];
  sections?: ElkSection[];
}
export interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdge[];
}

/** With more labelled arrows than this, labels show only on hover or selection and take no room in the layout (with ~150 they double its size). */
export const MAX_LAYOUT_LABELS = 100;
export const ELK_ROOT = '#root';

/** How ELK arranges one level: the whole diagram (`count` boxes), or a packed group on its own (`count` inside). */
function layeredOptions(count: number, direction: DiagramSettings['direction']): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': '28',
    'elk.layered.spacing.nodeNodeBetweenLayers': '56',
    'elk.spacing.edgeNode': '16',
    'elk.spacing.edgeEdge': '8',
    'elk.layered.thoroughness': count > BIG_DIAGRAM ? '3' : '7',
    'elk.edgeLabels.placement': 'CENTER',
  };
}

function rootOptions(count: number, direction: DiagramSettings['direction']): Record<string, string> {
  return {
    ...layeredOptions(count, direction),
    // Keeps the boxes in the order they are stored where that costs no crossings, so small changes keep the
    // picture familiar. (Not in packed groups: with many arrows it makes ELK ten times slower.)
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    // Boxes relative to their group (as React Flow places children); arrows and labels relative to the canvas.
    'elk.json.shapeCoords': 'PARENT',
    'elk.json.edgeCoords': 'ROOT',
    'elk.padding': '[top=16,left=16,bottom=16,right=16]',
  };
}

/** A packed group is arranged on its own, its unconnected parts side by side in a block rather than one long row. */
function packedOptions(count: number, direction: DiagramSettings['direction']): Record<string, string> {
  return {
    ...layeredOptions(count, direction),
    'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
    'elk.separateConnectedComponents': 'true',
    'elk.aspectRatio': '1.6',
    'elk.spacing.componentComponent': '40',
  };
}

/** Whether arrow labels take part in the layout (with very many, they only show on hover). */
export const labelsInLayout = (view: View) => view.edges.filter((e) => e.text).length <= MAX_LAYOUT_LABELS;

/** The graph ELK lays out: visible boxes nested as drawn, each arrow in the innermost group holding both ends. */
export function toElk(view: View, sizes: Map<string, Size>, direction: DiagramSettings['direction'], measure: Measure): ElkNode {
  const root: ElkNode = { id: ELK_ROOT, layoutOptions: rootOptions(view.nodes.length, direction), children: [], edges: [] };
  const elkNodes = new Map<string, ElkNode>([[ELK_ROOT, root]]);
  const pad = BOX.groupPad;
  for (const v of view.nodes) {
    const n: ElkNode =
      v.kind === 'group'
        ? {
            id: v.id,
            layoutOptions: {
              ...(view.packed.has(v.id) ? packedOptions(view.nodes.filter((c) => c.parent === v.id).length, direction) : {}),
              'elk.padding': `[top=${BOX.groupHeader + pad},left=${pad},bottom=${pad},right=${pad}]`,
              'elk.nodeSize.constraints': 'MINIMUM_SIZE',
              'elk.nodeSize.minimum': `(${groupMinWidth(v, measure)}, ${BOX.groupHeader + 40})`,
            },
            children: [],
            edges: [],
          }
        : { id: v.id, ...(sizes.get(v.id) ?? { width: BOX.minWidth, height: 60 }) };
    const holder = elkNodes.get(v.parent ?? ELK_ROOT) ?? root;
    (holder.children ??= []).push(n);
    elkNodes.set(v.id, n);
  }
  const parentOf = new Map(view.nodes.map((v) => [v.id, v.parent]));
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) out.push(p);
    return out;
  };
  const withLabels = labelsInLayout(view);
  for (const e of view.edges) {
    const aboveTarget = new Set(ancestors(e.target));
    const lca = e.source === e.target ? parentOf.get(e.source) : ancestors(e.source).find((p) => aboveTarget.has(p));
    const holder = elkNodes.get(lca ?? ELK_ROOT) ?? root;
    const edge: ElkEdge = { id: e.id, sources: [e.source], targets: [e.target] };
    if (withLabels && e.text) edge.labels = [{ text: e.text, width: Math.ceil(measure(e.text, 'edge')) + 8, height: BOX.edgeLabelHeight }];
    (holder.edges ??= []).push(edge);
  }
  return root;
}

export interface EdgeRoute {
  /** The arrow's corners from start to end, in canvas coordinates. */
  points: Point[];
  /** Where ELK put the label (its top-left corner), in canvas coordinates. */
  label?: Rect;
}

export interface Layout {
  /** Every visible box: position inside its group (or on the canvas) and size. */
  nodes: Map<string, Rect>;
  edges: Map<string, EdgeRoute>;
  width: number;
  height: number;
}

/** Reads ELK's answer back: box positions (relative to their group), arrow routes and labels (canvas coordinates). */
export function fromElk(root: ElkNode): Layout {
  const nodes = new Map<string, Rect>();
  const edges = new Map<string, EdgeRoute>();
  const walk = (n: ElkNode) => {
    for (const e of n.edges ?? []) {
      const points: Point[] = [];
      for (const s of e.sections ?? []) {
        for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
          const last = points[points.length - 1];
          if (!last || last.x !== p.x || last.y !== p.y) points.push({ x: p.x, y: p.y });
        }
      }
      const l = e.labels?.[0];
      const route: EdgeRoute = { points };
      if (l && l.x !== undefined && l.y !== undefined) route.label = { x: l.x, y: l.y, width: l.width, height: l.height };
      edges.set(e.id, route);
    }
    for (const c of n.children ?? []) {
      nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 });
      walk(c);
    }
  };
  walk(root);
  return { nodes, edges, width: root.width ?? 0, height: root.height ?? 0 };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** An SVG path through the points with rounded corners (at most `radius`, less where segments are short). */
export function roundedPath(points: Point[], radius = 8): string {
  if (points.length < 2) return '';
  const toward = (from: Point, to: Point, d: number): Point => {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: round1(from.x + ((to.x - from.x) * d) / len), y: round1(from.y + ((to.y - from.y) * d) / len) };
  };
  let d = `M${round1(points[0].x)},${round1(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, Math.hypot(p.x - a.x, p.y - a.y) / 2, Math.hypot(b.x - p.x, b.y - p.y) / 2);
    const p1 = toward(p, a, r);
    const p2 = toward(p, b, r);
    d += ` L${p1.x},${p1.y} Q${round1(p.x)},${round1(p.y)} ${p2.x},${p2.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${round1(last.x)},${round1(last.y)}`;
}

/** The point halfway along a route, for a label ELK didn't place. */
export function midpoint(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (left <= seg && seg > 0) {
      const t = left / seg;
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
    }
    left -= seg;
  }
  return points[points.length - 1];
}

// ---- Manual layout ---------------------------------------------------------------------------------------

export type Side = 'top' | 'right' | 'bottom' | 'left';

/** Which sides of two boxes an arrow should leave and enter by, so it takes the short way between them. */
export function pickSides(a: Rect, b: Rect): { source: Side; target: Side } {
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  if (gapX > gapY) return b.x + b.width / 2 >= a.x + a.width / 2 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  return b.y + b.height / 2 >= a.y + a.height / 2 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}

export const GRID = 16;
export const snap = (v: number, grid = GRID) => Math.round(v / grid) * grid;
const snapUp = (v: number, grid = GRID) => Math.ceil(v / grid) * grid;

/**
 * Box sizes for the manual layout: plain and closed boxes as for the automatic one. An open group is its stored
 * size, but never smaller than what is inside it needs; that smallest size (`fits`) is also the limit for
 * resizing it.
 */
export function manualSizes(view: View, sizes: Map<string, Size>, positions: Map<string, Point>, measure: Measure) {
  const out = new Map(sizes);
  const fits = new Map<string, Size>();
  const children = new Map<string, ViewNode[]>();
  for (const v of view.nodes) {
    if (v.parent === undefined) continue;
    const list = children.get(v.parent);
    if (list) list.push(v);
    else children.set(v.parent, [v]);
  }
  // Inner groups first, so an outer group knows how big they are.
  for (const v of [...view.nodes].reverse()) {
    if (v.kind !== 'group') continue;
    let right = 0;
    let bottom = 0;
    for (const c of children.get(v.id) ?? []) {
      const p = positions.get(c.id) ?? { x: 0, y: 0 };
      const s = out.get(c.id) ?? { width: BOX.minWidth, height: 60 };
      right = Math.max(right, p.x + s.width);
      bottom = Math.max(bottom, p.y + s.height);
    }
    const fit = {
      width: snapUp(Math.max(groupMinWidth(v, measure), right + BOX.groupPad)),
      height: snapUp(Math.max(BOX.groupHeader + 40, bottom + BOX.groupPad)),
    };
    fits.set(v.id, fit);
    out.set(v.id, { width: Math.max(v.node?.width ?? 0, fit.width), height: Math.max(v.node?.height ?? 0, fit.height) });
  }
  return { sizes: out, fits };
}

/**
 * The stored boxes laid out as in `layout` (ELK on the fully open diagram), for "Auto-arrange" in the
 * manual layout: positions snapped to the grid, and groups given sizes that hold what is inside them.
 */
export function arrangedNodes(nodes: DiagramNode[], layout: Layout): DiagramNode[] {
  const groups = new Set<string>();
  for (const n of nodes) if (n.parent !== undefined) groups.add(n.parent);
  return nodes.map((n) => {
    const r = layout.nodes.get(n.id);
    if (!r) return n;
    const next: DiagramNode = { ...n, x: snap(r.x), y: snap(r.y) };
    if (groups.has(n.id)) {
      next.width = snapUp(r.width + GRID / 2);
      next.height = snapUp(r.height + GRID / 2);
    }
    return next;
  });
}

// ---- Edits ------------------------------------------------------------------------------------------------

/** The ids of every box inside `id`, at every depth. */
export function descendantsOf(nodes: DiagramNode[], id: string): Set<string> {
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes) {
      if (n.parent !== undefined && (n.parent === id || out.has(n.parent)) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Removes boxes and their arrows. The boxes inside a removed group move up to the next level that stays,
 * keeping their place on the canvas, unless `withInside`, which removes them too (as the server does).
 */
export function removeBoxes(nodes: DiagramNode[], edges: DiagramEdge[], ids: Iterable<string>, withInside: boolean) {
  const gone = new Set(ids);
  if (withInside) for (const id of [...gone]) for (const d of descendantsOf(nodes, id)) gone.add(d);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = nodes
    .filter((n) => !gone.has(n.id))
    .map((n) => {
      if (n.parent === undefined || !gone.has(n.parent)) return n;
      let { x, y } = n;
      let parent: string | undefined = n.parent;
      while (parent !== undefined && gone.has(parent)) {
        const p = byId.get(parent);
        x += p?.x ?? 0;
        y += p?.y ?? 0;
        parent = p?.parent;
      }
      const { parent: _old, ...rest } = n;
      return parent === undefined ? { ...rest, x, y } : { ...rest, x, y, parent };
    });
  return { nodes: kept, edges: edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)) };
}

/**
 * Puts a box into a group (or at the top level with `parent` undefined), at a free spot among the boxes
 * already there. Arrows between the box (or anything in it) and its new group or the groups around that
 * can't stay; they are removed, and returned so the page can say so first.
 */
export function moveIntoGroup(nodes: DiagramNode[], edges: DiagramEdge[], id: string, parent: string | undefined) {
  const inside = descendantsOf(nodes, id);
  if (parent !== undefined && (parent === id || inside.has(parent))) throw new Error('A box can’t go inside itself');
  const above = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let p = parent; p !== undefined; p = byId.get(p)?.parent) above.add(p);
  const moving = new Set([id, ...inside]);
  const dropped = edges.filter((e) => (moving.has(e.source) && above.has(e.target)) || (moving.has(e.target) && above.has(e.source)));
  const siblings = nodes.filter((n) => n.parent === parent && n.id !== id);
  const spot = parent === undefined ? { x: 0, y: 0 } : { x: BOX.groupPad + 2, y: BOX.groupHeader + BOX.groupPad + 2 };
  if (siblings.length) spot.y = snapUp(Math.max(...siblings.map((n) => n.y)) + 100);
  const next = nodes.map((n) => {
    if (n.id !== id) return n;
    const { parent: _old, ...rest } = n;
    return parent === undefined ? { ...rest, ...spot } : { ...rest, ...spot, parent };
  });
  return { nodes: next, edges: edges.filter((e) => !dropped.includes(e)), dropped };
}

/**
 * Turns what is visible (model.ts) and where it goes (ELK, or the stored positions) into React Flow's nodes
 * and edges.
 */
import { Position, type Edge, type Node, type NodeHandle } from '@xyflow/react';
import { LAYER_COLORS, cx } from '../util';
import {
  captionOf,
  midpoint,
  pickSides,
  roleOf,
  type DiagramNode,
  type DiagramSettings,
  type EdgeRoute,
  type Point,
  type Rect,
  type Side,
  type Size,
  type View,
  type ViewEdge,
  type ViewNode,
} from './model';

/** Layers without a colour of their own get one of these, always the same one for the same name. */
const SPARE_COLORS = ['#0d9488', '#9333ea', '#ea580c', '#0369a1', '#be123c', '#65a30d', '#a16207', '#4f46e5'];

export function layerColor(layer: string): string {
  const known = LAYER_COLORS[layer];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < layer.length; i++) hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  return SPARE_COLORS[hash % SPARE_COLORS.length];
}

export type BoxData = {
  /** What is visible: a plain box, or a closed group standing for everything inside it. */
  v: ViewNode;
  /** The stored box as it is now (the layout may be a moment older); null for a made-up layer group. */
  node: DiagramNode | null;
  color: string;
  caption: string;
  role: string;
  /** The smallest the resize handles go (manual layout). */
  min: Size;
};
export type GroupData = {
  v: ViewNode;
  node: DiagramNode | null;
  color: string;
  min: Size;
};
export type BoxNode = Node<BoxData, 'dbox'>;
export type GroupNode = Node<GroupData, 'dgroup'>;
export type DNode = BoxNode | GroupNode;

export type ArrowData = {
  /** The route ELK planned, in canvas coordinates. Without one the arrow runs between the two boxes' sides. */
  points?: Point[];
  /** Where the label's centre goes (with a route). */
  labelAt?: Point;
  text: string;
  count: number;
  /** Stands for several stored arrows (between closed groups). */
  bundle: boolean;
  /** Label always shown. Otherwise (very busy diagrams) only on hover, when selected, or next to the selected box. */
  showLabel: boolean;
};
export type ArrowEdge = Edge<ArrowData, 'arrow'>;

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
export const SIDE_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/** A plain box can be resized down to this; its text is then cut off with "…". */
export const MIN_BOX: Size = { width: 60, height: 32 };

/**
 * One connection point in the middle of each side, named after the side; arrows both leave and arrive by them
 * (the diagram connects in "loose" mode). Given with the node, React Flow can draw arrows to boxes it hasn't
 * drawn yet (off screen), and arrow ends sit exactly on the border.
 */
function staticHandles(width: number, height: number): NodeHandle[] {
  const at: Record<Side, Point> = {
    top: { x: width / 2, y: 0 },
    right: { x: width, y: height / 2 },
    bottom: { x: width / 2, y: height },
    left: { x: 0, y: height / 2 },
  };
  return SIDES.map((side) => ({ id: side, type: 'source', position: SIDE_POSITION[side], ...at[side], width: 0, height: 0 }));
}

export interface FlowInput {
  view: View;
  /** Each visible box's position inside its group (or on the canvas), and its size. */
  rects: Map<string, Rect>;
  /** Arrow routes from ELK (automatic layout). */
  routes?: Map<string, EdgeRoute>;
  /** Smallest sizes for open groups (manual layout). */
  fits?: Map<string, Size>;
  /** The stored boxes as they are now, by id. Boxes deleted since the layout was made are left out. */
  current: Map<string, DiagramNode>;
  /** Ids of the stored arrows as they are now. */
  currentEdges: Set<string>;
  manual: boolean;
  editable: boolean;
  direction: DiagramSettings['direction'];
  /** Labels on every arrow; false for very busy diagrams. */
  labelsAlways: boolean;
}

export interface Flow {
  nodes: DNode[];
  edges: ArrowEdge[];
  /** Where each drawn box is on the canvas (React Flow positions children inside their group). */
  absolute: Map<string, Rect>;
}

export function buildFlow(input: FlowInput): Flow {
  const { view, rects, routes, fits, current, currentEdges, manual, editable, direction, labelsAlways } = input;
  const nodes: DNode[] = [];
  const absolute = new Map<string, Rect>();
  // view.nodes lists each group before what is inside it, as React Flow needs parents before children.
  for (const v of view.nodes) {
    if (v.node && !current.has(v.id)) continue; // deleted since this layout was made
    if (v.parent !== undefined && !absolute.has(v.parent)) continue; // inside one of those
    const r = rects.get(v.id);
    if (!r) continue;
    const above = v.parent !== undefined ? absolute.get(v.parent) : undefined;
    absolute.set(v.id, { x: (above?.x ?? 0) + r.x, y: (above?.y ?? 0) + r.y, width: r.width, height: r.height });
    const node = v.node ? (current.get(v.id) ?? v.node) : null;
    const real = node !== null;
    const common = {
      id: v.id,
      position: { x: r.x, y: r.y },
      width: r.width,
      height: r.height,
      // The size React Flow would measure (CSS draws each box at exactly width × height). These nodes are made
      // afresh whenever the picture or the selection changes, so a measurement React Flow stored on the old ones
      // would be lost, and it measures again only when a box's size on screen changes. Resizing starts from it:
      // without it a box grew from 0 × 0 and shrank to almost nothing.
      measured: { width: r.width, height: r.height },
      handles: staticHandles(r.width, r.height),
      draggable: manual && editable && real,
      connectable: editable && real,
      deletable: editable && real,
      ...(v.parent !== undefined ? { parentId: v.parent } : {}),
    };
    const color = layerColor(v.layer);
    if (v.kind === 'group') {
      nodes.push({ ...common, type: 'dgroup', data: { v, node, color, min: fits?.get(v.id) ?? MIN_BOX } });
    } else {
      const shown = { ...v, node };
      nodes.push({ ...common, type: 'dbox', data: { v, node, color, caption: captionOf(shown), role: roleOf(node), min: MIN_BOX } });
    }
  }

  const edges: ArrowEdge[] = [];
  const flow: Side[] = direction === 'DOWN' ? ['bottom', 'top'] : ['right', 'left'];
  for (const e of view.edges) {
    const a = absolute.get(e.source);
    const b = absolute.get(e.target);
    if (!a || !b) continue;
    const bundle = !(e.members.length === 1 && e.members[0].id === e.id);
    if (!bundle && !currentEdges.has(e.id)) continue; // deleted since this layout was made
    const route = manual ? undefined : routes?.get(e.id);
    // An arrow from a box to itself loops round its top-right corner.
    const sides: { source: Side; target: Side } =
      e.source === e.target ? { source: 'right', target: 'top' } : manual ? pickSides(a, b) : { source: flow[0], target: flow[1] };
    const data: ArrowData = { text: e.text, count: e.count, bundle, showLabel: labelsAlways };
    if (route && route.points.length >= 2) {
      data.points = route.points;
      data.labelAt = route.label
        ? { x: route.label.x + route.label.width / 2, y: route.label.y + route.label.height / 2 }
        : midpoint(route.points);
    }
    edges.push({
      id: e.id,
      type: 'arrow',
      source: e.source,
      target: e.target,
      sourceHandle: sides.source,
      targetHandle: sides.target,
      data,
      // A bundle stands for many arrows: they are deleted one by one, after opening the groups.
      deletable: editable && !bundle,
      className: cx(bundle && 'bundle'),
    });
  }
  return { nodes, edges, absolute };
}

/**
 * The selected box's own arrows that are drawn summed at a packed group's border (revealedEdges in model.ts):
 * each drawn on its own, from side to side, over the boxes, while the box is selected. They can't be clicked.
 */
export function revealedFlowEdges(revealed: ViewEdge[], absolute: Map<string, Rect>): ArrowEdge[] {
  const out: ArrowEdge[] = [];
  for (const e of revealed) {
    const a = absolute.get(e.source);
    const b = absolute.get(e.target);
    if (!a || !b) continue;
    const sides = pickSides(a, b);
    out.push({
      id: e.id,
      type: 'arrow',
      source: e.source,
      target: e.target,
      sourceHandle: sides.source,
      targetHandle: sides.target,
      data: { text: e.text, count: e.count, bundle: e.members.length > 1, showLabel: true },
      selectable: false,
      deletable: false,
      focusable: false,
      zIndex: 1000,
      className: 'revealed lit',
    });
  }
  return out;
}

/** The boxes that count as the selected one: itself and, for an open group, everything drawn inside it. */
export function selectionSet(nodes: DNode[], selected: string | null): Set<string> | null {
  if (selected === null || !nodes.some((n) => n.id === selected)) return null;
  const ids = new Set([selected]);
  // Parents come before children, so one pass finds everything inside.
  for (const n of nodes) if (n.parentId !== undefined && ids.has(n.parentId)) ids.add(n.id);
  return ids;
}

/**
 * Marks the selected arrow and, with a box selected, lights up its arrows (labels shown) and dims the rest.
 * Arrows that don't change keep their object, so React Flow doesn't redraw them.
 */
export function withSelection(edges: ArrowEdge[], related: Set<string> | null, selectedEdge: string | null): ArrowEdge[] {
  if (!related && selectedEdge === null) return edges;
  return edges.map((e) => {
    const isSelected = e.id === selectedEdge;
    const touches = related !== null && (related.has(e.source) || related.has(e.target));
    const dim = related !== null && !touches;
    if (!isSelected && !touches && !dim) return e;
    return {
      ...e,
      selected: isSelected,
      className: cx(e.className, touches && 'lit', dim && 'dim'),
      data: e.data && (touches || isSelected) && !e.data.showLabel ? { ...e.data, showLabel: true } : e.data,
    };
  });
}

// The diagram page's pure logic (web/src/diagram/model.ts): what is visible, arrow totals, sizes, layout input/output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BIG_DIAGRAM,
  BOX,
  MAX_LAYOUT_LABELS,
  PACK_GROUP_ABOVE,
  PACK_LOOSE_ABOVE,
  arrangedNodes,
  boxSizes,
  buildView,
  defaultView,
  fromElk,
  layerGroupId,
  manualSizes,
  midpoint,
  moveIntoGroup,
  openAll,
  pickSides,
  removeBoxes,
  revealedEdges,
  roundedPath,
  toElk,
  toggleOpen,
  type DiagramEdge,
  type DiagramNode,
  type ElkNode,
  type Layout,
  type Measure,
  type Point,
  type Rect,
  type View,
  type ViewState,
} from '../web/src/diagram/model.ts';

const n = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({ id, label: id, description: '', layer: 'core', x: 0, y: 0, ...extra });
const e = (source: string, target: string, extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id: `${source}>${target}`,
  source,
  target,
  label: '',
  ...extra,
});
const measure: Measure = (text, style) => text.length * (style === 'label' || style === 'header' ? 7.5 : 6.5);
const open: ViewState = { openByDefault: true, flipped: [], hiddenLayers: [], byLayer: false };
const shut: ViewState = { ...open, openByDefault: false };

/** Two systems of two classes each, plus a loose box. */
const nodes = [
  n('combat', { layer: 'gameplay' }),
  n('dmg', { parent: 'combat', weight: 100 }),
  n('hit', { parent: 'combat', weight: 300 }),
  n('ui', { layer: 'ui' }),
  n('hud', { parent: 'ui', layer: 'ui' }),
  n('menu', { parent: 'ui', layer: 'ui' }),
  n('save', { layer: 'data' }),
];
const edges = [
  e('hud', 'dmg', { label: 'reads' }),
  e('menu', 'dmg', { label: 'reads', count: 4 }),
  e('hud', 'hit', { label: 'shows' }),
  e('dmg', 'hit', { label: 'calls' }),
  e('dmg', 'hud'),
  e('hit', 'save'),
];

test('first view: small diagrams open, big ones folded (into layers when they have no groups)', () => {
  assert.equal(defaultView(nodes).openByDefault, true);
  const flat = Array.from({ length: BIG_DIAGRAM + 1 }, (_, i) => n(`b${i}`));
  assert.deepEqual(defaultView(flat), { openByDefault: false, flipped: [], hiddenLayers: [], byLayer: true });
  assert.deepEqual(defaultView(flat.slice(1)), { openByDefault: true, flipped: [], hiddenLayers: [], byLayer: false });
  const grouped = [n('g'), ...flat.map((b) => ({ ...b, parent: 'g' }))];
  assert.deepEqual(defaultView(grouped), { openByDefault: false, flipped: [], hiddenLayers: [], byLayer: false });
  const v = toggleOpen(openAll(defaultView(grouped), true), 'g');
  assert.deepEqual([v.openByDefault, v.flipped], [true, ['g']]);
  assert.deepEqual(toggleOpen(v, 'g').flipped, []);
});

test('open groups: everything visible, groups before what is inside them, every arrow on its own', () => {
  const v = buildView(nodes, edges, open);
  assert.deepEqual(
    v.nodes.map((x) => [x.id, x.kind, x.parent ?? null, x.inside]),
    [
      ['combat', 'group', null, 2],
      ['dmg', 'box', 'combat', 0],
      ['hit', 'box', 'combat', 0],
      ['ui', 'group', null, 2],
      ['hud', 'box', 'ui', 0],
      ['menu', 'box', 'ui', 0],
      ['save', 'box', null, 0],
    ],
  );
  assert.equal(v.edges.length, edges.length);
  const reads = v.edges.find((x) => x.id === 'menu>dmg');
  assert.deepEqual([reads?.text, reads?.count], ['reads ×4', 4]);
});

test('closed groups: arrows between what is inside them add up; arrows inside one go; each way stays separate', () => {
  const v = buildView(nodes, edges, shut);
  assert.deepEqual(v.nodes.map((x) => [x.id, x.kind, x.inside]), [
    ['combat', 'closed', 2],
    ['ui', 'closed', 2],
    ['save', 'box', 0],
  ]);
  assert.equal(v.shownAs.get('hud'), 'ui');
  const uiToCombat = v.edges.find((x) => x.source === 'ui' && x.target === 'combat');
  // hud>dmg (1) + menu>dmg (4) + hud>hit (1); "reads" carries 5 of the 6.
  assert.deepEqual([uiToCombat?.id, uiToCombat?.count, uiToCombat?.text], ['agg:ui>combat', 6, 'reads ×6']);
  assert.equal(uiToCombat?.members.length, 3);
  const combatToUi = v.edges.find((x) => x.source === 'combat' && x.target === 'ui');
  assert.deepEqual([combatToUi?.id, combatToUi?.text], ['dmg>hud', '']); // a single arrow keeps its id
  assert.equal(v.edges.some((x) => x.source === 'combat' && x.target === 'combat'), false); // dmg>hit is inside one box
  assert.equal(v.edges.find((x) => x.target === 'save')?.source, 'combat');

  // Opening one group: arrows run from its boxes to the other, still closed, group.
  const half = buildView(nodes, edges, toggleOpen(shut, 'ui'));
  const fromHud = half.edges.find((x) => x.source === 'hud' && x.target === 'combat');
  assert.deepEqual([fromHud?.count, fromHud?.text], [2, 'reads ×2']);
});

test('an arrow stored between two groups says it all: the arrows from inside them are not added to it', () => {
  const summary = e('ui', 'combat', { label: 'uses', count: 40 });
  const v = buildView(nodes, [...edges, summary], shut);
  const bundle = v.edges.find((x) => x.source === 'ui' && x.target === 'combat');
  // It is drawn as that stored arrow, so clicking it edits that arrow.
  assert.deepEqual([bundle?.id, bundle?.count, bundle?.text, bundle?.members], [summary.id, 40, 'uses ×40', [summary]]);
});

test('hidden layers leave out their boxes, what is inside them and their arrows', () => {
  const v = buildView(nodes, edges, { ...open, hiddenLayers: ['ui'] });
  assert.deepEqual(v.nodes.map((x) => x.id), ['combat', 'dmg', 'hit', 'save']);
  assert.equal(v.hiddenCount, 3);
  assert.deepEqual(v.edges.map((x) => x.id).sort(), ['dmg>hit', 'hit>save']);
  // A group whose boxes are all hidden is drawn shut.
  const coreHidden = buildView(nodes, edges, { ...open, hiddenLayers: ['core'] });
  assert.deepEqual(coreHidden.nodes.find((x) => x.id === 'combat'), { id: 'combat', kind: 'closed', node: nodes[0], label: 'combat', layer: 'gameplay', inside: 0 });
});

test('group by layer: one made-up group per layer, shut ones joined by arrow totals', () => {
  const flat = [n('a', { layer: 'ui' }), n('b', { layer: 'ui' }), n('c'), n('d', { layer: 'data' })];
  const flatEdges = [e('a', 'c'), e('b', 'c', { count: 2 }), e('a', 'b'), e('c', 'd')];
  const v = buildView(flat, flatEdges, { ...shut, byLayer: true });
  assert.deepEqual(v.nodes.map((x) => [x.id, x.kind, x.inside, x.node]), [
    [layerGroupId('ui'), 'closed', 2, null],
    [layerGroupId('core'), 'closed', 1, null],
    [layerGroupId('data'), 'closed', 1, null],
  ]);
  assert.deepEqual(v.edges.map((x) => [x.source, x.target, x.count]), [
    [layerGroupId('ui'), layerGroupId('core'), 3],
    [layerGroupId('core'), layerGroupId('data'), 1],
  ]);
  const one = buildView(flat, flatEdges, toggleOpen({ ...shut, byLayer: true }, layerGroupId('ui')));
  assert.deepEqual(one.nodes.slice(0, 3).map((x) => [x.id, x.parent ?? null]), [
    [layerGroupId('ui'), null],
    ['a', layerGroupId('ui')],
    ['b', layerGroupId('ui')],
  ]);
  assert.equal(one.edges.find((x) => x.id === 'a>b')?.source, 'a');
});

test('an arrow from a box to itself stays; a closed group\'s weight is the total inside it', () => {
  const v = buildView([n('a'), n('g'), n('x', { parent: 'g', weight: 5 }), n('y', { parent: 'g', weight: 7 })], [e('a', 'a'), e('x', 'x')], shut);
  assert.deepEqual(v.edges.map((x) => x.id), ['a>a']);
  assert.equal(v.nodes.find((x) => x.id === 'g')?.weight, 12);
});

test('box sizes follow the text and the weight; a stored size wins on a plain box only', () => {
  const v = buildView(nodes, edges, open);
  const sizes = boxSizes(v, measure);
  assert.equal(sizes.has('combat'), false); // open groups are sized by the layout
  // dmg (100) is the typical weight; hit (300) is three times heavier, so √3 times as wide.
  const light = sizes.get('dmg')!;
  const heavy = sizes.get('hit')!;
  assert.equal(light.width, BOX.minWidth);
  assert.equal(heavy.width, Math.round(BOX.minWidth * Math.sqrt(3)));
  assert.ok(heavy.height > light.height);
  assert.equal(sizes.get('save')!.width, BOX.minWidth); // no weight: not scaled
  const capped = boxSizes(buildView([n('a', { weight: 10 }), n('b', { weight: 10 }), n('c', { weight: 1000 })], [], open), measure);
  assert.equal(capped.get('a')!.width, BOX.minWidth);
  assert.equal(capped.get('c')!.width, Math.round(BOX.minWidth * BOX.maxScale), 'at most maxScale times as wide');

  const long = n('long', { label: 'A label far too long to fit on one line of a box', role: 'Does many things\nsecond line', path: 'src/long/' });
  const s = boxSizes(buildView([long], [], open), measure).get('long')!;
  assert.equal(s.width, BOX.maxWidth);
  const oneLine = 2 * (BOX.padY + BOX.border) + BOX.caption + BOX.labelLine;
  assert.equal(s.height, oneLine + BOX.labelLine + BOX.pathLine + BOX.roleLine);

  const stored = [n('g', { width: 900, height: 700 }), n('k', { parent: 'g' }), n('b', { width: 333 })];
  const shutSizes = boxSizes(buildView(stored, [], shut), measure);
  assert.equal(shutSizes.get('b')!.width, 333);
  assert.equal(shutSizes.get('g')!.width, BOX.minWidth); // the open size of a group doesn't apply when it is shut
});

test('layout input: arrows sit in the innermost group holding both ends; labels drop out when there are too many', () => {
  const v = buildView(nodes, edges, open);
  const g = toElk(v, boxSizes(v, measure), 'RIGHT', measure);
  assert.equal(g.layoutOptions?.['elk.direction'], 'RIGHT');
  const combat = g.children?.find((c) => c.id === 'combat');
  assert.deepEqual(combat?.children?.map((c) => c.id), ['dmg', 'hit']);
  assert.deepEqual(combat?.edges?.map((x) => x.id), ['dmg>hit']);
  assert.match(combat?.layoutOptions?.['elk.padding'] ?? '', new RegExp(`top=${BOX.groupHeader + BOX.groupPad}`));
  assert.deepEqual(g.edges?.map((x) => x.id).sort(), ['dmg>hud', 'hit>save', 'hud>dmg', 'hud>hit', 'menu>dmg']);
  assert.deepEqual(g.edges?.find((x) => x.id === 'menu>dmg')?.labels?.[0].text, 'reads ×4');

  const many = Array.from({ length: MAX_LAYOUT_LABELS + 1 }, (_, i) => e('a', `t${i}`, { label: 'x' }));
  const crowded = buildView([n('a'), ...many.map((x) => n(x.target))], many, open);
  assert.equal(toElk(crowded, boxSizes(crowded, measure), 'DOWN', measure).edges?.some((x) => x.labels), false);
});

test('packed groups: a big open group is arranged on its own, and arrows leaving it start at its border', () => {
  const big = Array.from({ length: PACK_GROUP_ABOVE + 1 }, (_, i) => n(`b${i}`, { parent: 'big' }));
  const ns = [n('big'), ...big, n('small'), n('s1', { parent: 'small' }), n('s2', { parent: 'small' }), n('out')];
  const es = [
    e('b0', 'b1', { label: 'calls' }), // inside the big group: drawn as it is
    e('b0', 'out', { label: 'uses' }),
    e('b2', 'out', { label: 'uses', count: 3 }), // these two: one arrow from the big group's border
    e('s1', 'b3'), // into the big group: ends at its border
    e('s1', 's2'), // inside the small group, which isn't packed
  ];
  const v = buildView(ns, es, open, true);
  assert.deepEqual([...v.packed], ['big']);
  assert.deepEqual(v.edges.map((x) => `${x.source}>${x.target}`).sort(), ['b0>b1', 'big>out', 's1>big', 's1>s2']);
  const summed = v.edges.find((x) => x.source === 'big' && x.target === 'out');
  assert.deepEqual([summed?.count, summed?.text, summed?.members.length], [4, 'uses ×4', 2]);

  // The manual layout draws every arrow on its own.
  const flat = buildView(ns, es, open);
  assert.equal(flat.packed.size, 0);
  assert.deepEqual(flat.edges.map((x) => `${x.source}>${x.target}`).sort(), ['b0>b1', 'b0>out', 'b2>out', 's1>b3', 's1>s2']);

  // A selected box in the packed group shows its own arrows that were added into the border one.
  assert.deepEqual(revealedEdges(v, es, 'b2').map((x) => [x.id, x.source, x.target, x.count]), [['rev:b2>out', 'b2', 'out', 3]]);
  assert.deepEqual(revealedEdges(v, es, 'b1'), [], 'its only arrow is drawn already');
  assert.deepEqual(revealedEdges(flat, es, 'b2'), []);

  // ELK arranges the packed group separately, the same way round; the small group stays part of the whole.
  const g = toElk(v, boxSizes(v, measure), 'DOWN', measure);
  const bigNode = g.children?.find((c) => c.id === 'big');
  assert.equal(bigNode?.layoutOptions?.['elk.hierarchyHandling'], 'SEPARATE_CHILDREN');
  assert.equal(bigNode?.layoutOptions?.['elk.direction'], 'DOWN');
  assert.equal(g.children?.find((c) => c.id === 'small')?.layoutOptions?.['elk.hierarchyHandling'], undefined);
  // Keeping the stored order is for the whole diagram only: in a dense packed group it makes ELK ten times slower.
  assert.equal(g.layoutOptions?.['elk.layered.considerModelOrder.strategy'], 'NODES_AND_EDGES');
  assert.equal(bigNode?.layoutOptions?.['elk.layered.considerModelOrder.strategy'], undefined);
  // How hard ELK works on a packed group depends on what is in it, not on the size of the whole view.
  const busy = buildView([...ns, ...Array.from({ length: BIG_DIAGRAM }, (_, i) => n(`c${i}`))], es, open, true);
  const busyElk = toElk(busy, boxSizes(busy, measure), 'DOWN', measure);
  assert.deepEqual(
    [busyElk.layoutOptions?.['elk.layered.thoroughness'], busyElk.children?.find((c) => c.id === 'big')?.layoutOptions?.['elk.layered.thoroughness']],
    ['3', '7'],
  );
});

test('packed groups: every open group once the view is big, and every group inside a packed one', () => {
  const loose = Array.from({ length: BIG_DIAGRAM }, (_, i) => n(`l${i}`));
  const nested = [n('outer'), n('inner', { parent: 'outer' }), n('i0', { parent: 'inner' }), n('i1', { parent: 'inner' }), n('o0', { parent: 'outer' })];
  const es = [e('i0', 'o0'), e('i1', 'o0'), e('i0', 'l0'), e('i0', 'i1')];
  const v = buildView([...nested, ...loose], es, open, true);
  assert.deepEqual([...v.packed].sort(), ['inner', 'outer']);
  // Each arrow starts at the outermost packed border that leaves the other end outside.
  assert.deepEqual(v.edges.map((x) => `${x.source}>${x.target} ×${x.count}`).sort(), ['i0>i1 ×1', 'inner>o0 ×2', 'outer>l0 ×1']);

  const kids = Array.from({ length: PACK_GROUP_ABOVE }, (_, i) => n(`k${i}`, { parent: 'outer' }));
  const small = buildView([n('outer'), n('inner', { parent: 'outer' }), n('i0', { parent: 'inner' }), ...kids], [], open, true);
  assert.deepEqual([...small.packed].sort(), ['inner', 'outer'], 'the outer group has 41 boxes in it; the inner one goes with it');
  assert.equal(buildView(nested, es, open, true).packed.size, 0, 'small groups in a small view are arranged with everything else');
});

test('packed groups: a group with many loose boxes (no arrow to anything else in it) is packed too', () => {
  const group = (loose: number) => [
    n('g'),
    n('hub', { parent: 'g' }),
    n('spoke', { parent: 'g' }),
    ...Array.from({ length: loose }, (_, i) => n(`l${i}`, { parent: 'g' })),
    n('out'),
  ];
  // Arrows out of the group don't join anything inside it; hub > spoke joins those two.
  const es = [e('hub', 'spoke'), e('l0', 'out'), e('l1', 'out')];
  assert.deepEqual([...buildView(group(PACK_LOOSE_ABOVE + 1), es, open, true).packed], ['g']);
  assert.equal(buildView(group(PACK_LOOSE_ABOVE), es, open, true).packed.size, 0);
  // Joined through a box inside an open group within it: still joined.
  const deep = [n('g'), n('sub', { parent: 'g' }), n('x', { parent: 'sub' }), ...Array.from({ length: PACK_LOOSE_ABOVE }, (_, i) => n(`l${i}`, { parent: 'g' }))];
  assert.equal(buildView(deep, [e('x', 'l0')], open, true).packed.size, 0, 'sub and l0 are joined; 7 loose left');
  assert.deepEqual([...buildView(deep, [e('x', 'x')], open, true).packed].sort(), ['g', 'sub'], '9 loose: g is packed, and sub with it');
});

/** Where a laid-out box is on the canvas. */
const absoluteRect = (layout: Layout, v: View, id: string): Rect => {
  const r = layout.nodes.get(id)!;
  const p = v.nodes.find((x) => x.id === id)?.parent;
  const o = p !== undefined ? absoluteRect(layout, v, p) : { x: 0, y: 0 };
  return { x: o.x + r.x, y: o.y + r.y, width: r.width, height: r.height };
};
const onBorder = (pt: Point, b: Rect) =>
  pt.x >= b.x - 1 && pt.x <= b.x + b.width + 1 && pt.y >= b.y - 1 && pt.y <= b.y + b.height + 1 &&
  (Math.abs(pt.x - b.x) <= 1 || Math.abs(pt.x - b.x - b.width) <= 1 || Math.abs(pt.y - b.y) <= 1 || Math.abs(pt.y - b.y - b.height) <= 1);
const assertArrowsOnBorders = (layout: Layout, v: View) => {
  for (const x of v.edges) {
    const route = layout.edges.get(x.id)!;
    assert.ok(route.points.length >= 2, x.id);
    assert.ok(onBorder(route.points[0], absoluteRect(layout, v, x.source)), `${x.id} starts on ${x.source}`);
    assert.ok(onBorder(route.points.at(-1)!, absoluteRect(layout, v, x.target)), `${x.id} ends on ${x.target}`);
  }
};

const elkPath = new URL('../web/node_modules/elkjs/lib/elk.bundled.js', import.meta.url);
const noElk = !fs.existsSync(elkPath) && 'web dependencies not installed';
const elkLayout = async (graph: ElkNode) => {
  const ELK = createRequire(import.meta.url)(fileURLToPath(elkPath));
  return fromElk((await new ELK().layout(graph)) as ElkNode);
};

test('ELK lays out groups and arrows the way the page reads them back', { skip: noElk }, async () => {
  const v = buildView(nodes, edges, open);
  const sizes = boxSizes(v, measure);
  const layout = await elkLayout(toElk(v, sizes, 'DOWN', measure));
  // Boxes come back relative to their group, at the size they were given.
  const combat = layout.nodes.get('combat')!;
  const dmg = layout.nodes.get('dmg')!;
  assert.deepEqual([dmg.width, dmg.height], [sizes.get('dmg')!.width, sizes.get('dmg')!.height]);
  assert.ok(dmg.x >= BOX.groupPad && dmg.y >= BOX.groupHeader + BOX.groupPad, 'inside the group, below its header');
  assert.ok(dmg.x + dmg.width <= combat.width && dmg.y + dmg.height <= combat.height);
  // Arrows come back in canvas coordinates, starting and ending on the borders of their boxes.
  assertArrowsOnBorders(layout, v);
  assert.ok(layout.edges.get('menu>dmg')?.label, 'labels are placed');
});

test('ELK: a packed group is packed into a block and read back like any other group', { skip: noElk }, async () => {
  const big = Array.from({ length: PACK_GROUP_ABOVE + 1 }, (_, i) => n(`b${i}`, { parent: 'big' }));
  const es = [e('b0', 'b1', { label: 'calls' }), e('b1', 'b2'), e('b0', 'out'), e('b5', 'out')];
  const v = buildView([n('big'), ...big, n('out')], es, open, true);
  const sizes = boxSizes(v, measure);
  const layout = await elkLayout(toElk(v, sizes, 'DOWN', measure));
  const group = layout.nodes.get('big')!;
  const row = big.reduce((sum, b) => sum + sizes.get(b.id)!.width, 0);
  assert.ok(group.width < row / 2, `packed: ${group.width} wide, a row would be ${row}`);
  for (const b of big) {
    const r = layout.nodes.get(b.id)!;
    assert.ok(r.x >= BOX.groupPad - 1 && r.y >= BOX.groupHeader + BOX.groupPad - 1, `${b.id} inside, below the header`);
    assert.ok(r.x + r.width <= group.width + 1 && r.y + r.height <= group.height + 1, `${b.id} inside`);
  }
  assertArrowsOnBorders(layout, v);
});

test('arrow drawing: rounded corners, midpoints, and the sides a manual arrow uses', () => {
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 50 }]), 'M0,0 L0,50');
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 40, y: 50 }]), 'M0,0 L0,42 Q0,50 8,50 L40,50');
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 40, y: 6 }]), 'M0,0 L0,3 Q0,6 3,6 L40,6'); // short leg: smaller corner
  assert.deepEqual(midpoint([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 30, y: 10 }]), { x: 10, y: 10 });
  const a = { x: 0, y: 0, width: 100, height: 50 };
  assert.deepEqual(pickSides(a, { x: 300, y: 20, width: 100, height: 50 }), { source: 'right', target: 'left' });
  assert.deepEqual(pickSides(a, { x: -300, y: 0, width: 100, height: 50 }), { source: 'left', target: 'right' });
  assert.deepEqual(pickSides(a, { x: 20, y: 200, width: 100, height: 50 }), { source: 'bottom', target: 'top' });
  assert.deepEqual(pickSides(a, { x: 60, y: -200, width: 300, height: 50 }), { source: 'top', target: 'bottom' });
});

test('manual layout: groups fit what is inside (or a bigger stored size); auto-arrange snaps to the grid', () => {
  const ns = [
    n('g'),
    n('a', { parent: 'g', x: 20, y: 60 }),
    n('b', { parent: 'g', x: 300, y: 200 }),
    n('h', { width: 640, height: 480 }),
    n('c', { parent: 'h' }),
    // Stored smaller than what is inside it: it grows to fit.
    n('k', { width: 100, height: 100 }),
    n('d', { parent: 'k', x: 400, y: 48 }),
  ];
  const v = buildView(ns, [], open);
  const base = boxSizes(v, measure);
  const { sizes, fits } = manualSizes(v, base, new Map(ns.map((x) => [x.id, { x: x.x, y: x.y }])), measure);
  const g = sizes.get('g')!;
  assert.ok(g.width >= 300 + base.get('b')!.width + BOX.groupPad && g.width % 16 === 0);
  assert.ok(g.height >= 200 + base.get('b')!.height + BOX.groupPad && g.height % 16 === 0);
  assert.deepEqual(fits.get('g'), g);
  assert.deepEqual(sizes.get('h'), { width: 640, height: 480 });
  assert.ok(fits.get('h')!.width < 640);
  assert.ok(sizes.get('k')!.width >= 400 + base.get('d')!.width + BOX.groupPad);
  assert.deepEqual(sizes.get('k'), fits.get('k'));
  assert.equal(fits.has('a'), false);

  const layout = {
    nodes: new Map([
      ['g', { x: 3, y: 9, width: 401, height: 207 }],
      ['a', { x: 14, y: 50, width: 140, height: 60 }],
    ]),
    edges: new Map(),
    width: 500,
    height: 300,
  };
  const arranged = arrangedNodes(ns, layout);
  assert.deepEqual(
    arranged.slice(0, 2).map((x) => [x.x, x.y, x.width ?? null, x.height ?? null]),
    [
      [0, 16, 416, 224],
      [16, 48, null, null],
    ],
  );
  assert.equal(arranged[2], ns[2]); // not in the layout: untouched
});

test('edits: removing a group moves what is inside up (keeping its place) or removes it all; moving into a group', () => {
  const ns = [n('outer', { x: 100, y: 100 }), n('inner', { parent: 'outer', x: 10, y: 50 }), n('leaf', { parent: 'inner', x: 5, y: 40 }), n('z')];
  const es = [e('leaf', 'z'), e('z', 'inner'), e('outer', 'z')];
  const up = removeBoxes(ns, es, ['outer', 'inner'], false);
  assert.deepEqual(up.nodes.find((x) => x.id === 'leaf'), n('leaf', { x: 115, y: 190 }));
  assert.deepEqual(up.edges.map((x) => x.id), ['leaf>z']);
  const all = removeBoxes(ns, es, ['outer'], true);
  assert.deepEqual(all.nodes.map((x) => x.id), ['z']);
  assert.equal(all.edges.length, 0);

  assert.throws(() => moveIntoGroup(ns, es, 'outer', 'leaf'));
  const moved = moveIntoGroup(ns, es, 'z', 'inner');
  assert.equal(moved.nodes.find((x) => x.id === 'z')?.parent, 'inner');
  assert.deepEqual(moved.dropped.map((x) => x.id), ['z>inner', 'outer>z']); // z can't point at a group it is in
  assert.deepEqual(moved.edges.map((x) => x.id), ['leaf>z']);
  const out = moveIntoGroup(ns, es, 'leaf', undefined);
  assert.equal(out.nodes.find((x) => x.id === 'leaf')?.parent, undefined);
  assert.equal(out.dropped.length, 0);
});

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ApiError, api, V1 } from '../api';
import { useDiagram, useDiagrams } from '../hooks';
import { useMutate } from '../mutate';
import type { Diagram, DiagramLimits } from '../types';
import { clip, cx, errorMessage, joinAnd, plural } from '../util';
import { Spinner } from '../components/Bits';
import { askConfirm } from '../components/Confirm';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Superseded, layoutGraph } from '../diagram/elk';
import { edgeTypes } from '../diagram/edges';
import { buildFlow, layerColor, revealedFlowEdges, selectionSet, withSelection, type ArrowEdge, type DNode, type Flow } from '../diagram/flow';
import {
  BOX,
  GRID,
  arrangedNodes,
  boxSizes,
  buildView,
  defaultView,
  descendantsOf,
  fromElk,
  isLayerGroup,
  labelsInLayout,
  manualSizes,
  moveIntoGroup,
  openAll,
  removeBoxes,
  revealedEdges,
  roleOf,
  snap,
  toElk,
  toggleOpen,
  type DiagramEdge,
  type DiagramNode,
  type DiagramSettings,
  type Layout,
  type Rect,
  type ViewState,
} from '../diagram/model';
import { DiagramContext, nodeTypes, type DiagramActions } from '../diagram/nodes';
import { BundlePanel, EdgePanel, Inspector, NodePanel } from '../diagram/panels';
import { boxCssVars, measureText } from '../diagram/sizes';
import { MoreSheet, Toolbar, type SaveState } from '../diagram/Toolbar';
import { useAutoLayout } from '../diagram/useLayout';

type Model = { nodes: DiagramNode[]; edges: DiagramEdge[]; settings: DiagramSettings };
type Selection = { kind: 'node' | 'edge'; id: string } | null;
type ImportCounts = { added: number; updated: number; removed: number };
type ImportResult = { mode: 'merge' | 'replace'; dryRun: boolean; nodes: ImportCounts; edges: ImportCounts; settingsChanged: boolean; version: number };

const DEFAULT_SETTINGS: DiagramSettings = { layout: 'auto', direction: 'DOWN' };
/** Showing more boxes than this at once asks first: arranging them takes seconds. */
const BIG_VIEW = 300;
/** Above this many boxes, React Flow only draws what is on screen. */
const ONLY_VISIBLE_ABOVE = 200;
/** Nothing to draw yet (the first layout is still coming). One shared object, so it never looks like a change. */
const NO_FLOW: Flow = { nodes: [], edges: [], absolute: new Map() };

const toModel = (d: Diagram): Model => ({ nodes: d.nodes, edges: d.edges, settings: { ...DEFAULT_SETTINGS, ...d.settings } });

/** A short random id. (crypto.randomUUID only exists on HTTPS, and the app is often opened over plain HTTP.) */
function newId(taken: Set<string>): string {
  for (;;) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('');
    if (!taken.has(id)) return id;
  }
}

// What the viewer has open, closed and hidden is theirs: kept per diagram in this browser, not saved for everyone.
const viewKey = (id: number) => `pm.diagram.view.${id}`;
function loadView(id: number): ViewState | null {
  try {
    const raw = JSON.parse(localStorage.getItem(viewKey(id)) ?? 'null') as Partial<ViewState> | null;
    if (!raw || typeof raw.openByDefault !== 'boolean') return null;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { openByDefault: raw.openByDefault, flipped: strings(raw.flipped), hiddenLayers: strings(raw.hiddenLayers), byLayer: raw.byLayer === true };
  } catch {
    return null;
  }
}
function storeView(id: number, view: ViewState) {
  try {
    localStorage.setItem(viewKey(id), JSON.stringify(view));
  } catch {
    // Private browsing or full storage: the view just isn't remembered.
  }
}

const IMPORT_VERBS: Array<[keyof ImportCounts, string]> = [['added', 'add'], ['updated', 'update'], ['removed', 'remove']];

/** What an import changes: "add 7 boxes and 8 arrows, update 1 box…", or once done "added 7 boxes…"; '' if nothing. */
function importChanges(r: ImportResult, done: boolean): string {
  return joinAnd(
    IMPORT_VERBS.flatMap(([key, verb]) => {
      const what = [r.nodes[key] ? plural(r.nodes[key], 'box', 'boxes') : '', r.edges[key] ? plural(r.edges[key], 'arrow', 'arrows') : ''].filter(Boolean);
      return what.length ? [`${done ? key : verb} ${joinAnd(what)}`] : [];
    }).concat(r.settingsChanged ? [`${done ? 'changed' : 'change'} the layout settings`] : []),
  );
}

export function DiagramPage() {
  const list = useDiagrams().data;
  const mutate = useMutate();
  const [params, setParams] = useSearchParams();
  const wanted = Number(params.get('d')) || null;
  const id = list ? ((wanted !== null && list.diagrams.some((d) => d.id === wanted) ? wanted : list.diagrams[0]?.id) ?? null) : null;
  const { data: diagram, error } = useDiagram(id);

  // The diagram shown is in the address (?d=12), so a link or a reload opens the same one.
  const choose = useCallback(
    (next: number | null) =>
      setParams(
        (prev) => {
          const q = new URLSearchParams(prev);
          if (next === null) q.delete('d');
          else q.set('d', String(next));
          return q;
        },
        { replace: true },
      ),
    [setParams],
  );

  const createDiagram = async () => {
    const name = window.prompt('Diagram name')?.trim();
    if (!name) return;
    const d = await mutate(() => api.post<Diagram>(`${V1}/diagrams`, { name: name.slice(0, 200) }), ['diagrams']);
    if (d) choose(d.id);
  };

  return (
    <>
      <PageHeader title="Architecture">
        {list && list.diagrams.length > 1 && (
          <select value={id ?? ''} onChange={(e) => choose(Number(e.target.value))} style={{ width: 'auto', minHeight: 34, maxWidth: '40vw' }} aria-label="Diagram">
            {list.diagrams.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-sm" onClick={createDiagram}>
          + Diagram
        </button>
      </PageHeader>
      <div className="content flush">
        {!list ? (
          <Spinner />
        ) : id === null ? (
          <div className="empty">No diagrams yet. Create one with + Diagram.</div>
        ) : diagram ? (
          <Editor key={diagram.id} diagram={diagram} layers={list.layers} limits={list.limits} onDeleted={() => choose(null)} />
        ) : error ? (
          <div className="empty">{errorMessage(error)}</div>
        ) : (
          <Spinner />
        )}
      </div>
    </>
  );
}

function Editor({ diagram, layers, limits, onDeleted }: { diagram: Diagram; layers: string[]; limits: DiagramLimits; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mutate = useMutate();
  const [flowApi, setFlowApi] = useState<ReactFlowInstance<DNode, ArrowEdge> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importModeRef = useRef<'merge' | 'replace'>('merge');

  // ---- The diagram itself: one model, saved whole ----------------------------------------------------------

  const [model, setModelState] = useState<Model>(() => toModel(diagram));
  const modelRef = useRef(model);
  const setModel = useCallback((next: Model) => {
    modelRef.current = next;
    setModelState(next);
  }, []);

  const [saving, setSaving] = useState<SaveState>('idle');
  const versionRef = useRef(diagram.version);
  // Every edit bumps `edits`; `savedEdits` is the count the server has. Counting (not a flag) keeps edits made
  // while a save is on its way from being taken as saved.
  const editsRef = useRef(0);
  const savedEditsRef = useRef(0);
  const inflightRef = useRef<Promise<void> | null>(null);
  const pendingNameRef = useRef<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  /** The server turned a save down (not a network problem): trying again would fail the same way. */
  const refusedRef = useRef(false);
  const [reloads, setReloads] = useState(0);
  const isDirty = () => editsRef.current !== savedEditsRef.current;

  /** Drops unsaved edits and shows the server's copy. */
  const reload = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    refusedRef.current = false;
    savedEditsRef.current = editsRef.current;
    pendingNameRef.current = null;
    versionRef.current = -1;
    setSaving('idle');
    setReloads((n) => n + 1);
    void qc.invalidateQueries({ queryKey: ['diagram', diagram.id] });
  }, [diagram.id, qc]);

  // Changes made elsewhere (an agent using the API, another tab) come in whenever nothing is waiting to be saved.
  useEffect(() => {
    if (isDirty() || diagram.version === versionRef.current) return;
    versionRef.current = diagram.version;
    setModel(toModel(diagram));
  }, [diagram, reloads, setModel]);

  /** Saves until the server has every edit. Only one save is ever on its way, so saves never race each other. */
  const save = useCallback((): Promise<void> => {
    if (inflightRef.current) return inflightRef.current; // the loop running now picks up newer edits
    const run = async () => {
      while (isDirty() && !refusedRef.current) {
        const editsAtSend = editsRef.current;
        const name = pendingNameRef.current;
        const { nodes, edges, settings } = modelRef.current;
        setSaving('saving');
        try {
          // schema 2: the server stores exactly this (pages from before groups and sizes send no schema).
          const res = await api.put<Diagram>(`${V1}/diagrams/${diagram.id}`, {
            version: versionRef.current,
            schema: 2,
            ...(name ? { name } : {}),
            nodes,
            edges,
            settings,
          });
          versionRef.current = res.version;
          savedEditsRef.current = editsAtSend;
          qc.setQueryData(['diagram', diagram.id], res);
          if (name) {
            if (pendingNameRef.current === name) pendingNameRef.current = null;
            void qc.invalidateQueries({ queryKey: ['diagrams'] });
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            toast('Someone else changed this diagram, so it was reloaded with their changes. Your latest edits were not saved.', 'error');
            reload();
          } else if (err instanceof ApiError && err.status < 500 && err.status !== 401) {
            refusedRef.current = true;
            toast(`Couldn't save the diagram: ${err.message}`, 'error', { action: { label: 'Reload', onClick: reload }, duration: 15000 });
            setSaving('error');
          } else {
            // Network trouble (phone Wi-Fi), the server restarting, or signed out: keep the edits, try again soon.
            toast(`Couldn't save the diagram (${errorMessage(err)}). Trying again…`, 'error');
            window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              timerRef.current = undefined;
              void save();
            }, 5000);
            setSaving('error');
          }
          return;
        }
      }
      setSaving(isDirty() ? 'error' : 'idle');
    };
    inflightRef.current = run().finally(() => {
      inflightRef.current = null;
      // Edits made during the last request get a save of their own.
      if (isDirty() && !timerRef.current && !refusedRef.current) void save();
    });
    return inflightRef.current;
  }, [diagram.id, qc, reload, toast]);

  const scheduleSave = useCallback(() => {
    editsRef.current++;
    setSaving('pending');
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void save();
    }, 600);
  }, [save]);

  // Leaving the page saves what is waiting; closing the tab with unsaved edits asks first.
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      if (isDirty()) void save();
    },
    [save],
  );
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (isDirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  /** Applies an edit to the latest model and saves it shortly. */
  const commit = useCallback(
    (change: (m: Model) => Model) => {
      setModel(change(modelRef.current));
      scheduleSave();
    },
    [scheduleSave, setModel],
  );

  // ---- What is visible, and where it goes ---------------------------------------------------------------------

  const [view, setViewState] = useState<ViewState>(() => loadView(diagram.id) ?? defaultView(diagram.nodes));
  const viewRef = useRef(view);
  const setView = useCallback((next: ViewState) => {
    viewRef.current = next;
    setViewState(next);
  }, []);
  useEffect(() => storeView(diagram.id, view), [diagram.id, view]);

  const [editable, setEditable] = useState(() => window.innerWidth >= 900);
  const [selection, setSelection] = useState<Selection>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** Where to point the view once the next picture is ready: everything, or one box (a group just opened). */
  const pendingFit = useRef<'all' | { id: string } | null>('all');

  const manual = model.settings.layout === 'manual';
  const direction = model.settings.direction;
  // Grouping by layer is for the automatic layout; manual positions belong to the real groups.
  const shownView = useMemo<ViewState>(() => (manual && view.byLayer ? { ...view, byLayer: false } : view), [manual, view]);
  const current = useMemo(() => buildView(model.nodes, model.edges, shownView, !manual), [model.nodes, model.edges, shownView, manual]);
  const sizes = useMemo(() => boxSizes(current, measureText), [current]);
  const layoutRequest = useMemo(
    () => (manual || busy ? null : { graph: toElk(current, sizes, direction, measureText), view: current, direction }),
    [manual, busy, current, sizes, direction],
  );
  const { arranged, arranging, error: layoutError } = useAutoLayout(layoutRequest);

  const byId = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);
  const edgeIds = useMemo(() => new Set(model.edges.map((e) => e.id)), [model.edges]);

  const manualFlow = useMemo(() => {
    if (!manual) return null;
    const positions = new Map(current.nodes.map((v) => [v.id, { x: v.node?.x ?? 0, y: v.node?.y ?? 0 }]));
    const { sizes: placed, fits } = manualSizes(current, sizes, positions, measureText);
    const rects = new Map<string, Rect>();
    for (const v of current.nodes) {
      rects.set(v.id, { x: v.node?.x ?? 0, y: v.node?.y ?? 0, ...(placed.get(v.id) ?? { width: BOX.minWidth, height: 60 }) });
    }
    return buildFlow({
      view: current,
      rects,
      fits,
      current: byId,
      currentEdges: edgeIds,
      manual: true,
      editable,
      direction,
      labelsAlways: labelsInLayout(current),
    });
  }, [manual, current, sizes, byId, edgeIds, editable, direction]);

  // The automatic layout draws the last finished layout, with the boxes' text as it is now.
  const autoFlow = useMemo(() => {
    if (manual || !arranged) return null;
    const { view: shown, direction: laidOut } = arranged.request;
    return buildFlow({
      view: shown,
      rects: arranged.layout.nodes,
      routes: arranged.layout.edges,
      current: byId,
      currentEdges: edgeIds,
      manual: false,
      editable,
      direction: laidOut,
      labelsAlways: labelsInLayout(shown),
    });
  }, [manual, arranged, byId, edgeIds, editable]);

  const flow = manualFlow ?? autoFlow ?? NO_FLOW;
  const selectedNodeId = selection?.kind === 'node' ? selection.id : null;
  const selectedEdgeId = selection?.kind === 'edge' ? selection.id : null;
  const shownNodes = useMemo(() => flow.nodes.map((n) => (n.id === selectedNodeId ? { ...n, selected: true } : n)), [flow.nodes, selectedNodeId]);
  // A selected box in a packed group also shows its own arrows, which are otherwise summed at the group's border.
  const revealed = useMemo(
    () =>
      manual || !arranged || selectedNodeId === null
        ? []
        : revealedFlowEdges(revealedEdges(arranged.request.view, model.edges, selectedNodeId), flow.absolute),
    [manual, arranged, selectedNodeId, model.edges, flow.absolute],
  );
  const shownEdges = useMemo(() => {
    const edges = withSelection(flow.edges, selectionSet(flow.nodes, selectedNodeId), selectedEdgeId);
    return revealed.length ? [...edges, ...revealed] : edges;
  }, [flow.edges, flow.nodes, selectedNodeId, selectedEdgeId, revealed]);

  // React Flow's copy of the nodes: positions and sizes change in it while dragging and resizing.
  const [nodes, setNodes] = useState<DNode[]>(shownNodes);
  useEffect(() => setNodes(shownNodes), [shownNodes]);
  const onNodesChange = useCallback((changes: NodeChange<DNode>[]) => {
    // Selection is the page's own (one thing at a time), and deleting goes through onBeforeDelete.
    const kept = changes.filter((c) => c.type === 'position' || c.type === 'dimensions');
    if (kept.length) setNodes((ns) => applyNodeChanges(kept, ns));
  }, []);

  // Point the view at what was asked for, once the picture for it is drawn.
  const upToDate = manual || (arranged !== null && arranged.request === layoutRequest);
  useEffect(() => {
    if (!pendingFit.current || !flowApi || !upToDate || !nodes.length) return;
    const frame = requestAnimationFrame(() => {
      const want = pendingFit.current;
      pendingFit.current = null;
      if (want !== 'all' && want && nodes.some((n) => n.id === want.id)) {
        void flowApi.fitView({ nodes: [{ id: want.id }], padding: 0.25, duration: 250, maxZoom: 1.25 });
      } else if (want) {
        void flowApi.fitView({ padding: 0.08, duration: 200, maxZoom: 1.25 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [flowApi, nodes, upToDate]);

  /** Changes what is visible. Showing a lot more boxes at once asks first (automatic layout only). */
  const changeView = useCallback(
    async (next: ViewState, focus?: string) => {
      const m = modelRef.current;
      if (m.settings.layout === 'auto') {
        const before = buildView(m.nodes, m.edges, viewRef.current).nodes.length;
        const after = buildView(m.nodes, m.edges, next).nodes.length;
        if (after > BIG_VIEW && after > before) {
          const ok = await askConfirm({
            title: `Show ${after} boxes at once?`,
            body: 'Arranging that many boxes can take several seconds, and moving around may feel slow. Opening one group at a time, or hiding some layers, keeps it quick.',
            confirmLabel: `Show ${after} boxes`,
            danger: false,
          });
          if (!ok) return;
        }
      }
      pendingFit.current = focus !== undefined ? { id: focus } : 'all';
      setView(next);
    },
    [setView],
  );

  const toggle = useCallback((id: string) => void changeView(toggleOpen(viewRef.current, id), id), [changeView]);
  const resized = useCallback(
    (id: string, size: { width: number; height: number }) =>
      commit((m) => ({ ...m, nodes: m.nodes.map((n) => (n.id === id ? { ...n, width: Math.round(size.width), height: Math.round(size.height) } : n)) })),
    [commit],
  );
  const actions = useMemo<DiagramActions>(() => ({ editable, manual, toggle, resized }), [editable, manual, toggle, resized]);

  // ---- Editing ----------------------------------------------------------------------------------------------

  const select = (next: Selection) => {
    setSelection(next);
    setPanelOpen(false);
  };

  const addBox = () => {
    const m = modelRef.current;
    if (m.nodes.length >= limits.nodes) {
      toast(`A diagram can have at most ${limits.nodes} boxes`, 'error');
      return;
    }
    const id = newId(new Set(m.nodes.map((n) => n.id)));
    const taken = new Set(m.nodes.filter((n) => n.parent === undefined).map((n) => n.label.toLowerCase()));
    let label = 'New box';
    for (let i = 2; taken.has(label.toLowerCase()); i++) label = `New box ${i}`;
    const layer = 'core';
    // In the manual layout it goes where the view is looking; the automatic one finds it a place.
    const rect = wrapRef.current?.getBoundingClientRect();
    const at = flowApi && rect ? flowApi.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    commit((cur) => ({ ...cur, nodes: [...cur.nodes, { id, label, description: '', layer, x: snap(at.x - BOX.minWidth / 2), y: snap(at.y - 30) }] }));
    const v = viewRef.current;
    if (v.hiddenLayers.includes(layer)) setView({ ...v, hiddenLayers: v.hiddenLayers.filter((l) => l !== layer) });
    setSelection({ kind: 'node', id });
    setPanelOpen(true);
  };

  const updateNode = (id: string, patch: Partial<DiagramNode>) =>
    commit((m) => ({ ...m, nodes: m.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));

  const moveNode = async (id: string, parent: string | undefined) => {
    const m = modelRef.current;
    const node = m.nodes.find((n) => n.id === id);
    if (!node || node.parent === parent) return;
    let dropped: DiagramEdge[];
    try {
      dropped = moveIntoGroup(m.nodes, m.edges, id, parent).dropped;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return;
    }
    if (dropped.length) {
      const ok = await askConfirm({
        title: dropped.length === 1 ? 'Remove an arrow?' : `Remove ${dropped.length} arrows?`,
        body: `An arrow can't join a box and a group it is inside, so ${plural(dropped.length, 'arrow')} between "${clip(node.label)}" (or what is inside it) and its new group will be removed.`,
        confirmLabel: dropped.length === 1 ? 'Move and remove it' : 'Move and remove them',
      });
      if (!ok) return;
    }
    commit((cur) => {
      const r = moveIntoGroup(cur.nodes, cur.edges, id, parent);
      return { ...cur, nodes: r.nodes, edges: r.edges };
    });
  };

  const updateEdge = (id: string, patch: Partial<DiagramEdge>) =>
    commit((m) => ({ ...m, edges: m.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));

  // Deleting always asks first, from the keyboard (onBeforeDelete) or a panel. While a question is open,
  // another Delete key press must not ask a second one.
  const askingRef = useRef(false);

  const deleteBoxes = async (ids: string[]) => {
    if (askingRef.current) return;
    const m = modelRef.current;
    const targets = m.nodes.filter((n) => ids.includes(n.id));
    if (!targets.length) return;
    const gone = new Set(targets.map((t) => t.id));
    const inside = new Set<string>();
    for (const t of targets) for (const d of descendantsOf(m.nodes, t.id)) if (!gone.has(d)) inside.add(d);
    const arrowsTo = (set: Set<string>) => m.edges.filter((e) => set.has(e.source) || set.has(e.target)).length;
    const own = arrowsTo(gone);
    const names = targets.slice(0, 3).map((t) => `"${clip(t.label)}"`);
    if (targets.length > 3) names.push(plural(targets.length - 3, 'more box', 'more boxes'));
    const lines = [`${joinAnd(names)} will be removed from the diagram${own ? `, with ${plural(own, 'arrow')}` : ''}.`];
    if (inside.size) lines.push(`The ${plural(inside.size, 'box', 'boxes')} inside move up a level unless you tick the box below.`);
    lines.push("This can't be undone.");
    const question = {
      title: targets.length === 1 ? 'Delete box?' : `Delete ${targets.length} boxes?`,
      body: lines.join(' '),
      confirmLabel: targets.length === 1 ? 'Delete box' : `Delete ${targets.length} boxes`,
    };
    askingRef.current = true;
    let answer: { ok: boolean; checked: boolean };
    try {
      if (inside.size) {
        const all = new Set([...gone, ...inside]);
        const extra = arrowsTo(all) - own;
        answer = await askConfirm({
          ...question,
          checkbox: `Also delete the ${plural(inside.size, 'box', 'boxes')} inside${extra ? ` (and ${plural(extra, 'more arrow')})` : ''}`,
        });
      } else {
        answer = { ok: await askConfirm(question), checked: false };
      }
    } finally {
      askingRef.current = false;
    }
    if (!answer.ok) return;
    commit((cur) => {
      const r = removeBoxes(cur.nodes, cur.edges, ids, answer.checked);
      return { ...cur, nodes: r.nodes, edges: r.edges };
    });
    select(null);
  };

  const deleteArrows = async (ids: string[]) => {
    if (askingRef.current) return;
    const m = modelRef.current;
    const arrows = m.edges.filter((e) => ids.includes(e.id));
    if (!arrows.length) return;
    const label = (id: string) => `"${clip(m.nodes.find((n) => n.id === id)?.label ?? '?')}"`;
    askingRef.current = true;
    let ok: boolean;
    try {
      ok = await askConfirm({
        title: arrows.length === 1 ? 'Delete arrow?' : `Delete ${arrows.length} arrows?`,
        body:
          arrows.length === 1
            ? `The arrow from ${label(arrows[0].source)} to ${label(arrows[0].target)} will be removed. This can't be undone.`
            : `${plural(arrows.length, 'arrow')} will be removed. This can't be undone.`,
        confirmLabel: arrows.length === 1 ? 'Delete arrow' : `Delete ${arrows.length} arrows`,
      });
    } finally {
      askingRef.current = false;
    }
    if (!ok) return;
    const gone = new Set(arrows.map((e) => e.id));
    commit((cur) => ({ ...cur, edges: cur.edges.filter((e) => !gone.has(e.id)) }));
    select(null);
  };

  /** Why two boxes can't be joined by a new arrow: a message, '' for no message, or null when they can. */
  const connectProblem = useCallback(
    (source: string | null | undefined, target: string | null | undefined): string | null => {
      const m = modelRef.current;
      if (!source || !target || source === target || isLayerGroup(source) || isLayerGroup(target)) return '';
      if (!m.nodes.some((n) => n.id === source) || !m.nodes.some((n) => n.id === target)) return '';
      if (descendantsOf(m.nodes, source).has(target) || descendantsOf(m.nodes, target).has(source)) {
        return "An arrow can't join a box and a group it is inside.";
      }
      if (m.edges.some((e) => e.source === source && e.target === target)) return 'Those boxes are already joined by an arrow that way.';
      if (m.edges.length >= limits.edges) return `A diagram can have at most ${limits.edges} arrows.`;
      return null;
    },
    [limits.edges],
  );

  const onConnect = (c: Connection) => {
    const problem = connectProblem(c.source, c.target);
    if (problem !== null) {
      if (problem) toast(problem, 'error');
      return;
    }
    commit((m) => ({ ...m, edges: [...m.edges, { id: newId(new Set(m.edges.map((e) => e.id))), source: c.source, target: c.target, label: '' }] }));
  };

  const onNodeDragStop = (_: unknown, __: DNode, dragged: DNode[]) => {
    const moved = new Map(dragged.map((n) => [n.id, n.position]));
    const m = modelRef.current;
    let changed = false;
    const nodes = m.nodes.map((n) => {
      const p = moved.get(n.id);
      if (!p) return n;
      // Inside a group, stay clear of its header and border.
      const inGroup = n.parent !== undefined;
      const x = snap(inGroup ? Math.max(BOX.groupPad, p.x) : p.x);
      const y = snap(inGroup ? Math.max(BOX.groupHeader + BOX.groupPad, p.y) : p.y);
      if (x === n.x && y === n.y) return n;
      changed = true;
      return { ...n, x, y };
    });
    if (changed) commit((cur) => ({ ...cur, nodes }));
    else setNodes(shownNodes); // back to the stored place if it only wobbled
  };

  // ---- Layout and view settings -------------------------------------------------------------------------------

  /** Lays out every box with all groups open (for the manual layout's starting positions). */
  const arrangeAll = async (): Promise<Layout | null> => {
    setBusy(true);
    try {
      const m = modelRef.current;
      const full = buildView(m.nodes, m.edges, { openByDefault: true, flipped: [], hiddenLayers: [], byLayer: false }, true);
      return fromElk(await layoutGraph(toElk(full, boxSizes(full, measureText), m.settings.direction, measureText)));
    } catch (err) {
      if (!(err instanceof Superseded)) toast(errorMessage(err), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const switchLayout = async (layout: DiagramSettings['layout']) => {
    if (layout === modelRef.current.settings.layout) return;
    if (layout === 'auto') {
      pendingFit.current = 'all';
      commit((m) => ({ ...m, settings: { ...m.settings, layout } }));
      return;
    }
    const answer = await askConfirm({
      title: 'Switch to the manual layout?',
      body: 'You place and size the boxes yourself, and the diagram stops arranging itself. This is saved for everyone who opens it. You can switch back at any time.',
      confirmLabel: 'Switch to manual',
      danger: false,
      checkbox: 'Start from the automatic layout (replaces the saved positions)',
    });
    if (!answer.ok) return;
    const arranged = answer.checked ? await arrangeAll() : null;
    if (answer.checked && !arranged) return;
    pendingFit.current = 'all';
    commit((m) => ({ ...m, nodes: arranged ? arrangedNodes(m.nodes, arranged) : m.nodes, settings: { ...m.settings, layout } }));
  };

  const autoArrange = async () => {
    const ok = await askConfirm({
      title: 'Auto-arrange the boxes?',
      body: 'Every box gets a new place, and every group a new size, laid out automatically. Places you set by hand are replaced.',
      confirmLabel: 'Auto-arrange',
      danger: false,
    });
    if (!ok) return;
    const layout = await arrangeAll();
    if (!layout) return;
    pendingFit.current = 'all';
    commit((m) => ({ ...m, nodes: arrangedNodes(m.nodes, layout) }));
  };

  const setDirection = (d: DiagramSettings['direction']) => {
    pendingFit.current = 'all';
    commit((m) => ({ ...m, settings: { ...m.settings, direction: d } }));
  };

  const toggleLayer = (layer: string) => {
    const v = viewRef.current;
    const hidden = v.hiddenLayers.includes(layer) ? v.hiddenLayers.filter((l) => l !== layer) : [...v.hiddenLayers, layer];
    void changeView({ ...v, hiddenLayers: hidden });
  };

  // ---- The diagram as a whole -----------------------------------------------------------------------------------

  const rename = () => {
    const name = window.prompt('Diagram name', diagram.name)?.trim().slice(0, 200);
    if (!name || name === diagram.name) return;
    // Through the same save queue, so it can't collide with an autosave on the version check.
    pendingNameRef.current = name;
    editsRef.current++;
    setSaving('pending');
    void save();
  };

  const deleteDiagram = async () => {
    const m = modelRef.current;
    const ok = await askConfirm({
      title: 'Delete diagram?',
      body: `"${diagram.name}" will be deleted, with its ${plural(m.nodes.length, 'box', 'boxes')} and ${plural(m.edges.length, 'arrow')}. This can't be undone.`,
      confirmLabel: 'Delete diagram',
      // A big diagram is a lot of work to lose: make sure this one is meant.
      typeToConfirm: m.nodes.length > 50 ? diagram.name : undefined,
    });
    if (!ok) return;
    if (await mutate(() => api.del(`${V1}/diagrams/${diagram.id}`), ['diagrams'])) {
      // Nothing left to save it to.
      window.clearTimeout(timerRef.current);
      savedEditsRef.current = editsRef.current;
      onDeleted();
    }
  };

  const exportJson = () => {
    const m = modelRef.current;
    const text = JSON.stringify({ name: diagram.name, settings: m.settings, nodes: m.nodes, edges: m.edges }, null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${diagram.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram'}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const startImport = (mode: 'merge' | 'replace') => {
    importModeRef.current = mode;
    fileRef.current?.click();
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file again still counts
    if (!file) return;
    let parsed: { nodes?: unknown; edges?: unknown; settings?: unknown } | null;
    try {
      parsed = JSON.parse(await file.text()) as typeof parsed;
    } catch {
      toast(`${file.name} isn't valid JSON.`, 'error');
      return;
    }
    if (!parsed || !Array.isArray(parsed.nodes)) {
      toast('The file needs a "nodes" list, like a diagram exported from here.', 'error');
      return;
    }
    // Save waiting edits first, so the import builds on them.
    await save();
    if (isDirty()) {
      toast('The diagram has unsaved changes. Try again once it says Saved.', 'error');
      return;
    }
    const mode = importModeRef.current;
    const body = {
      mode,
      nodes: parsed.nodes,
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      ...(parsed.settings && typeof parsed.settings === 'object' ? { settings: parsed.settings } : {}),
    };
    const url = `${V1}/diagrams/${diagram.id}/import`;
    try {
      const preview = await api.post<ImportResult>(url, { ...body, dryRun: true });
      const changes = importChanges(preview, false);
      if (!changes) {
        toast(`Nothing to import: the diagram already matches ${clip(file.name)}.`);
        return;
      }
      const removing = preview.nodes.removed > 0 || preview.edges.removed > 0;
      const ok = await askConfirm({
        title: mode === 'replace' ? `Replace "${clip(diagram.name)}" with ${clip(file.name)}?` : `Import ${clip(file.name)}?`,
        body: `This will ${changes}.${removing ? " Removed boxes and arrows can't be brought back." : ''}`,
        confirmLabel: 'Import',
        danger: removing,
      });
      if (!ok) return;
      const done = await api.post<ImportResult>(url, { ...body, version: versionRef.current });
      toast(`Imported: ${importChanges(done, true) || 'nothing changed'}.`);
      pendingFit.current = 'all';
      reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
      if (err instanceof ApiError && err.status === 409) reload();
    }
  };

  // ---- What is selected -----------------------------------------------------------------------------------------

  const viewNodeOf = (id: string) => current.nodes.find((v) => v.id === id) ?? arranged?.request.view.nodes.find((v) => v.id === id);
  const selNode = selectedNodeId !== null ? (byId.get(selectedNodeId) ?? null) : null;
  const selView = selectedNodeId !== null ? viewNodeOf(selectedNodeId) : undefined;
  const selEdge = selectedEdgeId !== null ? (model.edges.find((e) => e.id === selectedEdgeId) ?? null) : null;
  const selBundle =
    selectedEdgeId !== null && !selEdge
      ? (current.edges.find((e) => e.id === selectedEdgeId) ?? arranged?.request.view.edges.find((e) => e.id === selectedEdgeId))
      : undefined;
  const selectionGone = selection !== null && !selNode && !selView && !selEdge && !selBundle;
  useEffect(() => {
    if (selectionGone) {
      setSelection(null);
      setPanelOpen(false);
    }
  }, [selectionGone]);

  const labelOf = (id: string) => byId.get(id)?.label ?? viewNodeOf(id)?.label ?? id;
  const allLayers = useMemo(() => [...new Set([...layers, ...model.nodes.map((n) => n.layer)])], [layers, model.nodes]);
  const layerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of model.nodes) counts.set(n.layer, (counts.get(n.layer) ?? 0) + 1);
    const order = [...layers.filter((l) => counts.has(l)), ...[...counts.keys()].filter((l) => !layers.includes(l))];
    return order.map((layer) => ({ layer, count: counts.get(layer) ?? 0 }));
  }, [model.nodes, layers]);
  const foldable = model.nodes.some((n) => n.parent !== undefined) || (!manual && view.byLayer);
  const groupState = (kind: string | undefined) => (kind === 'group' ? 'open' : kind === 'closed' ? 'closed' : null);

  let inspector = null;
  if (selection && !panelOpen) {
    if (selView || selNode) {
      const label = selNode?.label ?? selView?.label ?? '';
      const layer = selNode?.layer ?? selView?.layer ?? '';
      const role = roleOf(selNode);
      const state = groupState(selView?.kind);
      inspector = (
        <Inspector
          onClose={() => select(null)}
          actions={
            <>
              {state && selView && (
                <button type="button" className="btn btn-sm" onClick={() => toggle(selView.id)}>
                  {state === 'open' ? 'Close' : 'Open'}
                </button>
              )}
              {selNode && (
                <button type="button" className="btn btn-sm" onClick={() => setPanelOpen(true)}>
                  {editable ? 'Edit' : 'Details'}
                </button>
              )}
            </>
          }
        >
          <div className="row nowrap" style={{ gap: 6 }}>
            <span className="dot" style={{ background: layerColor(layer) }} />
            <b className="ellipsis">{label}</b>
            <span className="tiny muted nowrap">
              {layer}
              {selView && selView.inside > 0 ? ` · ${selView.inside} inside` : ''}
            </span>
          </div>
          {selNode?.path && <div className="mono tiny muted ellipsis">{selNode.path}</div>}
          {role && <div className="small muted ellipsis">{role}</div>}
        </Inspector>
      );
    } else if (selEdge || selBundle) {
      const e = selEdge ?? selBundle!;
      const count = selEdge ? (selEdge.count ?? 1) : selBundle!.count;
      const text = selEdge ? selEdge.label : selBundle!.text;
      inspector = (
        <Inspector
          onClose={() => select(null)}
          actions={
            <button type="button" className="btn btn-sm" onClick={() => setPanelOpen(true)}>
              {selEdge && editable ? 'Edit' : 'Details'}
            </button>
          }
        >
          <div className="ellipsis">
            <b>{labelOf(e.source)}</b> → <b>{labelOf(e.target)}</b>
          </div>
          <div className="small muted ellipsis">
            {selBundle ? `${plural(selBundle.members.length, 'arrow')} added up${text ? ` · ${text}` : ''}` : [text, count > 1 ? `×${count}` : ''].filter(Boolean).join(' ') || 'No label'}
          </div>
        </Inspector>
      );
    }
  }

  return (
    <DiagramContext.Provider value={actions}>
      <Toolbar
        name={diagram.name}
        saving={saving}
        editable={editable}
        onEditable={setEditable}
        canAdd={model.nodes.length < limits.nodes && !busy}
        onAdd={addBox}
        onMore={() => setMoreOpen(true)}
        settings={model.settings}
        onLayout={(l) => void switchLayout(l)}
        onDirection={setDirection}
        view={view}
        foldable={foldable}
        onByLayer={(on) => void changeView({ ...viewRef.current, byLayer: on })}
        onOpenAll={(open) => void changeView(openAll(viewRef.current, open))}
        layers={layerCounts}
        onToggleLayer={toggleLayer}
        hiddenCount={current.hiddenCount}
        packed={!manual && current.packed.size > 0}
        busy={busy}
      />
      <div ref={wrapRef} className={cx('diagram-wrap', editable && 'diagram-edit')} style={boxCssVars}>
        <ReactFlow<DNode, ArrowEdge>
          nodes={nodes}
          edges={shownEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={setFlowApi}
          onNodesChange={onNodesChange}
          onNodeClick={(_, n) => select({ kind: 'node', id: n.id })}
          onNodeDoubleClick={(_, n) => {
            if (n.data.v.kind === 'closed') toggle(n.id);
            else if (n.data.node) {
              setSelection({ kind: 'node', id: n.id });
              setPanelOpen(true);
            }
          }}
          onEdgeClick={(_, e) => select({ kind: 'edge', id: e.id })}
          onPaneClick={() => select(null)}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          isValidConnection={(c) => connectProblem(c.source, c.target) === null}
          onConnectEnd={(event, state) => {
            // Dropped on a box rather than on one of its dots: connect to that box all the same (or say why not).
            if (state.isValid || !state.fromNode) return;
            const at = 'changedTouches' in event ? event.changedTouches[0] : event;
            const target = at && document.elementFromPoint(at.clientX, at.clientY)?.closest<HTMLElement>('.react-flow__node')?.dataset.id;
            if (target && target !== state.fromNode.id) onConnect({ source: state.fromNode.id, target, sourceHandle: null, targetHandle: null });
          }}
          onBeforeDelete={async ({ nodes: ns, edges: es }) => {
            const boxes = ns.filter((n) => n.data.node).map((n) => n.id);
            const arrows = es.filter((e) => !e.data?.bundle).map((e) => e.id);
            if (boxes.length) await deleteBoxes(boxes);
            else if (arrows.length) await deleteArrows(arrows);
            return false; // the model changes instead, and React Flow follows it
          }}
          nodesDraggable={manual && editable}
          nodesConnectable={editable}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          multiSelectionKeyCode={null}
          selectionKeyCode={null}
          connectionMode={ConnectionMode.Loose}
          connectionRadius={28}
          snapToGrid={manual}
          snapGrid={[GRID, GRID]}
          onlyRenderVisibleElements={nodes.length > ONLY_VISIBLE_ABOVE}
          zoomOnDoubleClick={false}
          minZoom={0.05}
          maxZoom={2.5}
          colorMode="system"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={GRID} />
          <Controls showInteractive={false} />
          {nodes.length > 0 && (
            <MiniMap<DNode>
              pannable
              zoomable
              className="hide-mobile"
              nodeColor={(n) => (n.type === 'dgroup' ? 'transparent' : n.data.color)}
              nodeStrokeColor={(n) => n.data.color}
              nodeStrokeWidth={3}
            />
          )}
        </ReactFlow>
        {(arranging || busy) && (
          <div className="diagram-busy" role="status">
            Arranging…
          </div>
        )}
        {layoutError && !arranging && !manual && (
          <div className="diagram-error" role="alert">
            {layoutError}
          </div>
        )}
        {!model.nodes.length && (
          <div className="diagram-empty">
            {editable ? 'No boxes yet. Add one with + Box, or import a JSON file from the ⋯ menu.' : 'No boxes yet. Turn on Edit to add some.'}
          </div>
        )}
        {inspector}
      </div>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void importFile(e)} />
      {moreOpen && (
        <MoreSheet
          editable={editable}
          manual={manual}
          onRename={rename}
          onExport={exportJson}
          onImport={startImport}
          onArrange={() => void autoArrange()}
          onDelete={() => void deleteDiagram()}
          onClose={() => setMoreOpen(false)}
        />
      )}
      {panelOpen && selNode && (
        <NodePanel
          key={selNode.id}
          node={selNode}
          nodes={model.nodes}
          edges={model.edges}
          layers={allLayers}
          editable={editable}
          depthLimit={limits.depth}
          group={groupState(selView?.kind)}
          onToggle={() => toggle(selNode.id)}
          onChange={(patch) => updateNode(selNode.id, patch)}
          onMove={(parent) => void moveNode(selNode.id, parent)}
          onDelete={() => void deleteBoxes([selNode.id])}
          onClose={() => setPanelOpen(false)}
        />
      )}
      {panelOpen && selEdge && (
        <EdgePanel
          key={selEdge.id}
          edge={selEdge}
          from={labelOf(selEdge.source)}
          to={labelOf(selEdge.target)}
          editable={editable}
          onChange={(patch) => updateEdge(selEdge.id, patch)}
          onDelete={() => void deleteArrows([selEdge.id])}
          onClose={() => setPanelOpen(false)}
        />
      )}
      {panelOpen && selBundle && (
        <BundlePanel
          edge={selBundle}
          labelOf={labelOf}
          openable={[selBundle.source, selBundle.target].filter((id, i, all) => all.indexOf(id) === i && viewNodeOf(id)?.kind === 'closed')}
          onOpen={(id) => {
            setPanelOpen(false);
            toggle(id);
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </DiagramContext.Provider>
  );
}

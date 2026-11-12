import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ApiError, api, V1 } from '../api';
import { useDiagram, useDiagrams, useEpochs, useTree } from '../hooks';
import { useProject } from '../projectContext';
import { useMutate } from '../mutate';
import type { Diagram, DiagramEdge, DiagramNode } from '../types';
import { LAYER_COLORS, cx, errorMessage } from '../util';
import { Spinner } from '../components/Bits';
import { PageHeader, useTaskParam } from '../components/Layout';
import { Sheet, confirmAction } from '../components/Sheet';
import { useToast } from '../components/Toast';

type NodeData = { label: string; description: string; layer: string; link: DiagramNode['link'] };
type ArchNode = Node<NodeData, 'arch'>;

const layerColor = (layer: string) => LAYER_COLORS[layer] ?? '#64748b';

function ArchNodeView({ data, selected }: NodeProps<ArchNode>) {
  const color = layerColor(data.layer);
  return (
    <div className={cx('diagram-node', selected && 'selected')} style={{ borderColor: color }}>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
      <div className="layer" style={{ color }}>{data.layer}{data.link ? ' · 🔗' : ''}</div>
      <div className="label">{data.label}</div>
      {data.description && <div className="desc">{data.description.length > 90 ? data.description.slice(0, 90) + '…' : data.description}</div>}
    </div>
  );
}
const nodeTypes = { arch: ArchNodeView };

const toFlowNode = (n: DiagramNode): ArchNode => ({
  id: n.id,
  type: 'arch',
  position: { x: n.x, y: n.y },
  data: { label: n.label, description: n.description, layer: n.layer, link: n.link ?? null },
});
const toFlowEdge = (e: DiagramEdge): Edge => ({
  id: e.id,
  source: e.source,
  target: e.target,
  label: e.label || undefined,
  markerEnd: { type: MarkerType.ArrowClosed },
});
const fromFlow = (nodes: ArchNode[], edges: Edge[]) => ({
  nodes: nodes.map((n) => ({
    id: n.id, label: n.data.label, description: n.data.description, layer: n.data.layer,
    x: Math.round(n.position.x), y: Math.round(n.position.y), link: n.data.link ?? null,
  })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : '' })),
});
const newId = () => Math.random().toString(16).slice(2, 12);

export function DiagramPage() {
  const list = useDiagrams().data;
  const mutate = useMutate();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const id = selectedId ?? list?.diagrams[0]?.id ?? null;
  const { data: diagram } = useDiagram(id);

  const createDiagram = async () => {
    const name = window.prompt('Diagram name');
    if (!name?.trim()) return;
    const d = await mutate(() => api.post<Diagram>(`${V1}/diagrams`, { name: name.trim() }), ['diagrams']);
    if (d) setSelectedId(d.id);
  };

  return (
    <>
      <PageHeader title="Architecture">
        {list && list.diagrams.length > 1 && (
          <select value={id ?? ''} onChange={(e) => setSelectedId(Number(e.target.value))} style={{ width: 'auto', minHeight: 34 }}>
            {list.diagrams.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        <button className="btn btn-sm" onClick={createDiagram}>+ Diagram</button>
      </PageHeader>
      <div className="content flush">
        {!list ? <Spinner /> : !id ? <div className="empty">No diagrams. Create one.</div> : diagram ? (
          <Editor key={diagram.id} diagram={diagram} layers={list.layers} onDeleted={() => setSelectedId(null)} />
        ) : <Spinner />}
      </div>
    </>
  );
}

function Editor({ diagram, layers, onDeleted }: { diagram: Diagram; layers: string[]; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mutate = useMutate();
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchNode>(diagram.nodes.map(toFlowNode));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(diagram.edges.map(toFlowEdge));
  const [editMode, setEditMode] = useState(() => window.innerWidth >= 900);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving' | 'error'>('idle');
  const flowRef = useRef<ReactFlowInstance<ArchNode, Edge> | null>(null);

  const versionRef = useRef(diagram.version);
  // Every local edit bumps `edits`; `savedEdits` is the edit count the server has. Dirty = they differ.
  // Counting (rather than a boolean) keeps edits made *while* a save is in flight from being marked saved.
  const editsRef = useRef(0);
  const savedEditsRef = useRef(0);
  const inflightRef = useRef<Promise<void> | null>(null);
  const pendingNameRef = useRef<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const stateRef = useRef({ nodes, edges });
  stateRef.current = { nodes, edges };
  const isDirty = () => editsRef.current !== savedEditsRef.current;

  // Pull in changes made elsewhere (e.g. by Claude) when we have no unsaved edits.
  useEffect(() => {
    if (isDirty() || diagram.version === versionRef.current) return;
    versionRef.current = diagram.version;
    setNodes(diagram.nodes.map(toFlowNode));
    setEdges(diagram.edges.map(toFlowEdge));
  }, [diagram, setNodes, setEdges]);

  /** Saves until the server has every edit. Only one PUT is ever in flight, so saves never race each other. */
  const save = useCallback((): Promise<void> => {
    if (inflightRef.current) return inflightRef.current; // the running loop will pick up newer edits
    const run = async () => {
      while (isDirty()) {
        const editsAtSend = editsRef.current;
        const name = pendingNameRef.current;
        setSaving('saving');
        try {
          const body = { version: versionRef.current, ...(name ? { name } : {}), ...fromFlow(stateRef.current.nodes, stateRef.current.edges) };
          const res = await api.put<Diagram>(`${V1}/diagrams/${diagram.id}`, body);
          versionRef.current = res.version;
          savedEditsRef.current = editsAtSend;
          qc.setQueryData(['diagram', diagram.id], res);
          if (name) {
            pendingNameRef.current = null;
            void qc.invalidateQueries({ queryKey: ['diagrams'] });
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            // Someone else saved first: drop our edits and load theirs.
            toast('Someone else changed this diagram — reloaded the latest version.', 'error');
            savedEditsRef.current = editsRef.current;
            pendingNameRef.current = null;
            versionRef.current = -1;
            void qc.invalidateQueries({ queryKey: ['diagram', diagram.id] });
          } else {
            // Network trouble (phone Wi-Fi): keep the edits and try again shortly.
            toast(errorMessage(err), 'error');
            window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              timerRef.current = undefined;
              void save();
            }, 5000);
          }
          setSaving('error');
          return;
        }
      }
      setSaving('idle');
    };
    inflightRef.current = run().finally(() => {
      inflightRef.current = null;
      // Edits that arrived during the last request get their own save.
      if (isDirty() && !timerRef.current) void save();
    });
    return inflightRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram.id, qc, toast]);

  const scheduleSave = useCallback(() => {
    editsRef.current++;
    setSaving('pending');
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void save();
    }, 600);
  }, [save]);

  // Flush pending edits when leaving the page.
  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    if (isDirty()) void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save]);

  const onConnect = (c: Connection) => {
    setEdges((es) => addEdge({ ...c, id: newId(), markerEnd: { type: MarkerType.ArrowClosed } }, es));
    scheduleSave();
  };

  const addNode = () => {
    const center = flowRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 0, y: 0 };
    const id = newId();
    setNodes((ns) => [...ns, toFlowNode({ id, label: 'New component', description: '', layer: 'core', x: center.x - 60, y: center.y - 30 })]);
    setSelected(id);
    scheduleSave();
  };

  const updateNode = (id: string, data: Partial<NodeData>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)));
    scheduleSave();
  };
  const deleteNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelected(null);
    scheduleSave();
  };

  const renameDiagram = () => {
    const name = window.prompt('Diagram name', diagram.name);
    if (!name?.trim()) return;
    // Goes through the same save queue, so it can't collide with an autosave on the version check.
    pendingNameRef.current = name.trim();
    editsRef.current++;
    void save();
  };
  const deleteDiagram = async () => {
    if (!confirmAction(`Delete diagram "${diagram.name}"?`)) return;
    if (await mutate(() => api.del(`${V1}/diagrams/${diagram.id}`), ['diagrams'])) onDeleted();
  };

  const selectedNode = nodes.find((n) => n.id === selected) ?? null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;
  const setSelectedEdge = (id: string) => setSelectedEdgeId(id);
  const usedLayers = [...new Set([...layers, ...nodes.map((n) => n.data.layer)])];

  return (
    <>
      <div className="diagram-toolbar">
        <strong className="grow ellipsis">{diagram.name}</strong>
        <span className="tiny muted">{saving === 'pending' || saving === 'saving' ? 'Saving…' : saving === 'error' ? 'Not saved' : 'Saved'}</span>
        <label className="row nowrap small" style={{ gap: 6 }}>
          <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} /> Edit
        </label>
        {editMode && <button className="btn btn-sm btn-primary" onClick={addNode}>+ Box</button>}
        {editMode && <button className="btn btn-sm" onClick={renameDiagram}>Rename</button>}
        {editMode && <button className="btn btn-sm btn-danger" onClick={deleteDiagram}>Delete</button>}
      </div>
      <div className="diagram-toolbar legend" style={{ paddingTop: 4, paddingBottom: 4 }}>
        {usedLayers.map((l) => <span key={l} className="row nowrap" style={{ gap: 4 }}><span className="dot" style={{ background: layerColor(l) }} />{l}</span>)}
        {editMode && <span className="muted">Drag from a dot to connect · tap a box or line to edit it</span>}
      </div>
      <div className="diagram-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(inst) => { flowRef.current = inst; }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={() => scheduleSave()}
          onNodesDelete={() => scheduleSave()}
          onEdgesDelete={() => scheduleSave()}
          onConnect={onConnect}
          onNodeClick={(_, n) => setSelected(n.id)}
          // A single tap (works on phones, unlike double-click or the Delete key) opens the connection's options.
          onEdgeClick={(_, edge) => editMode && setSelectedEdge(edge.id)}
          nodesDraggable={editMode}
          nodesConnectable={editMode}
          deleteKeyCode={editMode ? ['Backspace', 'Delete'] : null}
          connectionMode={ConnectionMode.Loose}
          fitView
          colorMode="system"
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="hide-mobile" />
        </ReactFlow>
      </div>
      {selectedEdge && (
        <EdgePanel
          edge={selectedEdge}
          onClose={() => setSelectedEdgeId(null)}
          onLabel={(label) => {
            setEdges((es) => es.map((e) => (e.id === selectedEdge.id ? { ...e, label: label || undefined } : e)));
            scheduleSave();
          }}
          onDelete={() => {
            setEdges((es) => es.filter((e) => e.id !== selectedEdge.id));
            setSelectedEdgeId(null);
            scheduleSave();
          }}
        />
      )}
      {selectedNode && (
        <NodePanel node={selectedNode} layers={usedLayers} editMode={editMode} onClose={() => setSelected(null)}
          onChange={(d) => updateNode(selectedNode.id, d)} onDelete={() => deleteNode(selectedNode.id)} />
      )}
    </>
  );
}

/** Label or remove a connection. */
function EdgePanel({ edge, onClose, onLabel, onDelete }: { edge: Edge; onClose: () => void; onLabel: (label: string) => void; onDelete: () => void }) {
  const [label, setLabel] = useState(typeof edge.label === 'string' ? edge.label : '');
  // Blur and Done can both fire; only send a change once.
  const committed = useRef(label);
  const commit = () => {
    const v = label.trim();
    if (v !== committed.current) onLabel(v);
    committed.current = v;
  };
  return (
    <Sheet title="Connection" onClose={onClose} variant="center">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
          onClose();
        }}
      >
        <label className="field">
          Label (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. calls, emits, reads" maxLength={200}
            onBlur={commit} />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary grow">Done</button>
          <button type="button" className="btn btn-danger" onClick={onDelete}>Delete connection</button>
        </div>
      </form>
    </Sheet>
  );
}

function NodePanel({ node, layers, editMode, onClose, onChange, onDelete }: {
  node: ArchNode; layers: string[]; editMode: boolean; onClose: () => void; onChange: (d: Partial<NodeData>) => void; onDelete: () => void;
}) {
  const navigate = useNavigate();
  const [, openTask] = useTaskParam();
  const epochs = useEpochs().data ?? [];
  const tasks = useTree().data?.tasks;
  const { project } = useProject();
  const toast = useToast();
  const [label, setLabel] = useState(node.data.label);
  const [description, setDescription] = useState(node.data.description);
  const link = node.data.link;
  const linkedKey = link?.kind === 'task' ? (tasks?.find((t) => t.id === link.id)?.key ?? '') : '';
  // null = showing the linked task's key; a string = what the user is typing.
  const [taskDraft, setTaskDraft] = useState<string | null>(null);
  const commitTaskRef = () => {
    if (taskDraft === null) return;
    const raw = taskDraft.trim().toUpperCase();
    setTaskDraft(null);
    if (!raw) {
      if (link?.kind === 'task') onChange({ link: null });
      return;
    }
    // "12" means a task in this project; diagrams can only link to their own project's tasks.
    const key = /^\d+$/.test(raw) ? `${project.key}-${raw}` : raw;
    const task = tasks?.find((t) => t.key === key);
    if (task) onChange({ link: { kind: 'task', id: task.id } });
    else toast(`No task ${key} in ${project.name}`, 'error');
  };

  const followLink = () => {
    if (!link) return;
    if (link.kind === 'task') openTask(link.id);
    else if (link.kind === 'epoch') navigate(`/epochs/${link.id}`);
    else navigate('/explorer');
  };

  if (!editMode) {
    return (
      <Sheet title={node.data.label} onClose={onClose} variant="center">
        <div className="stack">
          <span className="pill" style={{ background: layerColor(node.data.layer), color: '#fff', justifySelf: 'start' }}>{node.data.layer}</span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{node.data.description || <span className="muted">No description.</span>}</div>
          {link && <button className="btn" onClick={followLink}>Open linked {link.kind} →</button>}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Edit box" onClose={onClose} variant="center">
      <div className="stack">
        <label className="field">Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() && label !== node.data.label && onChange({ label: label.trim() })} />
        </label>
        <label className="field">Layer
          <select value={node.data.layer} onChange={(e) => onChange({ layer: e.target.value })}>
            {layers.map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label className="field">Description
          <textarea value={description} rows={4} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== node.data.description && onChange({ description })} />
        </label>
        <div className="grid-2">
          <label className="field">Link to task
            <input value={taskDraft ?? linkedKey} placeholder={`${project.key}-12`} onChange={(e) => setTaskDraft(e.target.value)}
              onBlur={commitTaskRef} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
          <label className="field">…or epoch
            <select value={link?.kind === 'epoch' ? link.id : ''} onChange={(e) => onChange({ link: e.target.value ? { kind: 'epoch', id: Number(e.target.value) } : null })}>
              <option value="">None</option>
              {epochs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          {link && <button className="btn" onClick={followLink}>Open link</button>}
          <span className="grow" />
          <button className="btn btn-danger" onClick={onDelete}>Delete box</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Sheet>
  );
}

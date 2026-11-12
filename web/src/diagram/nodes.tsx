import { createContext, memo, useContext, type CSSProperties } from 'react';
import { Handle, NodeResizeControl, ResizeControlVariant, type NodeProps, type ResizeParams } from '@xyflow/react';
import { cx } from '../util';
import { SIDES, SIDE_POSITION, type BoxNode, type GroupNode } from './flow';
import type { Size } from './model';

/** What the boxes need from the page, shared through context so it never changes the nodes' data. */
export interface DiagramActions {
  /** Editing: connection points show; in the manual layout, the selected box gets resize handles. */
  editable: boolean;
  manual: boolean;
  toggle: (id: string) => void;
  resized: (id: string, size: Size) => void;
}

export const DiagramContext = createContext<DiagramActions>({
  editable: false,
  manual: false,
  toggle: () => undefined,
  resized: () => undefined,
});

/** The connection points (see staticHandles in flow.ts). Always there, as React Flow measures them; CSS hides them unless editing. */
function Handles() {
  return (
    <>
      {SIDES.map((side) => (
        <Handle key={side} id={side} type="source" position={SIDE_POSITION[side]} className={`dh dh-${side}`} />
      ))}
    </>
  );
}

/** Handles on the right, the bottom and the corner between them, so the top-left corner (and what is inside) stays put. */
function Resizer({ id, min }: { id: string; min: Size }) {
  const { resized } = useContext(DiagramContext);
  const limits = {
    minWidth: min.width,
    minHeight: min.height,
    maxWidth: 4000,
    maxHeight: 4000,
    onResizeEnd: (_: unknown, p: ResizeParams) => resized(id, { width: p.width, height: p.height }),
  };
  return (
    <>
      <NodeResizeControl position="right" variant={ResizeControlVariant.Line} className="dresize-line" {...limits} />
      <NodeResizeControl position="bottom" variant={ResizeControlVariant.Line} className="dresize-line" {...limits} />
      <NodeResizeControl position="bottom-right" className="dresize-handle" {...limits} />
    </>
  );
}

/** A plain box, or a closed group drawn as one box standing for everything inside it. */
export const BoxNodeView = memo(function BoxNodeView({ id, data, selected }: NodeProps<BoxNode>) {
  const { editable, manual, toggle } = useContext(DiagramContext);
  const { v, node, color, caption, role, min } = data;
  const closed = v.kind === 'closed';
  const label = node?.label ?? v.label;
  // The caption is measured as one string; a closed group's "▸ 12 inside" at its end is the open button.
  const opener = `▸ ${v.inside} inside`;
  return (
    <div
      className={cx('dbox', closed && 'closed', !node && 'made-up', selected && 'selected')}
      style={{ '--layer': color } as CSSProperties}
      title={role ? `${label}\n${role}` : label}
    >
      <Handles />
      {selected && editable && manual && node && !closed && <Resizer id={id} min={min} />}
      {/* The text is clipped inside the border; the handles above are not. */}
      <div className="dbox-body">
        <div className="dbox-caption">
          {closed && caption.endsWith(opener) ? (
            <>
              {caption.slice(0, caption.length - opener.length)}
              <button
                type="button"
                className="dbox-open nodrag"
                aria-label={`Open ${label} (${v.inside} inside)`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(id);
                }}
              >
                {opener}
              </button>
            </>
          ) : (
            caption
          )}
        </div>
        <div className="dbox-label">{label}</div>
        {node?.path && <div className="dbox-path">{node.path}</div>}
        {role && <div className="dbox-role">{role}</div>}
      </div>
    </div>
  );
});

/** An open group: a header with its name and the close button; React Flow draws what is inside on top. */
export const GroupNodeView = memo(function GroupNodeView({ id, data, selected }: NodeProps<GroupNode>) {
  const { editable, manual, toggle } = useContext(DiagramContext);
  const { v, node, color, min } = data;
  const label = node?.label ?? v.label;
  return (
    <div className={cx('dgroup', !node && 'made-up', selected && 'selected')} style={{ '--layer': color } as CSSProperties}>
      <Handles />
      {selected && editable && manual && node && <Resizer id={id} min={min} />}
      <div className="dgroup-head">
        <button
          type="button"
          className="dgroup-toggle nodrag"
          aria-expanded="true"
          aria-label={`Close ${label}`}
          title="Close"
          onClick={(e) => {
            e.stopPropagation();
            toggle(id);
          }}
        >
          ▾
        </button>
        <span className="dgroup-label" title={label}>
          {label}
        </span>
        {node?.link && <span title="Linked">🔗</span>}
        <span className="dgroup-count" title={`${v.inside} inside`}>
          {v.inside}
        </span>
      </div>
    </div>
  );
});

export const nodeTypes = { dbox: BoxNodeView, dgroup: GroupNodeView };

import { cx, plural } from '../util';
import { Sheet } from '../components/Sheet';
import { layerColor } from './flow';
import type { DiagramSettings, ViewState } from './model';

export type SaveState = 'idle' | 'pending' | 'saving' | 'error';

const SAVE_LABEL: Record<SaveState, string> = { idle: 'Saved', pending: 'Saving…', saving: 'Saving…', error: 'Not saved' };

export interface ToolbarProps {
  name: string;
  saving: SaveState;
  editable: boolean;
  onEditable: (on: boolean) => void;
  canAdd: boolean;
  onAdd: () => void;
  onMore: () => void;
  settings: DiagramSettings;
  onLayout: (layout: DiagramSettings['layout']) => void;
  onDirection: (direction: DiagramSettings['direction']) => void;
  view: ViewState;
  /** Whether anything can be opened or closed: groups of its own, or grouping by layer. */
  foldable: boolean;
  onByLayer: (on: boolean) => void;
  onOpenAll: (open: boolean) => void;
  layers: Array<{ layer: string; count: number }>;
  onToggleLayer: (layer: string) => void;
  hiddenCount: number;
  /** Some open groups are arranged on their own, with the arrows leaving them summed at their border. */
  packed: boolean;
  busy: boolean;
}

/** Two or more buttons acting as one choice. */
function Choice<T extends string>({ label, value, options, onChange, disabled }: {
  label: string;
  value: T;
  options: Array<{ value: T; text: string; title: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title} disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

export function Toolbar(p: ToolbarProps) {
  const manual = p.settings.layout === 'manual';
  return (
    <div className="diagram-bar">
      <div className="diagram-row">
        <strong className="grow ellipsis">{p.name}</strong>
        <span className="tiny muted" role="status">
          {SAVE_LABEL[p.saving]}
        </span>
        <label className="row nowrap small" style={{ gap: 6 }}>
          <input type="checkbox" checked={p.editable} onChange={(e) => p.onEditable(e.target.checked)} /> Edit
        </label>
        {p.editable && (
          <button type="button" className="btn btn-sm btn-primary" onClick={p.onAdd} disabled={!p.canAdd}>
            + Box
          </button>
        )}
        <button type="button" className="btn btn-sm btn-icon" onClick={p.onMore} aria-label="More diagram actions" title="More">
          ⋯
        </button>
      </div>
      <div className="diagram-row">
        <Choice label="Layout" value={p.settings.layout} disabled={p.busy} onChange={p.onLayout} options={[
          { value: 'auto', text: 'Auto', title: 'Arrange the boxes automatically' },
          { value: 'manual', text: 'Manual', title: 'Place and size the boxes yourself' },
        ]} />
        {!manual && (
          <Choice label="Direction" value={p.settings.direction} disabled={p.busy} onChange={p.onDirection} options={[
            { value: 'DOWN', text: '↓', title: 'Arrows point down' },
            { value: 'RIGHT', text: '→', title: 'Arrows point right' },
          ]} />
        )}
        {!manual && (
          <button type="button" className={cx('toggle-chip', 'small-chip', p.view.byLayer && 'on')} aria-pressed={p.view.byLayer}
            onClick={() => p.onByLayer(!p.view.byLayer)} title="Put the top-level boxes into one group per layer">
            Group by layer
          </button>
        )}
        {p.foldable && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => p.onOpenAll(true)}>
              Open all
            </button>
            <button type="button" className="btn btn-sm" onClick={() => p.onOpenAll(false)}>
              Close all
            </button>
          </>
        )}
      </div>
      {p.layers.length > 0 && (
        <div className="diagram-row diagram-legend" role="group" aria-label="Layers: show or hide">
          {p.layers.map(({ layer, count }) => {
            const hidden = p.view.hiddenLayers.includes(layer);
            return (
              <button key={layer} type="button" className={cx('layer-chip', hidden && 'off')} aria-pressed={!hidden}
                title={hidden ? `Show ${layer}` : `Hide ${layer}`} onClick={() => p.onToggleLayer(layer)}>
                <span className="dot" style={{ background: layerColor(layer) }} />
                {layer} <span className="muted">{count}</span>
              </button>
            );
          })}
          {p.hiddenCount > 0 && <span className="muted">{plural(p.hiddenCount, 'box', 'boxes')} hidden</span>}
          {p.packed && <span className="muted">Arrows leaving a crowded group are added up at its edge · select a box to see its own</span>}
          {p.editable && <span className="muted hide-mobile">Drag from a dot on a box to connect it · double-click a box to edit it</span>}
        </div>
      )}
    </div>
  );
}

export function MoreSheet(p: {
  editable: boolean;
  manual: boolean;
  onRename: () => void;
  onExport: () => void;
  onImport: (mode: 'merge' | 'replace') => void;
  onArrange: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  // Close first: the action may open a dialog or the file picker of its own.
  const run = (action: () => void) => () => {
    p.onClose();
    action();
  };
  return (
    <Sheet title="Diagram" onClose={p.onClose} variant="center">
      <div className="stack">
        <button type="button" className="btn" onClick={run(p.onExport)}>
          Export as JSON
        </button>
        {p.editable && (
          <>
            <button type="button" className="btn" onClick={run(() => p.onImport('merge'))}>
              Import JSON: add and update boxes…
            </button>
            <button type="button" className="btn" onClick={run(() => p.onImport('replace'))}>
              Import JSON: replace the whole diagram…
            </button>
            {p.manual && (
              <button type="button" className="btn" onClick={run(p.onArrange)}>
                Auto-arrange the boxes…
              </button>
            )}
            <button type="button" className="btn" onClick={run(p.onRename)}>
              Rename…
            </button>
            <button type="button" className="btn btn-danger" onClick={run(p.onDelete)}>
              Delete diagram…
            </button>
          </>
        )}
        {!p.editable && <p className="small muted" style={{ margin: 0 }}>Turn on Edit for more: import, rename, delete.</p>}
      </div>
    </Sheet>
  );
}

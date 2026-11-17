import type { ReactNode } from 'react';
import { usePanel } from './context';

/** A dock panel's header (close, minimize, back, title, the panel's own buttons) above its scrolling body. */
export function PanelFrame({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const panel = usePanel();
  return (
    <>
      <div className="sheet-head dock-head">
        <button className="btn btn-ghost btn-icon" onClick={panel.close} aria-label="Close" title="Close">
          ✕
        </button>
        <button className="btn btn-ghost btn-icon" onClick={panel.minimize} aria-label="Minimize" title="Minimize to the bar at the bottom">
          <span className="minimize-icon" aria-hidden="true" />
        </button>
        {panel.canGoBack && (
          <button className="btn btn-ghost btn-icon" onClick={panel.back} aria-label="Back" title="Back">
            ←
          </button>
        )}
        <div id={panel.titleId} className="grow ellipsis dock-title">
          {title}
        </div>
        {actions}
      </div>
      <div className="sheet-body">{children}</div>
    </>
  );
}

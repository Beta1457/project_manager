import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FilePanel } from '../components/FilePanel';
import { TaskPanel } from '../components/TaskPanel';
import { lockBodyScroll, openLayer } from '../components/Sheet';
import { readWidth, storeWidth, useResizeHandle } from '../resize';
import { cx } from '../util';
import { PanelContext, useDock, useDockState, useWideScreen, type PanelInfo } from './context';
import { slotOf, type DockItem } from './model';
import { Tray } from './Tray';

/** One panel alone keeps the width the side sheets had (and shares the setting with them). */
const SINGLE = { min: 420, max: 1200, initial: 640 };
const SINGLE_KEY = 'pm.sheet.width';
/** Two side by side: their width together, and the left one's share of it (in thousandths). */
const PAIR = { min: 760, max: 2400, initial: 1240 };
const PAIR_KEY = 'pm.dock.pair';
const SPLIT = { min: 200, max: 800, initial: 500 };
const SPLIT_KEY = 'pm.dock.split';
/** Neither of two panels gets narrower than this (styles.css says the same). */
const MIN_PANEL = 360;
/** Page left showing beside the panels, to see where you are and to click to close them. */
const PAGE_ROOM = 80;

export const titleIdOf = (key: string) => `dock-title-${key.replace(/[^A-Za-z0-9-]/g, '-')}`;

/** Fields that save when they lose focus (a task's title, an estimate) save before their panel goes. */
function blurInside(root: HTMLElement | null) {
  const el = document.activeElement;
  if (el instanceof HTMLElement && root?.contains(el)) el.blur();
}

/**
 * The dock on screen: the open panels on the right (modal, over a dimmed page, as the task sheet was) and the
 * tray of minimized tabs along the bottom. Every open item has a panel here; minimized ones stay mounted but
 * hidden, so what was typed in them is still there when they come back.
 */
export function DockLayer() {
  const dock = useDock();
  const state = useDockState();
  const wide = useWideScreen();
  const rootRef = useRef<HTMLDivElement>(null);
  const count = state.slots.length;
  const open = count > 0;
  const hasTray = state.items.some((i) => i.kept);

  // ---- Focus: into a panel when it opens, back to what opened the dock when the last panel goes. ----
  const opener = useRef<HTMLElement | null>(null);
  const prev = useRef<{ active: string | null; count: number }>({ active: null, count: 0 });
  /** Focus wanted on a tab after the next change (the item just minimized, the neighbour of a closed tab). */
  const tabFocus = useRef<string | null>(null);
  /** The panel worked in changed because it was clicked or tabbed into: the focus is where it should be. */
  const fromInside = useRef(false);
  const focusTab = useCallback((key: string) => {
    tabFocus.current = key;
  }, []);
  const activate = useCallback(
    (key: string) => {
      if (dock.get().active === key) return;
      fromInside.current = true;
      dock.focus(key);
    },
    [dock],
  );

  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = { active: state.active, count };
    const root = rootRef.current;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (was.count === 0 && count > 0) opener.current = focused && !root?.contains(focused) ? focused : null;
    const tab = tabFocus.current;
    tabFocus.current = null;
    const inside = fromInside.current;
    fromInside.current = false;
    if (tab !== null) {
      root?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(tab)}"] .tray-tab-main`)?.focus({ preventScroll: true });
    } else if (inside) {
      // Clicked or tabbed into: leave the focus alone.
    } else if (state.active !== null && state.active !== was.active) {
      const panel = root?.querySelector<HTMLElement>(`[data-panel="${CSS.escape(state.active)}"]`);
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    } else if (count === 0 && was.count > 0) {
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    }
  }, [state, count]);

  // ---- Modal while panels are open: Esc dismisses the one worked in, Tab stays in the dock, no page scroll. ----
  useEffect(() => {
    if (!open) return;
    const closeLayer = openLayer(
      () => rootRef.current,
      (e) => {
        if (e.defaultPrevented) return; // a menu, or a drag, dealt with it
        e.preventDefault();
        const active = dock.get().active;
        if (active === null) return;
        blurInside(rootRef.current);
        dock.dismiss(active);
      },
    );
    const unlock = lockBodyScroll();
    return () => {
      closeLayer();
      unlock();
    };
  }, [open, dock]);

  // ---- Widths (desktop): one panel, or two side by side and the split between them. ----
  const room = window.innerWidth - PAGE_ROOM;
  const [single, setSingle] = useState(() => readWidth(SINGLE_KEY, SINGLE.min, SINGLE.max) ?? SINGLE.initial);
  const [pair, setPair] = useState(() => readWidth(PAIR_KEY, PAIR.min, PAIR.max) ?? PAIR.initial);
  const [split, setSplit] = useState(() => readWidth(SPLIT_KEY, SPLIT.min, SPLIT.max) ?? SPLIT.initial);
  const singleHandle = useResizeHandle({
    ...SINGLE,
    width: single,
    max: Math.min(SINGLE.max, room),
    edge: -1,
    onChange: setSingle,
    onCommit: (px) => storeWidth(SINGLE_KEY, px === SINGLE.initial ? undefined : px),
  });
  const pairHandle = useResizeHandle({
    ...PAIR,
    width: pair,
    max: Math.min(PAIR.max, room),
    edge: -1,
    onChange: setPair,
    onCommit: (px) => storeWidth(PAIR_KEY, px === PAIR.initial ? undefined : px),
  });
  // The divider works in pixels of the width the pair has now; the setting is a share, so it suits any width.
  const pairPx = Math.max(PAIR.min, Math.min(pair, room));
  const toShare = (px: number) => Math.min(SPLIT.max, Math.max(SPLIT.min, Math.round((px / pairPx) * 1000)));
  const dividerHandle = useResizeHandle({
    width: Math.round((split / 1000) * pairPx),
    min: MIN_PANEL,
    max: pairPx - MIN_PANEL,
    initial: Math.round(pairPx / 2),
    edge: 1,
    onChange: (px) => setSplit(toShare(px)),
    onCommit: (px) => storeWidth(SPLIT_KEY, toShare(px) === SPLIT.initial ? undefined : toShare(px)),
  });

  const style = { '--sheet-w': `${single}px`, '--pair-w': `${pair}px`, '--split': String(split / 1000) } as CSSProperties;
  const activeTitle = state.active !== null ? titleIdOf(state.active) : undefined;

  return (
    <div ref={rootRef} className={cx('dock', open && 'open', hasTray && 'with-tray')}>
      {open && (
        <div
          className="dock-backdrop"
          onMouseDown={() => {
            blurInside(rootRef.current);
            dock.dismissAll();
          }}
        />
      )}
      <Tray onFocusTab={focusTab} />
      <div
        className={cx('dock-panels', open && 'open', count === 2 && 'pair')}
        style={style}
        {...(open && { role: 'dialog', 'aria-modal': true, 'aria-labelledby': activeTitle })}
      >
        {open && wide && (count === 2 ? (
          <div className="sheet-resizer" aria-label="Resize the two panels" {...pairHandle} />
        ) : (
          <div className="sheet-resizer" aria-label="Resize the panel" {...singleHandle} />
        ))}
        {state.items.map((item) => {
          const slot = slotOf(state, item.key);
          return (
            <PanelHost
              key={item.key}
              item={item}
              slot={slot}
              active={state.active === item.key}
              canGoBack={slot !== -1 && state.slots[slot].back.length > 0}
              onActivate={activate}
              onMinimize={focusTab}
            />
          );
        })}
        {count === 2 && wide && <div className="sheet-resizer dock-divider" aria-label="Move the line between the panels" {...dividerHandle} />}
      </div>
    </div>
  );
}

const PanelHost = memo(function PanelHost({ item, slot, active, canGoBack, onActivate, onMinimize }: {
  item: DockItem;
  /** 0 = left (or alone), 1 = right, -1 = minimized. */
  slot: number;
  active: boolean;
  canGoBack: boolean;
  onActivate: (key: string) => void;
  onMinimize: (key: string) => void;
}) {
  const dock = useDock();
  const ref = useRef<HTMLElement>(null);
  const shown = slot !== -1;
  const { key } = item;
  const info = useMemo<PanelInfo>(
    () => ({
      key,
      item,
      shown,
      active,
      canGoBack,
      titleId: titleIdOf(key),
      close: () => {
        blurInside(ref.current);
        dock.close(key);
      },
      minimize: () => {
        blurInside(ref.current);
        onMinimize(key);
        dock.minimize(key);
      },
      back: () => {
        blurInside(ref.current);
        dock.back(key);
      },
    }),
    [dock, key, item, shown, active, canGoBack, onMinimize],
  );
  return (
    <PanelContext.Provider value={info}>
      <section
        ref={ref}
        className={cx('dock-panel', slot === 1 && 'right', active && 'active')}
        hidden={!shown}
        style={{ order: slot === 1 ? 2 : 0 }}
        data-panel={key}
        role="region"
        aria-labelledby={info.titleId}
        tabIndex={-1}
        onPointerDownCapture={() => onActivate(key)}
        onFocus={() => onActivate(key)}
      >
        {item.kind === 'task' ? <TaskPanel /> : <FilePanel />}
      </section>
    </PanelContext.Provider>
  );
});

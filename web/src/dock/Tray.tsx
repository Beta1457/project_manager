import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ActionSheet, ContextMenu, type MenuNode, type MenuPosition } from '../components/ContextMenu';
import { folderParts } from '../components/Filters';
import { useFolders } from '../hooks';
import { cx } from '../util';
import { useDock, useDockState, useWideScreen } from './context';
import { isShown, tabHints, trayItems, type DockItem } from './model';

type TabAction = 'show' | 'show-left' | 'show-right' | 'minimize' | 'move-left' | 'move-right' | 'close' | 'close-others' | 'close-all';

/** Where a dragged tab would go: another place in the tray, or a side of the screen (dragged up off the tray). */
type Drop = { index: number } | { side: 'left' | 'right' | null };

interface Drag {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Moved far enough to be a drag rather than a click. */
  moving: boolean;
  x: number;
  y: number;
  drop: Drop | null;
}

/** The sidebar's width (styles.css): the tray, and the area tabs are dropped on, start right of it. */
const SIDEBAR_W = 220;
const DRAG_START = 5;
const LONG_PRESS_MS = 500;

/** A tab's words: a task's key and title, a file's name (until its panel has loaded: what was opened). */
export function tabText(item: DockItem): { code?: string; title: string } {
  if (item.kind === 'file') return { title: item.label?.title ?? `File ${item.ref}` };
  const code = item.label?.code ?? (typeof item.ref === 'string' ? item.ref : undefined);
  return { code, title: item.label?.title ?? (code ? '' : `Task ${item.ref}`) };
}

function fileIcon(name: string): string {
  if (/\.(md|markdown|txt)$/i.test(name)) return '📝';
  if (/\.html?$/i.test(name)) return '🌐';
  if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name)) return '🖼';
  return '📄';
}

/**
 * Minimized tasks and documents, along the bottom of the window. Click a tab to show it (beside the panel that
 * is open, if there is one), click the one shown to minimize it again, ✕ (or a middle click) to close it.
 * With a mouse or pen, drag tabs to reorder them, or up onto the left or right of the screen; right-click
 * (Shift+F10, a long press on a touch screen) for the same choices in a menu.
 */
export function Tray({ onFocusTab }: { onFocusTab: (key: string) => void }) {
  const dock = useDock();
  const state = useDockState();
  const wide = useWideScreen();
  const tabs = trayItems(state);
  // Where files are in the project. Tabs of files with the same name show enough of it to tell them apart.
  const { data: folders } = useFolders();
  const dirsOf = (item: DockItem) => (item.kind === 'file' && item.label?.folder && folders ? folderParts(folders, item.label.folder) : []);
  const hints = tabHints(tabs, dirsOf);
  /** A task's key and title; a file's path in the project. */
  const fullName = (item: DockItem) => {
    const { code, title } = tabText(item);
    return item.kind === 'file' ? [...dirsOf(item), title].join(' / ') : [code, title].filter(Boolean).join(' ');
  };
  const barRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [menu, setMenu] = useState<{ key: string; at: MenuPosition; returnFocus: HTMLElement | null; focusFirst: boolean } | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  /** A drag or a long press just ended on a tab: the click that follows it is not a click. */
  const swallowClick = useRef(false);
  const lastPointer = useRef('mouse');
  const menuKeyAt = useRef(0);
  const longPress = useRef<number | undefined>(undefined);
  const latest = useRef({ tabs, wide, shownCount: state.slots.length });
  latest.current = { tabs, wide, shownCount: state.slots.length };

  /** Removes the listeners of the drag (or long press) under way. */
  const stopGesture = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      window.clearTimeout(longPress.current);
      stopGesture.current?.();
      document.documentElement.classList.remove('dock-dragging');
    },
    [],
  );

  /** Off the tray: a side of the screen. On it: the place among the tabs the pointer is at. */
  function dropAt(key: string, x: number, y: number): Drop | null {
    const bar = barRef.current;
    if (!bar) return null;
    const { tabs, wide, shownCount } = latest.current;
    if (y < bar.getBoundingClientRect().top - 12) {
      if (!wide || shownCount === 0) return { side: null };
      const left = SIDEBAR_W;
      return { side: x < (left + window.innerWidth) / 2 ? 'left' : 'right' };
    }
    const els = [...bar.querySelectorAll<HTMLElement>('[data-tab]')];
    let at = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    if (at === -1) at = els.length;
    const from = tabs.findIndex((t) => t.key === key);
    return { index: at > from ? at - 1 : at };
  }

  /**
   * The click that ends a drag or a long press, if the browser sends one, is not a click on the tab. It comes
   * right after the pointer is released: only that one is ignored, not a later Enter on a tab.
   */
  const swallowNextClick = (released: boolean) => {
    swallowClick.current = true;
    const clear = () => {
      window.removeEventListener('pointerup', clear, true);
      window.removeEventListener('pointercancel', clear, true);
      window.setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    };
    if (released) clear();
    else {
      window.addEventListener('pointerup', clear, true);
      window.addEventListener('pointercancel', clear, true);
    }
  };

  /** Pointer down on a tab: with a mouse or pen, maybe the start of a drag; with a finger, maybe a long press. */
  const startDrag = (e: ReactPointerEvent<HTMLElement>, key: string) => {
    lastPointer.current = e.pointerType;
    swallowClick.current = false;
    window.clearTimeout(longPress.current);
    stopGesture.current?.();
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tray-tab-close')) return;
    const { pointerId, clientX, clientY } = e;
    if (e.pointerType === 'touch') {
      // No dragging with a finger (the tray scrolls sideways instead); a long press opens the menu.
      const target = e.currentTarget;
      const cancel = (ev: PointerEvent) => {
        if (ev.type === 'pointermove' && Math.hypot(ev.clientX - clientX, ev.clientY - clientY) < 10) return;
        stop();
      };
      const stop = () => {
        window.clearTimeout(longPress.current);
        window.removeEventListener('pointermove', cancel);
        window.removeEventListener('pointerup', cancel);
        window.removeEventListener('pointercancel', cancel);
        stopGesture.current = null;
      };
      window.addEventListener('pointermove', cancel);
      window.addEventListener('pointerup', cancel);
      window.addEventListener('pointercancel', cancel);
      stopGesture.current = stop;
      longPress.current = window.setTimeout(() => {
        stop();
        if (!target.isConnected) return;
        swallowNextClick(false); // the finger is still down
        setSheetFor(key);
      }, LONG_PRESS_MS);
      return;
    }
    // Listening on the window from the first moment: the pointer soon leaves a tab this small.
    dragRef.current = { key, pointerId, startX: clientX, startY: clientY, moving: false, x: clientX, y: clientY, drop: null };
    const finish = (commit: boolean, released: boolean) => {
      const d = dragRef.current;
      stop();
      if (!d?.moving) return;
      swallowNextClick(released);
      if (!commit || !d.drop) return;
      if ('index' in d.drop) dock.moveTab(d.key, d.drop.index);
      else dock.restore(d.key, d.drop.side ?? undefined);
    };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== pointerId) return;
      const moving = d.moving || Math.hypot(ev.clientX - clientX, ev.clientY - clientY) > DRAG_START;
      if (!moving) return;
      if (!d.moving) document.documentElement.classList.add('dock-dragging');
      const next = { ...d, moving, x: ev.clientX, y: ev.clientY, drop: dropAt(d.key, ev.clientX, ev.clientY) };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true, true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(false, true);
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragRef.current?.moving) return;
      ev.preventDefault(); // this Esc only calls off the drag: the panels leave it alone
      ev.stopPropagation();
      finish(false, false); // the button is still held
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      document.documentElement.classList.remove('dock-dragging');
      dragRef.current = null;
      stopGesture.current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    stopGesture.current = stop;
  };

  const openMenu = (key: string, at: MenuPosition, returnFocus: HTMLElement | null, fromKeyboard: boolean) => {
    if (!fromKeyboard && lastPointer.current === 'touch') return setSheetFor(key);
    setMenu({ key, at, returnFocus, focusFirst: fromKeyboard });
  };

  const menuNodes = (key: string): Array<MenuNode<TabAction>> => {
    const index = tabs.findIndex((t) => t.key === key);
    const shown = isShown(state, key);
    const nodes: Array<MenuNode<TabAction>> = wide
      ? [
          { type: 'action', id: 'show-left', label: 'Show on the left', icon: '◧' },
          { type: 'action', id: 'show-right', label: 'Show on the right', icon: '◨' },
        ]
      : shown
        ? []
        : [{ type: 'action', id: 'show', label: 'Show', icon: '▣' }];
    if (shown) nodes.push({ type: 'action', id: 'minimize', label: 'Minimize', icon: '▁' });
    nodes.push(
      { type: 'separator' },
      { type: 'action', id: 'move-left', label: 'Move tab left', icon: '←', disabled: index <= 0 },
      { type: 'action', id: 'move-right', label: 'Move tab right', icon: '→', disabled: index >= tabs.length - 1 },
      { type: 'separator' },
      { type: 'action', id: 'close', label: 'Close', icon: '✕', shortcut: 'Del' },
      { type: 'action', id: 'close-others', label: 'Close other tabs', disabled: tabs.length < 2 },
      { type: 'action', id: 'close-all', label: 'Close all tabs' },
    );
    return nodes;
  };

  /** Closes a tab; if the focus was on it, the next tab (or the one before) gets it. */
  const closeTab = (key: string) => {
    const index = tabs.findIndex((t) => t.key === key);
    const near = tabs[index + 1] ?? tabs[index - 1];
    if (near && barRef.current?.contains(document.activeElement)) onFocusTab(near.key);
    dock.close(key);
  };

  const minimizeTab = (key: string) => {
    onFocusTab(key);
    dock.minimize(key);
  };

  const pick = (key: string, id: TabAction) => {
    const index = tabs.findIndex((t) => t.key === key);
    if (id === 'show') dock.restore(key);
    else if (id === 'show-left') dock.restore(key, 'left');
    else if (id === 'show-right') dock.restore(key, 'right');
    else if (id === 'minimize') minimizeTab(key);
    else if (id === 'move-left') dock.moveTab(key, index - 1);
    else if (id === 'move-right') dock.moveTab(key, index + 1);
    else if (id === 'close') closeTab(key);
    else if (id === 'close-others') dock.closeTabs(key);
    else if (id === 'close-all') dock.closeTabs();
  };

  const onTabClick = (key: string) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (state.active === key) minimizeTab(key);
    else if (isShown(state, key)) dock.focus(key);
    else dock.restore(key);
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault();
      menuKeyAt.current = Date.now();
      openMenu(key, { anchor: e.currentTarget, align: 'start' }, e.currentTarget, true);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      closeTab(key);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const els = [...(barRef.current?.querySelectorAll<HTMLElement>('.tray-tab-main') ?? [])];
      const next = els[els.indexOf(e.currentTarget) + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  const onTabContextMenu = (e: MouseEvent<HTMLElement>, key: string) => {
    if (e.shiftKey && lastPointer.current !== 'touch') return; // Shift+right-click: the browser's own menu
    e.preventDefault();
    if (Date.now() - menuKeyAt.current < 500 || sheetFor !== null) return; // opened already (key, long press)
    const main = e.currentTarget.querySelector<HTMLElement>('.tray-tab-main');
    openMenu(key, { x: e.clientX, y: e.clientY }, main, false);
  };

  if (!tabs.length) return null;

  const dragging = drag?.moving ? drag : null;
  const dropIndex = dragging?.drop && 'index' in dragging.drop ? dragging.drop.index : null;
  const fromIndex = dragging ? tabs.findIndex((t) => t.key === dragging.key) : -1;
  // Where the insertion line shows: before the tab now at that place (or after the last one).
  const lineBefore = dropIndex === null || dropIndex === fromIndex ? -1 : dropIndex > fromIndex ? dropIndex + 1 : dropIndex;
  const side = dragging?.drop && 'side' in dragging.drop ? dragging.drop : null;
  const draggedText = dragging ? tabText(tabs[fromIndex] ?? tabs[0]) : null;

  return (
    <>
      <div className="tray" ref={barRef} role="group" aria-label="Minimized tasks and documents">
        {tabs.map((item, i) => {
          const shown = isShown(state, item.key);
          const active = state.active === item.key;
          const { code, title } = tabText(item);
          const name = [code, title].filter(Boolean).join(' ');
          const dirs = dirsOf(item);
          const hint = hints.get(item.key);
          // Before the name ("World 1 / Level 1.md"), so it stays when a narrow tab cuts the end off.
          const where = hint ? `${hint.join(' / ')} / ` : '';
          const label = dirs.length > 0 ? `${name}, in ${dirs.join(' / ')}` : name;
          return (
            <div
              key={item.key}
              data-tab={item.key}
              className={cx(
                'tray-tab',
                shown && 'shown',
                active && 'active',
                dragging?.key === item.key && 'dragging',
                lineBefore === i && 'drop-before',
                lineBefore === tabs.length && i === tabs.length - 1 && 'drop-after',
              )}
              onPointerDown={(e) => startDrag(e, item.key)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault() /* no autoscroll: a middle click closes the tab */}
              onContextMenu={(e) => onTabContextMenu(e, item.key)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(item.key);
                }
              }}
            >
              <button
                type="button"
                className="tray-tab-main"
                aria-pressed={shown}
                aria-label={label}
                title={`${fullName(item)}\n${active ? 'Click to minimize' : 'Click to show'} · drag to move · right-click for more`}
                onClick={() => onTabClick(item.key)}
                onKeyDown={(e) => onTabKey(e, item.key)}
              >
                {item.kind === 'task' ? (
                  <span className="tray-dot" style={item.label?.color ? { background: item.label.color } : undefined} aria-hidden="true" />
                ) : (
                  <span className="tray-ico" aria-hidden="true">{fileIcon(title)}</span>
                )}
                <span className="tray-tab-text">
                  {where && <span className="tray-tab-dirs">{where}</span>}
                  {code && <span className="key">{code}</span>} {title}
                </span>
              </button>
              <button type="button" className="tray-tab-close" aria-label={`Close ${label}`} title="Close" onClick={() => closeTab(item.key)}>
                ✕
              </button>
            </div>
          );
        })}
      </div>
      {side && (
        <div className={cx('dock-drop', side.side === null && 'single')} aria-hidden="true">
          {side.side === null ? (
            <div className="dock-drop-zone over">Show here</div>
          ) : (
            <>
              <div className={cx('dock-drop-zone', side.side === 'left' && 'over')}>Show on the left</div>
              <div className={cx('dock-drop-zone', side.side === 'right' && 'over')}>Show on the right</div>
            </>
          )}
        </div>
      )}
      {dragging && draggedText && (
        <div className="tray-ghost" style={{ left: dragging.x + 14, top: dragging.y - 40 }} aria-hidden="true">
          {draggedText.code && <span className="key">{draggedText.code}</span>} {draggedText.title}
        </div>
      )}
      {menu && (
        <ContextMenu
          key={`${menu.key}-${menu.focusFirst}`}
          label={`Tab ${fullName(tabs.find((t) => t.key === menu.key) ?? tabs[0])}`}
          nodes={menuNodes(menu.key)}
          at={menu.at}
          returnFocus={menu.returnFocus}
          focusFirst={menu.focusFirst}
          onPick={(id) => pick(menu.key, id)}
          onClose={() => setMenu(null)}
        />
      )}
      {sheetFor !== null &&
        tabs.some((t) => t.key === sheetFor) &&
        // In the body, after the panels: the sheet has to cover them too.
        createPortal(
          <ActionSheet
            // A file's whole path: on a phone the tabs have no room for it, and nothing to hover.
            title={fullName(tabs.find((t) => t.key === sheetFor)!)}
            nodes={menuNodes(sheetFor)}
            onPick={(id) => pick(sheetFor, id)}
            onClose={() => setSheetFor(null)}
          />,
          document.body,
        )}
    </>
  );
}

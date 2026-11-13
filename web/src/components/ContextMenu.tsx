import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { cx } from '../util';
import { Sheet } from './Sheet';

/**
 * A floating menu, the app's own right-click menu: at the pointer, or under a button. Keyboard: arrows,
 * Home/End, the first letter of an entry, → / ← for a submenu, Enter, Esc; Tab closes it. It closes when
 * you click elsewhere, scroll, resize or leave the window, or the page changes. Touch screens get the same
 * entries in a sheet instead (see ActionSheet), which is easier to hit with a finger.
 */

export type MenuNode<Id extends string = string> =
  | { type: 'action'; id: Id; label: string; icon?: string; shortcut?: string; danger?: boolean; disabled?: boolean }
  | { type: 'submenu'; label: string; icon?: string; items: Array<MenuNode<Id>> }
  | { type: 'separator' };

/** At the pointer, or next to an element: below its end (a ⋯ button) or its start (a row's name). */
export type MenuPosition = { x: number; y: number } | { anchor: HTMLElement; align: 'start' | 'end' };

interface Props<Id extends string> {
  /** Says what the menu is for, to screen readers ("Actions for Design"). */
  label: string;
  nodes: Array<MenuNode<Id>>;
  at: MenuPosition;
  onPick: (id: Id) => void;
  onClose: () => void;
  /** Gets the focus back when the menu closes from the keyboard or with a pick (usually the row it is for). */
  returnFocus?: HTMLElement | null;
  /** The button that opened it: pressing it again is left to that button (which closes the menu). */
  toggleFrom?: HTMLElement | null;
  /** Opened from the keyboard: the first entry gets the focus. Otherwise ↓ goes to it, as in other apps. */
  focusFirst?: boolean;
}

const MARGIN = 8;
const ITEMS = ':scope > [role="menuitem"]:not(:disabled), :scope > .ctx-sub > [role="menuitem"]';

function items(menu: HTMLElement | null): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>(ITEMS)] : [];
}

/** Keeps a box of `size` inside the window, starting from `start`, flipping to `flip` if it doesn't fit. */
function fit(start: number, flip: number, size: number, room: number): number {
  const pos = start + size > room - MARGIN ? flip : start;
  return Math.max(MARGIN, Math.min(pos, room - size - MARGIN));
}

export function ContextMenu<Id extends string>({ label, nodes, at, onPick, onClose, returnFocus, toggleFrom, focusFirst = false }: Props<Id>) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const location = useLocation();
  const openedAt = useRef(location);
  const closed = useRef(false);
  const latest = useRef({ onClose, returnFocus, toggleFrom });
  latest.current = { onClose, returnFocus, toggleFrom };

  const close = (restoreFocus: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const target = latest.current.returnFocus;
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
    latest.current.onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Measure first (rendered hidden), then place it inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if ('anchor' in at) {
      const r = at.anchor.getBoundingClientRect();
      const left = at.align === 'end' ? Math.max(MARGIN, r.right - width) : r.left;
      setPos({ left: fit(left, r.right - width, width, vw), top: fit(r.bottom + 4, r.top - height - 4, height, vh) });
    } else {
      setPos({ left: fit(at.x, at.x - width, width, vw), top: fit(at.y, at.y - height, height, vh) });
    }
  }, [at]);

  useEffect(() => {
    if (pos) (focusFirst ? items(ref.current)[0] : ref.current)?.focus({ preventScroll: true });
    // Only once it has its place; later re-renders keep the focus where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos !== null]);

  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && !!ref.current?.contains(target);
    const onPointer = (e: PointerEvent) => {
      const toggle = latest.current.toggleFrom;
      if (!inside(e.target) && !(toggle && e.target instanceof Node && toggle.contains(e.target))) closeRef.current(false);
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) closeRef.current(false);
    };
    const onLeave = () => closeRef.current(false);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, []);

  useEffect(() => {
    if (location !== openedAt.current) closeRef.current(false);
  }, [location]);

  const pick = (id: Id) => {
    // Focus goes back to the row first, so a dialog the action opens returns it there when it closes.
    close(true);
    onPick(id);
  };

  return createPortal(
    <MenuList
      menuRef={ref}
      label={label}
      nodes={nodes}
      onPick={pick}
      onEscape={() => close(true)}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    />,
    document.body,
  );
}

interface ListProps<Id extends string> {
  menuRef?: RefObject<HTMLDivElement | null>;
  label: string;
  nodes: Array<MenuNode<Id>>;
  onPick: (id: Id) => void;
  /** Esc (and ← in a submenu): close this level. */
  onEscape: () => void;
  /** A submenu: ← closes it too. */
  isSub?: boolean;
  style: CSSProperties;
}

function MenuList<Id extends string>({ menuRef, label, nodes, onPick, onEscape, isSub, style }: ListProps<Id>) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = menuRef ?? ownRef;
  // The open submenu. `focus` counts requests from the keyboard to put the focus on its first entry (0: none).
  const [sub, setSub] = useState<{ index: number; focus: number } | null>(null);
  const focusRequests = useRef(0);
  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const openSub = (index: number) => setSub({ index, focus: ++focusRequests.current });

  const move = (e: KeyboardEvent, to: (list: HTMLElement[], at: number) => number) => {
    const list = items(ref.current);
    if (!list.length) return;
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLElement);
    list[(to(list, at) + list.length) % list.length]?.focus();
  };

  const closeSub = (refocus: boolean) => {
    if (!sub) return;
    if (refocus) triggers.current.get(sub.index)?.focus();
    setSub(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The innermost menu handles a key; its parents don't see it.
    e.stopPropagation();
    const active = document.activeElement as HTMLElement | null;
    switch (e.key) {
      case 'ArrowDown':
        return move(e, (_, at) => at + 1);
      case 'ArrowUp':
        return move(e, (list, at) => (at < 0 ? list.length - 1 : at - 1));
      case 'Home':
        return move(e, () => 0);
      case 'End':
        return move(e, (list) => list.length - 1);
      case 'ArrowRight': {
        const index = Number(active?.dataset.sub ?? NaN);
        if (!Number.isNaN(index)) {
          e.preventDefault();
          openSub(index);
        }
        return;
      }
      case 'ArrowLeft':
        if (isSub) {
          e.preventDefault();
          onEscape();
        }
        return;
      case 'Escape':
        e.preventDefault();
        return onEscape();
      case 'Tab':
        e.preventDefault();
        return onEscape();
      default:
        // Type a letter to jump to the next entry starting with it.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
          const list = items(ref.current);
          const at = list.indexOf(active as HTMLElement);
          const key = e.key.toLowerCase();
          const next = [...list.slice(at + 1), ...list.slice(0, at + 1)].find((el) => el.dataset.label?.toLowerCase().startsWith(key));
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }
    }
  };

  // Focus follows the pointer, so the keyboard carries on from where the mouse is.
  const hover = (el: HTMLElement) => {
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      className={cx('ctx-menu', isSub && 'ctx-submenu')}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {nodes.map((n, i) => {
        if (n.type === 'separator') return <div key={i} role="separator" className="ctx-sep" />;
        if (n.type === 'submenu') {
          const open = sub?.index === i;
          return (
            <div
              key={i}
              className="ctx-sub"
              onMouseEnter={() => setSub((s) => (s?.index === i ? s : { index: i, focus: 0 }))}
              onMouseLeave={(e) => {
                // Leaving with the focus inside: give it to the entry, or the keyboard would lose its place.
                closeSub(!!e.currentTarget.querySelector('.ctx-submenu')?.contains(document.activeElement));
              }}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) triggers.current.set(i, el);
                  else triggers.current.delete(i);
                }}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                className={cx('ctx-item', open && 'open')}
                tabIndex={-1}
                data-sub={i}
                data-label={n.label}
                onClick={() => (open ? setSub(null) : openSub(i))}
                onMouseMove={(e) => hover(e.currentTarget)}
              >
                <span className="ctx-ico" aria-hidden="true">{n.icon}</span>
                <span className="ctx-label">{n.label}</span>
                <span className="ctx-arrow" aria-hidden="true">▸</span>
              </button>
              {open && (
                <SubMenu
                  trigger={triggers.current.get(i) ?? null}
                  label={n.label}
                  nodes={n.items}
                  focusFirst={sub.focus}
                  onPick={onPick}
                  onBack={() => closeSub(true)}
                />
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={cx('ctx-item', n.danger && 'danger')}
            tabIndex={-1}
            disabled={n.disabled}
            data-label={n.label}
            onClick={() => onPick(n.id)}
            onMouseMove={(e) => hover(e.currentTarget)}
            onMouseEnter={() => closeSub(false)}
          >
            <span className="ctx-ico" aria-hidden="true">{n.icon}</span>
            <span className="ctx-label">{n.label}</span>
            {n.shortcut && <kbd className="ctx-key">{n.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** The same entries as a sheet of big buttons, for touch screens; a submenu becomes a titled group. */
export function ActionSheet<Id extends string>({ title, nodes, footer, onPick, onClose }: {
  title: string;
  nodes: Array<MenuNode<Id>>;
  footer?: ReactNode;
  onPick: (id: Id) => void;
  onClose: () => void;
}) {
  const button = (n: Extract<MenuNode<Id>, { type: 'action' }>) => (
    <button
      key={n.id}
      type="button"
      className={cx('btn action-btn', n.danger && 'btn-danger')}
      disabled={n.disabled}
      onClick={() => {
        onClose();
        onPick(n.id);
      }}
    >
      <span className="ctx-ico" aria-hidden="true">{n.icon}</span>
      {n.label}
    </button>
  );
  const list = (nodes: Array<MenuNode<Id>>): ReactNode[] =>
    nodes.map((n, i) =>
      n.type === 'separator' ? (
        <hr key={`sep-${i}`} className="action-sep" />
      ) : n.type === 'submenu' ? (
        <div key={`sub-${i}`} className="stack" style={{ gap: 6 }} role="group" aria-label={n.label}>
          <div className="section-title">{n.label}</div>
          {list(n.items)}
        </div>
      ) : (
        button(n)
      ),
    );
  return (
    <Sheet title={title} onClose={onClose} variant="center">
      <div className="stack" style={{ gap: 6 }}>
        {list(nodes)}
        {footer}
      </div>
    </Sheet>
  );
}

function SubMenu<Id extends string>({ trigger, label, nodes, focusFirst, onPick, onBack }: {
  trigger: HTMLElement | null;
  label: string;
  nodes: Array<MenuNode<Id>>;
  /** A new number: put the focus on the first entry (0: leave it). */
  focusFirst: number;
  onPick: (id: Id) => void;
  onBack: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Beside its entry, on the right, or on the left where the window ends. Fixed, so the main menu's
  // scrolling (on short windows) doesn't clip it.
  useLayoutEffect(() => {
    if (!trigger || !ref.current) return;
    const r = trigger.getBoundingClientRect();
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({ left: fit(r.right - 2, r.left - width + 2, width, window.innerWidth), top: fit(r.top - 5, r.bottom - height + 5, height, window.innerHeight) });
  }, [trigger]);

  useEffect(() => {
    if (pos && focusFirst) items(ref.current)[0]?.focus({ preventScroll: true });
  }, [pos, focusFirst]);

  return (
    <MenuList
      menuRef={ref}
      label={label}
      nodes={nodes}
      onPick={onPick}
      onEscape={onBack}
      isSub
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    />
  );
}

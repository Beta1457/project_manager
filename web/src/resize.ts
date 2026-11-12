import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

// Widths people drag (the task panel, board columns). They are a setting of this browser, like the
// phone board's column, so they live in localStorage and are not synced between devices.

export interface ResizeOptions {
  /** The width now, in px. */
  width: number;
  min: number;
  max: number;
  /** The width a double-click goes back to. */
  initial: number;
  /** 1 for a handle on the right edge (dragging right widens), -1 for one on the left edge. */
  edge: 1 | -1;
  /** While dragging: the width to show. */
  onChange: (px: number) => void;
  /** When a drag ends, a key is pressed or the width is reset: the width to keep (save it here). */
  onCommit: (px: number) => void;
}

const STEP = 16;
const BIG_STEP = 64;
/** On <html> while a drag is on: the resize cursor everywhere and no text selection (see styles.css). */
const DRAGGING_CLASS = 'resizing';

/**
 * A handle that changes a width: drag it, use ←/→ (Shift for bigger steps) and Home/End once it has focus,
 * or double-click it to go back to the initial width. Returns the props for the handle element, which acts
 * as a vertical splitter (role="separator"); give it an aria-label too.
 */
export function useResizeHandle({ width, min, max, initial, edge, onChange, onCommit }: ResizeOptions) {
  const drag = useRef<{ pointer: number; startX: number; startWidth: number; last: number; moved: boolean } | null>(null);
  // Unmounted mid-drag (the panel closed with Escape): the browser tells only the document, so tidy up here.
  useEffect(() => () => {
    if (drag.current) document.documentElement.classList.remove(DRAGGING_CLASS);
  }, []);
  const top = Math.max(min, max);
  const clamp = (px: number) => Math.round(Math.min(top, Math.max(min, px)));
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.classList.remove(DRAGGING_CLASS);
    // Even if it ended where it started: onChange was called, so the width shown has to be settled.
    if (d.moved) onCommit(d.last);
  };
  const set = (px: number) => {
    onChange(px);
    onCommit(px);
  };
  return {
    role: 'separator',
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': min,
    'aria-valuemax': top,
    'aria-valuenow': clamp(width),
    tabIndex: 0,
    title: 'Drag to resize · double-click to reset',
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      // No text selection, card drag or click on what is behind the handle.
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture(e.pointerId);
      document.documentElement.classList.add(DRAGGING_CLASS);
      drag.current = { pointer: e.pointerId, startX: e.clientX, startWidth: clamp(width), last: clamp(width), moved: false };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointer !== e.pointerId) return;
      const next = clamp(d.startWidth + edge * (e.clientX - d.startX));
      if (next !== d.last) {
        d.last = next;
        d.moved = true;
        onChange(next);
      }
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onDoubleClick: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault();
      e.stopPropagation();
      set(initial);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const step = e.shiftKey ? BIG_STEP : STEP;
      const next =
        e.key === 'ArrowRight' ? clamp(width) + edge * step
        : e.key === 'ArrowLeft' ? clamp(width) - edge * step
        : e.key === 'Home' ? min
        : e.key === 'End' ? top
        : null;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      set(clamp(next));
    },
  };
}

/** A width saved in this browser, or undefined if there is none (or it is not between min and max). */
export function readWidth(key: string, min: number, max: number): number | undefined {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return n >= min && n <= max ? n : undefined;
  } catch {
    return undefined; // storage unavailable (private browsing)
  }
}

/** Saves a width in this browser; `undefined` forgets it, so the default applies again. */
export function storeWidth(key: string, px: number | undefined) {
  try {
    if (px === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(px));
  } catch {
    /* storage unavailable: the width lasts until the page is closed */
  }
}

/** Several widths saved under one key ({name: px}, e.g. one per board column): those between min and max. */
export function readWidths(key: string, min: number, max: number): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] >= min && e[1] <= max),
    );
  } catch {
    return {}; // storage unavailable, or not JSON
  }
}

/** Saves several widths under one key; an empty map removes the key. */
export function storeWidths(key: string, widths: Record<string, number>) {
  try {
    if (Object.keys(widths).length) localStorage.setItem(key, JSON.stringify(widths));
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable: the widths last until the page is closed */
  }
}

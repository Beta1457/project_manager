import { useCallback, useEffect, useMemo, useState } from 'react';
import { isSheetOpen } from './components/Sheet';

/**
 * Selecting several tasks on the board or in the list, to change them all at once (components/BulkBar).
 *
 * - The checkbox on a card or row ticks it; Shift ticks every task between it and the last one ticked,
 *   in the order they are shown (board: column by column, top to bottom).
 * - Ctrl/Cmd+click on a card or row ticks it too, and Shift+click picks a range; a plain click still opens it.
 * - Esc clears the selection and Ctrl/Cmd+A selects every task shown, unless a field or a dialog has the keys.
 * - Phones have no hover or Ctrl: their Select button turns on a mode where a tap ticks instead of opening.
 */
export interface TaskSelection {
  /** Selected ids, in the order the tasks are shown. */
  ids: number[];
  has: (id: number) => boolean;
  /** Something is selected, or Select mode is on: checkboxes show and the bar is up. */
  active: boolean;
  /** Select mode (phones): a tap on a task ticks it instead of opening it. */
  mode: boolean;
  setMode: (on: boolean) => void;
  /** Ticks or unticks a task. `range`: also ticks every task between it and the last one ticked. */
  toggle: (id: number, range?: boolean) => void;
  selectAll: () => void;
  /** Unticks everything and leaves Select mode. */
  clear: () => void;
}

/** Keys pressed in a text field belong to the field. Checkboxes and buttons don't count. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type);
}

/** `ordered`: the ids of the tasks shown, in the order shown. Keep it memoised. */
export function useTaskSelection(ordered: number[]): TaskSelection {
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [mode, setMode] = useState(false);

  // Tasks no longer shown (deleted, moved out of an epoch's board, filtered out) leave the selection.
  useEffect(() => {
    const shown = new Set(ordered);
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => shown.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [ordered]);

  const ids = useMemo(() => ordered.filter((id) => picked.has(id)), [ordered, picked]);
  const active = picked.size > 0 || mode;

  const toggle = useCallback(
    (id: number, range = false) => {
      setPicked((prev) => {
        const next = new Set(prev);
        const from = range && anchor !== null ? ordered.indexOf(anchor) : -1;
        const to = ordered.indexOf(id);
        if (from !== -1 && to !== -1) {
          for (const x of ordered.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchor(id);
    },
    [anchor, ordered],
  );
  const selectAll = useCallback(() => setPicked(new Set(ordered)), [ordered]);
  const clear = useCallback(() => {
    setPicked(new Set());
    setAnchor(null);
    setMode(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isSheetOpen() || isTyping(e.target)) return;
      if (e.key === 'Escape' && active) {
        e.preventDefault();
        clear();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && ordered.length) {
        e.preventDefault();
        selectAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, ordered, clear, selectAll]);

  // The page's floating + button would sit on top of the bar on phones (styles.css hides it meanwhile).
  useEffect(() => {
    document.body.classList.toggle('selecting-tasks', active);
    return () => document.body.classList.remove('selecting-tasks');
  }, [active]);

  return useMemo(
    () => ({ ids, has: (id: number) => picked.has(id), active, mode, setMode, toggle, selectAll, clear }),
    [ids, picked, active, mode, toggle, selectAll, clear],
  );
}

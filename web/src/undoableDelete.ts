import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { invalidateKinds } from './hooks';
import { useToast } from './components/Toast';
import { errorMessage } from './util';

/**
 * Removals with Undo instead of a confirm dialog, for small things such as a checklist item or a link.
 * The item disappears at once, but the DELETE is only sent when the Undo window closes. Undo just
 * cancels it, so nothing has to be re-created and the item comes back exactly as it was. Pending
 * deletes are sent straight away if the page is closed or reloaded.
 */
export const UNDO_MS = 6000;

/**
 * Hidden items by DELETE url. `timer` is null once the DELETE is on its way (too late to undo).
 * `send` sends it now (with `keepalive` while the page is going away).
 */
const hidden = new Map<string, { timer: number | null; send: (keepalive: boolean) => Promise<void> }>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const getVersion = () => version;

function unhide(url: string) {
  if (hidden.delete(url)) notify();
}

if (typeof window !== 'undefined') {
  // The page may also just be paused (kept for the Back button), so this goes through the normal
  // path, which un-hides the item once the DELETE is done.
  window.addEventListener('pagehide', () => {
    for (const state of [...hidden.values()]) void state.send(true);
  });
}

export function useUndoableDelete() {
  const qc = useQueryClient();
  const toast = useToast();
  useSyncExternalStore(subscribe, getVersion); // re-render when an item hides or comes back

  /** Hides the item now and deletes it after the Undo window. `kinds` are the data kinds to refresh. */
  const remove = useCallback(
    (url: string, message: string, kinds: string[]) => {
      if (hidden.has(url)) return;
      const send = async (keepalive: boolean) => {
        const state = hidden.get(url);
        if (!state || state.timer === null) return; // undone, or already on its way
        window.clearTimeout(state.timer);
        state.timer = null;
        try {
          await (keepalive ? api.delOnUnload(url) : api.del(url));
          // Wait for the refetch, so the item is already gone from the data when it stops being hidden.
          await invalidateKinds(qc, kinds);
        } catch (err) {
          if (!keepalive) toast(errorMessage(err), 'error');
        } finally {
          unhide(url);
        }
      };
      hidden.set(url, { timer: window.setTimeout(() => void send(false), UNDO_MS), send });
      notify();
      toast(message, 'info', {
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            const state = hidden.get(url);
            if (!state || state.timer === null) return; // already sent
            window.clearTimeout(state.timer);
            unhide(url);
          },
        },
      });
    },
    [qc, toast],
  );

  return { remove, isHidden: (url: string) => hidden.has(url) };
}

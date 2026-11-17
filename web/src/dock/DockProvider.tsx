import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useProject } from '../projectContext';
import { DockContext, useWideScreen, type DockApi } from './context';
import { DockStore } from './store';
import * as dockModel from './model';
import { MAX_SLOTS, findItem, itemOf, type DockTarget } from './model';

/*
 * The address bar follows the dock: ?task=12 or ?file=5 names the panel worked in, so a reload or a copied link
 * opens it again. Panels being open is one history entry (state.dock) on top of the page's own, so the phone's
 * Back button steps back through links followed in a panel, then closes it, and never leaves the page.
 *
 * React Router applies address changes in transitions (a moment later); the dock reads the address and
 * history from the window instead, and handles Back from its own popstate listener, so neither waits on the other.
 */

type HistoryState = { usr?: Record<string, unknown> | null; idx?: number } | null;

const liveHistory = () => window.history.state as HistoryState;
const onDockEntry = () => liveHistory()?.usr?.dock === true;
const liveIdx = () => liveHistory()?.idx ?? null;

/** The item the address names: ?task=12, ?task=APP-12 or ?file=5 (a task wins if both are there). */
function readTarget(search: string): DockTarget | null {
  const params = new URLSearchParams(search);
  const task = params.get('task');
  if (task && /^\d+$/.test(task) && Number(task) > 0) return { kind: 'task', ref: Number(task) };
  if (task && /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/.test(task)) return { kind: 'task', ref: task.toUpperCase() };
  const file = params.get('file');
  if (file && /^\d+$/.test(file) && Number(file) > 0) return { kind: 'file', ref: Number(file) };
  return null;
}

/** The dock of the current project in this tab. ProjectProvider remounts it when the project changes. */
export function DockProvider({ children }: { children: ReactNode }) {
  const { project } = useProject();
  const [store] = useState(() => new DockStore(`pm.dock.${project.id}`));
  const wide = useWideScreen();
  const slots = useRef(MAX_SLOTS);
  slots.current = wide ? MAX_SLOTS : 1;

  const dock = useMemo<DockApi>(() => {
    const max = () => slots.current;
    return {
      get: store.get,
      subscribe: store.subscribe,
      open: (target, from) => store.apply((s) => dockModel.open(s, target, from, max())),
      restore: (key, side) => store.apply((s) => dockModel.restore(s, key, side, max())),
      minimize: (key) => store.apply((s) => dockModel.minimize(s, key)),
      close: (key) => store.apply((s) => dockModel.close(s, key)),
      dismiss: (key) => store.apply((s) => dockModel.dismiss(s, key)),
      dismissAll: () => store.apply(dockModel.dismissAll),
      back: (key) => store.apply((s) => dockModel.back(dockModel.focus(s, key))),
      focus: (key) => store.apply((s) => dockModel.focus(s, key)),
      moveTab: (key, to) => store.apply((s) => dockModel.moveTab(s, key, to)),
      closeTabs: (except) => store.apply((s) => dockModel.closeTabs(s, except)),
      setLabel: (key, label) => store.apply((s) => dockModel.setLabel(s, key, label)),
      forget: store.forget,
    };
  }, [store]);

  // A phone (or a window made narrow) has room for one panel: the other one goes to the tray.
  useEffect(() => {
    if (!wide) store.apply((s) => dockModel.fit(s, 1));
  }, [wide, store]);

  useAddressSync(store, slots);

  return <DockContext.Provider value={dock}>{children}</DockContext.Provider>;
}

function useAddressSync(store: DockStore, slots: { current: number }) {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const location = useLocation();
  const navigationType = useNavigationType();
  const started = useRef(false);
  /** We went back off our own entry (the last panel closed): that popstate is not the Back button. */
  const expectPop = useRef(false);
  const lastIdx = useRef<number | null>(null);

  // Shared by the effects below; every step reads the window, so running one twice does no harm.
  const steps = useMemo(() => {
    const openFromAddress = (target: DockTarget) => {
      const s = store.get();
      if (findItem(s, target)?.key === s.active && s.active !== null) return;
      store.apply((x) => dockModel.open(x, target, null, slots.current));
    };

    /** Makes the address and history match the dock. */
    const sync = () => {
      const s = store.get();
      const active = itemOf(s, s.active);
      const { pathname, search, hash } = window.location;
      const params = new URLSearchParams(search);
      const usr = liveHistory()?.usr ?? null;
      const onDock = usr?.dock === true;
      const task = params.get('task');
      const file = params.get('file');
      const go = navigateRef.current;
      if (active) {
        const want = String(active.ref);
        const matches = active.kind === 'task' ? task === want && file === null : file === want && task === null;
        if (onDock && matches) return;
        params.delete('task');
        params.delete('file');
        params.set(active.kind, want);
        const to = { pathname, search: `?${params}`, hash };
        // On our entry: just rename it. Otherwise panels have just opened: add our entry on top of the page's.
        if (onDock) go(to, { replace: true, state: usr });
        else go(to, { state: { dock: true } });
        lastIdx.current = liveIdx();
      } else if (onDock) {
        expectPop.current = true;
        go(-1);
      } else if (task !== null || file !== null) {
        // The page's own entry still names an item (a link opened it, or Back came here): tidy it.
        params.delete('task');
        params.delete('file');
        const rest = params.toString();
        go({ pathname, search: rest ? `?${rest}` : '', hash }, { replace: true, state: usr });
        lastIdx.current = liveIdx();
      }
    };

    /** Back or Forward. */
    const onPop = () => {
      const idx = liveIdx();
      const before = lastIdx.current;
      lastIdx.current = idx;
      if (expectPop.current) {
        expectPop.current = false;
      } else if (onDockEntry()) {
        // Back (or Forward) onto a page as it was with a panel open: open it again.
        const target = readTarget(window.location.search);
        if (target) openFromAddress(target);
      } else if (store.get().slots.length) {
        // Off our entry while panels are open. Back steps back in the panel worked in (or dismisses it);
        // Forward to a page leaves the panels for it.
        const forward = idx !== null && before !== null && idx > before;
        store.apply(forward ? dockModel.dismissAll : dockModel.back);
      }
      sync();
    };

    return { openFromAddress, sync, onPop };
  }, [store, slots]);

  // Start: panels saved for this tab show again only on our own entry (a reload); on a plain page entry
  // (another project, a link opened in this tab) they go back to the tray. Then whatever the address names.
  useEffect(() => {
    started.current = true;
    lastIdx.current = liveIdx();
    if (!onDockEntry()) store.apply(dockModel.dismissAll);
    const target = readTarget(window.location.search);
    if (target) steps.openFromAddress(target);
    steps.sync();
    const unsubscribe = store.subscribe(steps.sync);
    window.addEventListener('popstate', steps.onPop);
    return () => {
      unsubscribe();
      window.removeEventListener('popstate', steps.onPop);
    };
  }, [store, steps]);

  // Pages and links changing the address. Back/Forward are the popstate listener's.
  useEffect(() => {
    if (!started.current || navigationType === 'POP') return;
    lastIdx.current = liveIdx();
    const target = readTarget(window.location.search);
    if (target) steps.openFromAddress(target);
    // Our own entries always name an item: one that doesn't is another page, which the panels make way for.
    else if (navigationType === 'PUSH' && store.get().slots.length) store.apply(dockModel.dismissAll);
    steps.sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
}

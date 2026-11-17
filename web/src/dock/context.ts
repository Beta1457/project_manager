import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FileItem } from '../types';
import type { DockItem, DockLabel, DockState, DockTarget } from './model';

/** What the page and the panels can ask of the dock (see model.ts for the rules). Stable for the dock's life. */
export interface DockApi {
  get: () => DockState;
  subscribe: (listener: () => void) => () => void;
  /** From a panel (`from` = its item): opens in that panel. From the page: in the panel worked in last. */
  open: (target: DockTarget, from?: string | null) => void;
  restore: (key: string, side?: 'left' | 'right') => void;
  minimize: (key: string) => void;
  close: (key: string) => void;
  dismiss: (key: string) => void;
  dismissAll: () => void;
  /** Back in the panel showing `key`. */
  back: (key: string) => void;
  focus: (key: string) => void;
  moveTab: (key: string, to: number) => void;
  closeTabs: (except?: string) => void;
  setLabel: (key: string, label: DockLabel) => void;
  /** Leaves `key` out of the saved dock (it belongs to the project the page is switching to). */
  forget: (key: string) => void;
}

export const DockContext = createContext<DockApi | null>(null);

export function useDock(): DockApi {
  const dock = useContext(DockContext);
  if (!dock) throw new Error('useDock is only available inside DockProvider');
  return dock;
}

/** The dock's state; the component re-renders when it changes. */
export function useDockState(): DockState {
  const dock = useDock();
  return useSyncExternalStore(dock.subscribe, dock.get);
}

/** The panel a component is rendered in: links inside it open in it, and it reports its tab's label. */
export interface PanelInfo {
  key: string;
  item: DockItem;
  /** On screen (not minimized). Hidden panels stay mounted so drafts survive; they skip their queries. */
  shown: boolean;
  /** The panel worked in last. */
  active: boolean;
  /** Links followed in this panel that Back returns through. */
  canGoBack: boolean;
  titleId: string;
  close: () => void;
  minimize: () => void;
  back: () => void;
}

export const PanelContext = createContext<PanelInfo | null>(null);

export function usePanel(): PanelInfo {
  const panel = useContext(PanelContext);
  if (!panel) throw new Error('usePanel is only available inside a dock panel');
  return panel;
}

/** Opens a task: inside a panel, in that panel (Back returns); elsewhere, in the panel worked in last. */
export function useOpenTask(): (ref: number | string) => void {
  const dock = useDock();
  const from = useContext(PanelContext)?.key ?? null;
  return useCallback((ref) => dock.open({ kind: 'task', ref }, from), [dock, from]);
}

/**
 * Opens a file the same way. Given the file itself (the Explorer has it), its panel shows at once instead of
 * loading it first.
 */
export function useOpenFile(): (file: number | FileItem, opts?: { edit?: boolean; hash?: string }) => void {
  const dock = useDock();
  const qc = useQueryClient();
  const from = useContext(PanelContext)?.key ?? null;
  return useCallback(
    (file, opts = {}) => {
      const id = typeof file === 'number' ? file : file.id;
      if (typeof file !== 'number') qc.setQueryData(['file', id], file);
      dock.open({ kind: 'file', ref: id, ...(opts.edit && { edit: true }), ...(opts.hash && { hash: opts.hash }) }, from);
    },
    [dock, qc, from],
  );
}

const WIDE = '(min-width: 900px)';

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Wide enough for two panels side by side (and the sidebar); phones show one panel at a time. */
export function useWideScreen(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
}

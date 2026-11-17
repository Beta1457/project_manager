import { close, normalize, type DockState } from './model';

/**
 * One project's dock in this tab. Kept in sessionStorage, so a reload or Back from another site finds the
 * same panels and tabs, while another tab (or another project) has its own.
 */
export class DockStore {
  private state: DockState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storageKey: string) {
    this.state = load(storageKey);
  }

  get = (): DockState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Runs a rule from model.ts; listeners hear of it only if something changed. */
  apply = (change: (state: DockState) => DockState): void => {
    const next = change(this.state);
    if (next === this.state) return;
    this.state = next;
    save(this.storageKey, next);
    for (const listener of [...this.listeners]) listener();
  };

  /**
   * Saves the dock without one item but leaves this tab's copy alone: the page is about to switch to another
   * project (the item belongs there), and a change here now would only make this dock tidy up the address.
   */
  forget = (key: string): void => save(this.storageKey, close(this.state, key));
}

function load(key: string): DockState {
  try {
    return normalize(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
  } catch {
    return normalize(null); // storage blocked, or not JSON
  }
}

function save(key: string, state: DockState): void {
  try {
    // Requests (start editing, scroll to a heading) are for the moment they are made, not for a reload.
    const items = state.items.map(({ request: _request, ...item }) => item);
    sessionStorage.setItem(key, JSON.stringify({ ...state, items }));
  } catch {
    /* storage blocked or full: the dock lasts until the tab closes */
  }
}

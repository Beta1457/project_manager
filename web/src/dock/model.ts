/**
 * The dock: tasks and documents open in panels on the right (two side by side on a wide screen) or minimized to
 * tabs along the bottom. This file holds its state and rules only: no React, DOM or imports, so the server's
 * test runner can check it too (test/dock.test.ts).
 *
 * - An item opened from the page or a link shows in the panel worked in last, replacing what was there, as a
 *   single panel always did. It is "transient": closing or dismissing it is the end of it.
 * - Minimizing makes an item "kept": it has a tab in the tray until it is closed with ✕, and dismissing it
 *   (Esc, Back, a click outside) puts it back in the tray instead of closing it.
 * - A tab clicked while one panel is open shows beside it; with two open it takes the place of the one not
 *   worked in last. A tab can also be dragged to a side.
 * - Phones show one panel at a time: open() and restore() take the number of panels the screen has room for.
 */

export type DockKind = 'task' | 'file';

/** What to open: a task by id or key ("APP-12"), or a file by id. */
export interface DockTarget {
  kind: DockKind;
  ref: number | string;
  /** Files: open the editor. */
  edit?: boolean;
  /** Files: the part of an HTML page to show ("#install"). */
  hash?: string;
}

/** What a tab shows, reported by the item's panel once it has loaded. */
export interface DockLabel {
  /** A task's id (it may have been opened by key). */
  id?: number;
  /** A task's key ("APP-12"). */
  code?: string;
  title: string;
  /** A task's status colour. */
  color?: string;
}

export interface DockItem {
  /** "task:12", "task:APP-12" or "file:5": unique in the dock. */
  key: string;
  kind: DockKind;
  ref: number | string;
  /** Minimized at least once: it keeps a tab in the tray until closed, and dismissing it minimizes it. */
  kept: boolean;
  label?: DockLabel;
  /** For the panel: start editing, show part of a page. `n` changes with each request. Not saved. */
  request?: { edit?: boolean; hash?: string; n: number };
}

/** A panel on screen: the item it shows, and the items it showed before (links followed in it), oldest first. */
export interface DockSlot {
  key: string;
  back: DockTarget[];
}

export interface DockState {
  /** Open items, in tab order (the tray shows the kept ones). */
  items: DockItem[];
  /** Panels on screen, left to right. */
  slots: DockSlot[];
  /** The item in the panel worked in last: links open there, Esc and Back act on it. Null when none is shown. */
  active: string | null;
  /** Counter for `request.n`. */
  seq: number;
}

export const MAX_SLOTS = 2;
/** Enough tabs for anyone; past it the first ones not on screen are closed. */
export const MAX_ITEMS = 30;
/** How many links back a panel remembers. */
export const MAX_BACK = 20;

export const EMPTY: DockState = { items: [], slots: [], active: null, seq: 0 };

const TASK_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

function normRef(kind: DockKind, ref: unknown): number | string | null {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref > 0 ? ref : null;
  if (kind === 'task' && typeof ref === 'string' && TASK_KEY.test(ref)) return ref.toUpperCase();
  return null;
}

export function keyOf(t: { kind: DockKind; ref: number | string }): string {
  return `${t.kind}:${typeof t.ref === 'string' ? t.ref.toUpperCase() : t.ref}`;
}

/** The open item a target refers to: the same key, or (tasks) the id or key its panel has reported. */
export function findItem(state: DockState, t: { kind: DockKind; ref: number | string }): DockItem | undefined {
  const key = keyOf(t);
  const exact = state.items.find((i) => i.key === key);
  if (exact || t.kind !== 'task') return exact;
  return state.items.find(
    (i) => i.kind === 'task' && (typeof t.ref === 'number' ? i.label?.id === t.ref : i.label?.code === t.ref.toUpperCase()),
  );
}

export const slotOf = (state: DockState, key: string | null): number => (key === null ? -1 : state.slots.findIndex((s) => s.key === key));
export const isShown = (state: DockState, key: string): boolean => slotOf(state, key) !== -1;
export const trayItems = (state: DockState): DockItem[] => state.items.filter((i) => i.kept);
export const itemOf = (state: DockState, key: string | null): DockItem | undefined =>
  key === null ? undefined : state.items.find((i) => i.key === key);

function asTarget(item: DockItem): DockTarget {
  return { kind: item.kind, ref: item.ref, ...(item.request?.hash && { hash: item.request.hash }) };
}

function newItem(t: DockTarget): DockItem {
  const ref = normRef(t.kind, t.ref) ?? t.ref;
  return { key: keyOf({ kind: t.kind, ref }), kind: t.kind, ref, kept: false };
}

/** The target's edit/hash request on the item, numbered so the panel sees a new one even if it is the same. */
function withRequest(item: DockItem, t: DockTarget, seq: number): DockItem {
  return t.edit || t.hash ? { ...item, request: { ...(t.edit && { edit: true }), ...(t.hash && { hash: t.hash }), n: seq } } : item;
}

/** An item leaving the screen: a kept one goes back to the tray, a transient one closes. */
function putAway(items: DockItem[], key: string): DockItem[] {
  const item = items.find((i) => i.key === key);
  return item && !item.kept ? items.filter((i) => i.key !== key) : items;
}

/** The slot of `key` taken off the screen; the other panel (if any) becomes the active one when needed. */
function withoutSlot(state: DockState, key: string): DockState {
  const slots = state.slots.filter((s) => s.key !== key);
  const active = state.active !== key && slots.some((s) => s.key === state.active) ? state.active : (slots[slots.length - 1]?.key ?? null);
  return { ...state, slots, active };
}

/** Too many items: close the first ones that aren't on screen (or, `spare`, were on screen a moment ago). */
function capped(state: DockState, spare?: string): DockState {
  if (state.items.length <= MAX_ITEMS) return state;
  const onScreen = new Set(state.slots.map((s) => s.key));
  if (spare) onScreen.add(spare);
  const items = [...state.items];
  for (let i = 0; i < items.length && items.length > MAX_ITEMS; ) {
    if (onScreen.has(items[i].key)) i++;
    else items.splice(i, 1);
  }
  return { ...state, items };
}

/**
 * Opens a target: from the page, in the panel worked in last (or alone, if none is open); from a link inside a
 * panel (`from` = that panel's item), in that panel. An item already on screen is just made active.
 */
export function open(state: DockState, target: DockTarget, from?: string | null, max = MAX_SLOTS): DockState {
  const seq = target.edit || target.hash ? state.seq + 1 : state.seq;
  const found = findItem(state, target);
  let items = found ? state.items.map((i) => (i === found ? withRequest(i, target, seq) : i)) : state.items;
  if (found && isShown(state, found.key)) return { ...state, items, seq, active: found.key };
  const item = found ? items.find((i) => i.key === found.key)! : withRequest(newItem(target), target, seq);
  if (!found) items = [...items, item];
  const fromSlot = from != null ? slotOf(state, from) : -1;
  const at = fromSlot !== -1 ? fromSlot : slotOf(state, state.active);
  if (at === -1) {
    return capped({ ...state, items, seq, slots: [...state.slots.slice(0, max - 1), { key: item.key, back: [] }], active: item.key });
  }
  const slot = state.slots[at];
  const current = items.find((i) => i.key === slot.key);
  items = putAway(items, slot.key);
  const back = current ? [...slot.back, asTarget(current)].slice(-MAX_BACK) : slot.back;
  const slots = state.slots.map((s, j) => (j === at ? { key: item.key, back } : s));
  return capped({ ...state, items, seq, slots, active: item.key }, slot.key);
}

/**
 * Shows an open item (a tab clicked or dropped): alone if nothing is shown, beside the one panel open (on the
 * left unless `side` says otherwise), or in place of the panel on `side` / the one not worked in last.
 * An item already on screen moves to `side`, swapping with the other panel.
 */
export function restore(state: DockState, key: string, side?: 'left' | 'right', max = MAX_SLOTS): DockState {
  if (!state.items.some((i) => i.key === key)) return state;
  const at = slotOf(state, key);
  if (at !== -1) {
    const want = side === 'left' ? 0 : side === 'right' ? state.slots.length - 1 : at;
    return { ...state, slots: want === at ? state.slots : [...state.slots].reverse(), active: key };
  }
  const fresh: DockSlot = { key, back: [] };
  if (state.slots.length < max) {
    const slots = side === 'right' ? [...state.slots, fresh] : [fresh, ...state.slots];
    return { ...state, slots, active: key };
  }
  const t = side === 'left' ? 0 : side === 'right' ? state.slots.length - 1 : Math.max(0, state.slots.findIndex((s) => s.key !== state.active));
  const items = putAway(state.items, state.slots[t].key);
  return { ...state, items, slots: state.slots.map((s, j) => (j === t ? fresh : s)), active: key };
}

/** Minimizes an item to the tray. A newly kept item's tab goes last. */
export function minimize(state: DockState, key: string): DockState {
  const item = itemOf(state, key);
  if (!item) return state;
  const items = item.kept ? state.items : [...state.items.filter((i) => i.key !== key), { ...item, kept: true }];
  return withoutSlot({ ...state, items }, key);
}

/** Closes an item: off the screen and out of the tray, and no longer something Back goes to. */
export function close(state: DockState, key: string): DockState {
  if (!itemOf(state, key)) return state;
  const items = state.items.filter((i) => i.key !== key);
  const slots = state.slots.map((s) => (s.back.some((t) => keyOf(t) === key) ? { ...s, back: s.back.filter((t) => keyOf(t) !== key) } : s));
  return withoutSlot({ ...state, items, slots }, key);
}

/** Esc, Back with nothing to go back to, a click outside: kept items go back to the tray, others close. */
export function dismiss(state: DockState, key: string): DockState {
  const item = itemOf(state, key);
  if (!item) return state;
  return item.kept ? minimize(state, key) : close(state, key);
}

export function dismissAll(state: DockState): DockState {
  return state.slots.reduce((s, slot) => dismiss(s, slot.key), state);
}

/** The screen has room for `max` panels now (a phone, a narrowed window): the others go to the tray. */
export function fit(state: DockState, max: number): DockState {
  let s = state;
  while (s.slots.length > Math.max(1, max)) {
    const other = s.slots.find((x) => x.key !== s.active) ?? s.slots[0];
    s = minimize(s, other.key);
  }
  return s;
}

/** Back in the active panel: the item it showed before, or (when there is none) dismissing it. */
export function back(state: DockState): DockState {
  const at = slotOf(state, state.active);
  if (at === -1) return state;
  const slot = state.slots[at];
  if (!slot.back.length) return dismiss(state, slot.key);
  const target = slot.back[slot.back.length - 1];
  let items = putAway(state.items, slot.key);
  const found = findItem({ ...state, items }, target);
  // Already in the other panel: this one closes and that one carries on.
  if (found && state.slots.some((s, j) => j !== at && s.key === found.key)) {
    return { ...withoutSlot({ ...state, items }, slot.key), active: found.key };
  }
  const item = found ?? newItem(target);
  if (!found) items = [...items, withRequest(item, target, state.seq + 1)];
  const slots = state.slots.map((s, j) => (j === at ? { key: item.key, back: s.back.slice(0, -1) } : s));
  return { ...state, items, slots, active: item.key, seq: found ? state.seq : state.seq + 1 };
}

/** Makes a panel on screen the one worked in. */
export function focus(state: DockState, key: string): DockState {
  return state.active === key || !isShown(state, key) ? state : { ...state, active: key };
}

export function swap(state: DockState): DockState {
  return state.slots.length === 2 ? { ...state, slots: [state.slots[1], state.slots[0]] } : state;
}

/** Moves a tab to `to` among the tabs (the kept items). */
export function moveTab(state: DockState, key: string, to: number): DockState {
  const tabs = trayItems(state);
  const from = tabs.findIndex((i) => i.key === key);
  const index = Math.max(0, Math.min(to, tabs.length - 1));
  if (from === -1 || from === index) return state;
  const moved = [...tabs];
  const [item] = moved.splice(from, 1);
  moved.splice(index, 0, item);
  return { ...state, items: [...moved, ...state.items.filter((i) => !i.kept)] };
}

/** Closes every tab (kept item), or every tab but one. Panels never minimized stay open. */
export function closeTabs(state: DockState, except?: string): DockState {
  return trayItems(state).reduce((s, i) => (i.key === except ? s : close(s, i.key)), state);
}

const sameLabel = (a: DockLabel | undefined, b: DockLabel) =>
  !!a && a.id === b.id && a.code === b.code && a.title === b.title && a.color === b.color;

/**
 * What an item's tab shows, as its panel reports it. A task opened twice (by key and by id) turns out to be one
 * item here: the copy on screen stays (this one if both are, or neither), keeping a tab if either had one.
 */
export function setLabel(state: DockState, key: string, label: DockLabel): DockState {
  const item = itemOf(state, key);
  if (!item || sameLabel(item.label, label)) return state;
  const next = { ...state, items: state.items.map((i) => (i.key === key ? { ...i, label } : i)) };
  if (item.kind !== 'task' || label.id === undefined) return next;
  const twin = next.items.find(
    (i) =>
      i.key !== key &&
      i.kind === 'task' &&
      (i.ref === label.id || i.label?.id === label.id || (!!label.code && (i.ref === label.code || i.label?.code === label.code))),
  );
  if (!twin) return next;
  const keepTab = (s: DockState, k: string, kept: boolean) => (kept ? { ...s, items: s.items.map((i) => (i.key === k ? { ...i, kept: true } : i)) } : s);
  if (isShown(next, twin.key) && !isShown(next, key)) return keepTab(close(next, key), twin.key, item.kept);
  return keepTab(close(next, twin.key), key, twin.kept);
}

/** A dock read back from storage: anything malformed is dropped, so a bad copy can't break the page. */
export function normalize(raw: unknown): DockState {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const r = raw as { items?: unknown; slots?: unknown; active?: unknown; seq?: unknown };
  const items: DockItem[] = [];
  for (const x of Array.isArray(r.items) ? r.items : []) {
    const i = x as Partial<DockItem> | null;
    if (!i || (i.kind !== 'task' && i.kind !== 'file')) continue;
    const ref = normRef(i.kind, i.ref);
    if (ref === null) continue;
    const key = keyOf({ kind: i.kind, ref });
    if (items.some((o) => o.key === key)) continue;
    const l = i.label as Partial<DockLabel> | undefined;
    const label: DockLabel | undefined =
      l && typeof l.title === 'string'
        ? {
            title: l.title.slice(0, 500),
            ...(Number.isInteger(l.id) && { id: l.id }),
            ...(typeof l.code === 'string' && { code: l.code.slice(0, 30) }),
            ...(typeof l.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(l.color) && { color: l.color }),
          }
        : undefined;
    items.push({ key, kind: i.kind, ref, kept: i.kept === true, ...(label && { label }) });
  }
  const slots: DockSlot[] = [];
  for (const x of Array.isArray(r.slots) ? r.slots : []) {
    const s = x as Partial<DockSlot> | null;
    if (!s || typeof s.key !== 'string' || !items.some((i) => i.key === s.key) || slots.some((o) => o.key === s.key)) continue;
    const back: DockTarget[] = [];
    for (const y of Array.isArray(s.back) ? s.back : []) {
      const t = y as Partial<DockTarget> | null;
      const ref = t && (t.kind === 'task' || t.kind === 'file') ? normRef(t.kind, t.ref) : null;
      if (t && ref !== null) back.push({ kind: t.kind as DockKind, ref, ...(typeof t.hash === 'string' && t.hash.startsWith('#') && { hash: t.hash.slice(0, 500) }) });
    }
    slots.push({ key: s.key, back: back.slice(-MAX_BACK) });
    if (slots.length === MAX_SLOTS) break;
  }
  // A transient item only lives while it is on screen.
  const kept = items.filter((i) => i.kept || slots.some((s) => s.key === i.key)).slice(-MAX_ITEMS);
  const shown = slots.filter((s) => kept.some((i) => i.key === s.key));
  const active = shown.some((s) => s.key === r.active) ? (r.active as string) : (shown[shown.length - 1]?.key ?? null);
  return { items: kept, slots: shown, active, seq: Number.isInteger(r.seq) ? (r.seq as number) : 0 };
}

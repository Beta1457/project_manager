// The dock's rules (web/src/dock/model.ts): panels on screen, tabs in the tray, links, Back, Esc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY,
  MAX_ITEMS,
  back,
  close,
  closeTabs,
  dismiss,
  dismissAll,
  findItem,
  fit,
  focus,
  minimize,
  moveTab,
  normalize,
  open,
  restore,
  setLabel,
  swap,
  tabHints,
  trayItems,
  type DockItem,
  type DockState,
} from '../web/src/dock/model.ts';

const task = (ref: number | string) => ({ kind: 'task' as const, ref });
const file = (ref: number) => ({ kind: 'file' as const, ref });
const shown = (s: DockState) => s.slots.map((x) => x.key);
const tabs = (s: DockState) => trayItems(s).map((i) => i.key);
const keys = (s: DockState) => s.items.map((i) => i.key);

/** Opens each target from the page and minimizes it: tabs in the tray, nothing on screen. */
function withTabs(...targets: Array<{ kind: 'task' | 'file'; ref: number | string }>): DockState {
  return targets.reduce((s, t) => {
    const next = open(s, t);
    return minimize(next, next.active!);
  }, EMPTY);
}

test('opening from the page shows one panel and replaces it, as the single panel always did', () => {
  let s = open(EMPTY, task(1));
  assert.deepEqual(shown(s), ['task:1']);
  assert.equal(s.active, 'task:1');
  s = open(s, file(5));
  assert.deepEqual(shown(s), ['file:5']);
  assert.deepEqual(keys(s), ['file:5'], 'the task was never minimized, so it closed');
  assert.deepEqual(tabs(s), []);
});

test('task keys are matched case-insensitively and opening what is on screen only focuses it', () => {
  let s = open(EMPTY, task('app-3'));
  assert.equal(s.active, 'task:APP-3');
  const again = open(s, task('APP-3'));
  assert.deepEqual(again.slots, s.slots);
  s = setLabel(s, 'task:APP-3', { id: 12, code: 'APP-3', title: 'Login' });
  assert.equal(findItem(s, task(12))?.key, 'task:APP-3', 'found by the id its panel reported');
});

test('minimize keeps an item as a tab; ✕ closes it; dismissing depends on whether it was kept', () => {
  let s = open(EMPTY, task(1));
  s = minimize(s, 'task:1');
  assert.deepEqual(shown(s), []);
  assert.equal(s.active, null);
  assert.deepEqual(tabs(s), ['task:1']);

  s = restore(s, 'task:1');
  assert.deepEqual(shown(s), ['task:1']);
  s = dismiss(s, 'task:1');
  assert.deepEqual(tabs(s), ['task:1'], 'a kept item goes back to the tray');

  s = open(s, task(2));
  s = dismiss(s, 'task:2');
  assert.deepEqual(keys(s), ['task:1'], 'a transient item closes');

  s = close(s, 'task:1');
  assert.deepEqual(s, { ...EMPTY, seq: s.seq });
});

test('a newly minimized item gets the last tab; minimizing again keeps its place', () => {
  let s = withTabs(task(1), task(2), task(3));
  assert.deepEqual(tabs(s), ['task:1', 'task:2', 'task:3']);
  s = restore(s, 'task:1');
  s = minimize(s, 'task:1');
  assert.deepEqual(tabs(s), ['task:1', 'task:2', 'task:3']);
});

test('a tab shows alone, beside the one panel open (left by default), or in place of the panel not worked in', () => {
  let s = withTabs(task(1), task(2), task(3));
  s = restore(s, 'task:1');
  assert.deepEqual(shown(s), ['task:1']);
  s = restore(s, 'task:2');
  assert.deepEqual(shown(s), ['task:2', 'task:1'], 'beside it, on the left');
  assert.equal(s.active, 'task:2');
  s = restore(s, 'task:3');
  assert.deepEqual(shown(s), ['task:2', 'task:3'], 'took the place of task:1, the one not worked in last');
  assert.deepEqual(tabs(s), ['task:1', 'task:2', 'task:3'], 'task:1 is still a tab');

  // A transient panel that gets replaced closes.
  let t = withTabs(task(7), task(8));
  t = open(t, task(9));
  t = restore(t, 'task:7');
  t = focus(t, 'task:7');
  t = restore(t, 'task:8');
  assert.deepEqual(shown(t), ['task:7', 'task:8']);
  assert.equal(findItem(t, task(9)), undefined);
});

test('a tab dropped on a side goes there; one already on screen swaps sides', () => {
  let s = withTabs(task(1), task(2), task(3));
  s = restore(s, 'task:1');
  s = restore(s, 'task:2', 'right');
  assert.deepEqual(shown(s), ['task:1', 'task:2']);
  s = restore(s, 'task:3', 'left');
  assert.deepEqual(shown(s), ['task:3', 'task:2']);
  s = restore(s, 'task:2', 'left');
  assert.deepEqual(shown(s), ['task:2', 'task:3']);
  assert.deepEqual(swap(s).slots.map((x) => x.key), ['task:3', 'task:2']);
});

test('links open in their own panel, and Back returns through them before closing it', () => {
  let s = withTabs(file(1));
  s = restore(s, 'file:1');
  s = open(s, task(2)); // from the page: the panel worked in (the only one)
  assert.deepEqual(shown(s), ['task:2']);
  assert.deepEqual(tabs(s), ['file:1'], 'the kept doc went back to the tray');
  s = open(s, task(3), 'task:2'); // a link inside task:2's panel
  assert.deepEqual(shown(s), ['task:3']);
  assert.equal(findItem(s, task(2)), undefined, 'transient task:2 lives on only in the history');
  s = back(s);
  assert.deepEqual(shown(s), ['task:2']);
  s = back(s);
  assert.deepEqual(shown(s), ['file:1'], 'and back to the doc, out of the tray');
  s = back(s);
  assert.deepEqual(shown(s), [], 'nothing left to go back to: dismissed (kept, so minimized)');
  assert.deepEqual(tabs(s), ['file:1']);
});

test('a link in one panel to what the other shows only focuses it; Back into it closes the first panel', () => {
  let s = withTabs(task(1), task(2));
  s = restore(s, 'task:1');
  s = restore(s, 'task:2');
  s = open(s, task(1), 'task:2');
  assert.deepEqual(shown(s), ['task:2', 'task:1']);
  assert.equal(s.active, 'task:1');

  s = focus(s, 'task:2');
  s = open(s, task(5), 'task:2');
  s = open(s, task(1), 'task:5'); // task:1 is on screen already: focus only, no history entry
  s = focus(s, 'task:5');
  s = back(s);
  assert.deepEqual(shown(s), ['task:2', 'task:1']);
  assert.equal(s.active, 'task:2');
});

test('a link from a panel that has closed meanwhile opens in the panel worked in', () => {
  let s = open(EMPTY, task(1));
  s = open(s, task(2), 'task:99');
  assert.deepEqual(shown(s), ['task:2']);
});

test('closing an item forgets it in every history; dismissAll clears the screen', () => {
  let s = withTabs(task(1));
  s = restore(s, 'task:1');
  s = open(s, task(2), 'task:1');
  s = close(s, 'task:1');
  assert.deepEqual(s.slots[0].back, []);
  s = withTabs(task(3), task(4));
  s = restore(restore(s, 'task:3'), 'task:4');
  s = dismissAll(s);
  assert.deepEqual(shown(s), []);
  assert.deepEqual(tabs(s), ['task:3', 'task:4']);
});

test('tabs can be reordered and closed together; panels never minimized stay', () => {
  let s = withTabs(task(1), task(2), task(3));
  s = moveTab(s, 'task:3', 0);
  assert.deepEqual(tabs(s), ['task:3', 'task:1', 'task:2']);
  s = moveTab(s, 'task:3', 99);
  assert.deepEqual(tabs(s), ['task:1', 'task:2', 'task:3']);
  s = open(s, task(9));
  const others = closeTabs(s, 'task:2');
  assert.deepEqual(tabs(others), ['task:2']);
  assert.deepEqual(shown(others), ['task:9']);
  assert.deepEqual(tabs(closeTabs(s)), []);
});

test('one task opened by key and by id ends up as one item, keeping its tab', () => {
  let s = withTabs(task(12));
  s = open(s, task('APP-3'));
  s = setLabel(s, 'task:APP-3', { id: 12, code: 'APP-3', title: 'Login' });
  assert.deepEqual(keys(s), ['task:APP-3']);
  assert.equal(s.items[0].kept, true, 'kept, since the other copy had a tab');
  assert.deepEqual(shown(s), ['task:APP-3']);
  const same = setLabel(s, 'task:APP-3', { id: 12, code: 'APP-3', title: 'Login' });
  assert.equal(same, s, 'an unchanged label leaves the state as it is');
});

test('edit and hash requests reach the panel, numbered so a repeat is noticed', () => {
  let s = open(EMPTY, { kind: 'file', ref: 4, edit: true });
  const first = s.items[0].request;
  assert.equal(first?.edit, true);
  s = open(s, { kind: 'file', ref: 4, hash: '#setup' });
  assert.equal(s.items[0].request?.hash, '#setup');
  assert.ok(s.items[0].request!.n > first!.n);
});

test('a phone shows one panel: tabs and links replace it, and fit() sends the other panel to the tray', () => {
  let s = withTabs(task(1), task(2));
  s = restore(s, 'task:1', undefined, 1);
  s = restore(s, 'task:2', 'left', 1);
  assert.deepEqual(shown(s), ['task:2']);
  assert.deepEqual(tabs(s), ['task:1', 'task:2'], 'task:1 went back to its tab');
  s = minimize(s, 'task:2');
  s = open(s, task(3), null, 1);
  assert.deepEqual(shown(s), ['task:3']);

  // Two panels, then the window narrows: the one worked in stays.
  let t = restore(restore(withTabs(task(4), task(5)), 'task:4'), 'task:5');
  t = open(t, task(6), 'task:5'); // a link in the right panel: transient task:6 replaces task:5 there
  t = focus(t, 'task:4');
  t = fit(t, 1);
  assert.deepEqual(shown(t), ['task:4']);
  assert.deepEqual(tabs(t), ['task:4', 'task:5', 'task:6'], 'task:6 was not closed but minimized');
  assert.equal(fit(t, 1), t, 'nothing to do');
  assert.equal(fit(t, 2), t);
});

test('the dock is capped, closing tabs that are not on screen first', () => {
  let s = EMPTY;
  for (let i = 1; i <= MAX_ITEMS + 5; i++) s = minimize(open(s, task(i)), `task:${i}`);
  assert.equal(s.items.length, MAX_ITEMS);
  assert.equal(findItem(s, task(5)), undefined, 'the first tabs went first');
  assert.ok(findItem(s, task(6)));
  // Two on screen: neither is closed to make room, even the oldest tab.
  s = restore(restore(s, 'task:6'), 'task:7');
  s = open(s, task(999));
  assert.equal(s.items.length, MAX_ITEMS);
  assert.ok(findItem(s, task(6)), 'on screen, so kept');
  assert.equal(findItem(s, task(8)), undefined, 'the first tab not on screen went');
});

test('a dock read back from storage keeps what is valid and drops the rest', () => {
  const raw = {
    items: [
      { kind: 'task', ref: 3, kept: true, label: { title: 'Three', code: 'APP-3', id: 3, color: '#123456' }, request: { edit: true, n: 4 } },
      { kind: 'task', ref: 'app-4', kept: false },
      { kind: 'task', ref: 5, kept: false },
      { kind: 'file', ref: 'x', kept: true },
      { kind: 'file', ref: 7, kept: true, label: { title: 'a.md', folder: 4 } },
      { kind: 'file', ref: 8, kept: true, label: { title: 'b.md', folder: null } },
      { kind: 'file', ref: 9, kept: true, label: { title: 'c.md', folder: 'x' } },
      { kind: 'file', ref: 10, kept: true, label: { title: 'd.md', folder: -1 } },
      { kind: 'nope', ref: 1, kept: true },
      { kind: 'task', ref: 3, kept: true },
      null,
    ],
    slots: [{ key: 'task:APP-4', back: [{ kind: 'task', ref: 3 }, { kind: 'file', ref: -2 }] }, { key: 'task:404', back: [] }],
    active: 'task:404',
    seq: 7,
  };
  const s = normalize(raw);
  assert.deepEqual(keys(s), ['task:3', 'task:APP-4', 'file:7', 'file:8', 'file:9', 'file:10'], 'task:5 was transient and off screen; junk dropped');
  assert.equal(s.items[0].request, undefined, 'requests are not saved');
  assert.deepEqual(s.items.slice(2).map((i) => i.label), [
    { title: 'a.md', folder: 4 },
    { title: 'b.md', folder: null },
    { title: 'c.md' },
    { title: 'd.md' },
  ], "a file's folder is kept when it is one (null: the top of the project)");
  assert.deepEqual(s.slots, [{ key: 'task:APP-4', back: [{ kind: 'task', ref: 3 }] }]);
  assert.equal(s.active, 'task:APP-4');
  assert.equal(s.seq, 7);
  assert.deepEqual(normalize('garbage'), EMPTY);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(s))), s, 'a saved dock reads back the same');
});

test('a file moved to another folder gets a new label; the same label changes nothing', () => {
  let s = withTabs(file(7));
  s = setLabel(s, 'file:7', { title: 'a.md', folder: 4 });
  assert.equal(setLabel(s, 'file:7', { title: 'a.md', folder: 4 }), s);
  s = setLabel(s, 'file:7', { title: 'a.md', folder: null });
  assert.equal(s.items[0].label?.folder, null);
});

test('tabs of files with the same name show as few of their folders as tell them apart', () => {
  const folders: Record<number, string[]> = {
    1: ['Design', 'Levels', 'World 1'],
    2: ['Design', 'Levels', 'World 2'],
    3: ['Art', 'Ideas'],
    4: ['Audio', 'Ideas'],
    5: ['Ideas'],
  };
  const dirsOf = (i: DockItem) => (i.label?.folder ? folders[i.label.folder] : []);
  const labelled = (...files: Array<[number, string, number | null]>) =>
    files.reduce((s, [ref, title, folder]) => setLabel(s, `file:${ref}`, { title, folder }), withTabs(...files.map(([ref]) => file(ref))));
  const hints = (s: DockState) => Object.fromEntries(tabHints(trayItems(s), dirsOf));

  // The folder each is in tells them apart; a name no other tab has needs nothing.
  assert.deepEqual(hints(labelled([10, 'Level 1.md', 1], [11, 'Level 1.md', 2], [12, 'Notes.md', 3])), {
    'file:10': ['World 1'],
    'file:11': ['World 2'],
  });
  // Same folder name, different places: one more folder up. A folder that is the whole path of the other: all of it.
  assert.deepEqual(hints(labelled([20, 'todo.md', 3], [21, 'todo.md', 4], [22, 'todo.md', 5])), {
    'file:20': ['Art', 'Ideas'],
    'file:21': ['Audio', 'Ideas'],
    'file:22': ['Ideas'],
  });
  // A file at the top of the project has no folders to show; the other shows its own.
  assert.deepEqual(hints(labelled([30, 'README.md', null], [31, 'README.md', 1])), { 'file:31': ['World 1'] });
  // Tasks never need one: their keys differ.
  let t = withTabs(task(1), task(2));
  t = setLabel(setLabel(t, 'task:1', { id: 1, code: 'APP-1', title: 'Same' }), 'task:2', { id: 2, code: 'APP-2', title: 'Same' });
  assert.deepEqual(hints(t), {});
});

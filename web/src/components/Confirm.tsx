import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Sheet } from './Sheet';

/**
 * The app's "are you sure?" dialog, used instead of window.confirm. It says exactly what will happen,
 * Cancel has the focus (so Enter never confirms by accident), and deletes that are hard to recover
 * from can require typing a name first.
 *
 *   if (!(await askConfirm({ title: 'Delete folder?', body: '…', confirmLabel: 'Delete folder' }))) return;
 */
export interface ConfirmOptions {
  title: string;
  /** What happens: what goes, what happens to anything inside, whether it can be undone. */
  body?: ReactNode;
  /** Label of the confirming button. Name the action ("Delete folder"). Default "Delete". */
  confirmLabel?: string;
  /** Red confirming button (default). Pass false for a question that destroys nothing. */
  danger?: boolean;
  /** Keeps the confirming button locked until this text is typed (letter case is ignored). */
  typeToConfirm?: string;
  /** An extra choice shown as a checkbox, unticked by default ("Also delete its 3 sub-tasks"). */
  checkbox?: string;
}

export interface ConfirmAnswer {
  ok: boolean;
  /** Whether the `checkbox` was ticked. */
  checked: boolean;
}

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (answer: ConfirmAnswer) => void;
}

// Questions wait in line; the host shows the first.
let queue: Pending[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const first = () => queue[0] ?? null;

function settle(id: number, answer: ConfirmAnswer) {
  const item = queue.find((p) => p.id === id);
  if (!item) return;
  queue = queue.filter((p) => p !== item);
  notify();
  item.resolve(answer);
}

/** Asks first. Resolves to true only if the user confirmed; with `checkbox`, to the full answer. */
export function askConfirm(options: ConfirmOptions & { checkbox: string }): Promise<ConfirmAnswer>;
export function askConfirm(options: ConfirmOptions): Promise<boolean>;
export function askConfirm(options: ConfirmOptions): Promise<boolean | ConfirmAnswer> {
  const answer = new Promise<ConfirmAnswer>((resolve) => {
    queue = [...queue, { ...options, id: nextId++, resolve }];
    notify();
  });
  return options.checkbox ? answer : answer.then((a) => a.ok);
}

/** Shows the questions askConfirm asks. Mounted once, at the root of the app. */
export function ConfirmHost() {
  const pending = useSyncExternalStore(subscribe, first);
  if (!pending) return null;
  // The wrapper lifts the dialog above any sheet that is already open (see .confirm-layer).
  return (
    <div className="confirm-layer">
      <ConfirmDialog key={pending.id} pending={pending} onAnswer={(a) => settle(pending.id, a)} />
    </div>
  );
}

function ConfirmDialog({ pending, onAnswer }: { pending: Pending; onAnswer: (answer: ConfirmAnswer) => void }) {
  const { title, body, confirmLabel = 'Delete', danger = true, typeToConfirm, checkbox } = pending;
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const typeRef = useRef<HTMLInputElement>(null);
  const locked = typeToConfirm !== undefined && typed.trim().toLowerCase() !== typeToConfirm.trim().toLowerCase();

  // Runs after the Sheet has focused itself: start on Cancel, or in the box to type in.
  useEffect(() => {
    (typeToConfirm !== undefined ? typeRef.current : cancelRef.current)?.focus({ preventScroll: true });
  }, [typeToConfirm]);

  return (
    <Sheet title={title} variant="center" onClose={() => onAnswer({ ok: false, checked })}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!locked) onAnswer({ ok: true, checked });
        }}
      >
        {body && <div className="confirm-body">{body}</div>}
        {checkbox && (
          <label className="row nowrap small">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {checkbox}
          </label>
        )}
        {typeToConfirm !== undefined && (
          <label className="field">
            <span>
              Type <b className="confirm-word">{typeToConfirm}</b> to confirm
            </span>
            <input
              ref={typeRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={() => onAnswer({ ok: false, checked })}>
            Cancel
          </button>
          <button type="submit" className={danger ? 'btn btn-danger-solid' : 'btn btn-primary'} disabled={locked}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

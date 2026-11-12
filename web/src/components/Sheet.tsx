import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  /** "side" = full screen on phones, right panel on desktop. "center" = bottom sheet / dialog. */
  variant?: 'side' | 'center';
  /** Asked before closing; return false to keep the sheet open (e.g. "Discard your unsaved task?"). */
  confirmClose?: () => boolean;
}

/** Open sheets, innermost last: only the topmost one reacts to Escape / Tab. */
const openSheets: number[] = [];
let nextSheetId = 1;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab / Shift+Tab cycling inside the dialog instead of wandering onto the page behind it. */
function trapFocus(e: KeyboardEvent, root: HTMLElement) {
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return e.preventDefault();
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!root.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export function Sheet({ title, onClose, children, actions, variant = 'side', confirmClose }: Props) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Latest props without re-running the mount effect (which would steal focus on every render).
  const requestClose = useRef(() => {});
  requestClose.current = () => {
    // Commit fields that save on blur (title, estimate, diagram labels) before they unmount.
    const active = document.activeElement as HTMLElement | null;
    if (active && ref.current?.contains(active)) active.blur();
    if (confirmClose && !confirmClose()) return;
    onClose();
  };

  useEffect(() => {
    const id = nextSheetId++;
    openSheets.push(id);
    const previousFocus = document.activeElement as HTMLElement | null;
    // Focus the dialog itself rather than its first field, so phones don't pop the keyboard open.
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (openSheets[openSheets.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose.current();
      } else if (e.key === 'Tab' && ref.current) {
        trapFocus(e, ref.current);
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      openSheets.splice(openSheets.indexOf(id), 1);
      document.body.style.overflow = prevOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className={`overlay ${variant === 'center' ? 'modal-center' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose.current()}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <button className="btn btn-ghost btn-icon" onClick={() => requestClose.current()} aria-label="Close">
            ✕
          </button>
          <div id={titleId} className="grow ellipsis" style={{ fontWeight: 700 }}>
            {title}
          </div>
          {actions}
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** Small promise-free confirm wrapper so intent is explicit at call sites. */
export function confirmAction(message: string): boolean {
  return window.confirm(message);
}

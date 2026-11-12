import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Kind = 'error' | 'info';

export interface ToastOptions {
  /** A button on the toast, such as Undo. Clicking it also closes the toast. */
  action?: { label: string; onClick: () => void };
  /** How long the toast stays, in ms. Default 3 s, or 6 s for errors. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
  kind: Kind;
}

type ShowToast = (message: string, kind?: Kind, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback<ShowToast>(
    (message, kind = 'info', options = {}) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs.slice(-2), { id, message, kind, ...options }]);
      window.setTimeout(() => dismiss(id), options.duration ?? (kind === 'error' ? 6000 : 3000));
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          // Clicking a toast closes it; the action button's click bubbles up here too, so it closes after acting.
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
            <span className="grow">{t.message}</span>
            {t.action && (
              <button type="button" className="toast-action" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

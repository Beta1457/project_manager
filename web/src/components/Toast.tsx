import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

const ToastContext = createContext<(message: string, kind?: 'error' | 'info') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((message: string, kind: 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, message, kind }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TaskRef } from './hooks';

/** "12" → 12 (task id), "app-12" → "APP-12" (task key); anything else → null. */
export function parseTaskRef(raw: string | null): TaskRef | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/.test(raw) ? raw.toUpperCase() : null;
}

/** ?task=ID (or ?task=KEY-12) opens the task sheet from anywhere. */
export function useTaskParam(): [TaskRef | null, (ref: TaskRef | null) => void] {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const ref = parseTaskRef(params.get('task'));
  const set = (next: TaskRef | null) => {
    // Opening pushes a history entry, so the phone's Back button closes the sheet (or returns to the task
    // you came from, after following a link). Closing pops that entry again rather than pushing another
    // (which would make Back re-open the task just closed).
    if (next === null && (location.state as { taskSheet?: boolean } | null)?.taskSheet) return navigate(-1);
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === null) p.delete('task');
        else p.set('task', String(next));
        return p;
      },
      next === null ? { replace: true } : { state: { taskSheet: true } },
    );
  };
  return [ref, set];
}

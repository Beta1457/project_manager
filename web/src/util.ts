export function formatMinutes(m: number | null | undefined): string {
  if (m == null) return '—';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (!h) return `${mm}m`;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Picks black or white text for a given background color. */
export function contrastText(hex: string): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111827' : '#ffffff';
}

export const STATUS_COLORS: Record<string, string> = {
  open: '#64748b',
  in_progress: '#2563eb',
  alpha_qa: '#d97706',
  alpha_complete: '#0d9488',
  beta_in_progress: '#7c3aed',
  beta_qa: '#db2777',
  beta_complete: '#059669',
  ready_to_ship: '#16a34a',
};

export const PRIORITY_COLORS: Record<string, string> = {
  low: '#94a3b8',
  medium: '#3b82f6',
  high: '#f59e0b',
  critical: '#ef4444',
};

export const LAYER_COLORS: Record<string, string> = {
  core: '#475569',
  gameplay: '#7c3aed',
  ui: '#0891b2',
  data: '#d97706',
  services: '#2563eb',
  tools: '#db2777',
  external: '#16a34a',
};

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "1 task", "3 tasks"; pass the plural for irregular words ("box", "boxes"). */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Ids of every task below these ones: their sub-tasks, the sub-tasks of those, and so on. */
export function tasksBelow(tasks: ReadonlyArray<{ id: number; parentId: number | null }>, ids: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>();
  for (const t of tasks) {
    if (t.parentId === null) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t.id);
    else children.set(t.parentId, [t.id]);
  }
  const found = new Set<number>();
  const queue = [...ids];
  while (queue.length) {
    for (const c of children.get(queue.pop()!) ?? []) {
      if (found.has(c)) continue;
      found.add(c);
      queue.push(c);
    }
  }
  return found;
}

/**
 * What the question before deleting one task says about its sub-tasks (`direct` of its own, `all` at every
 * level): where they go if they stay, and the box that deletes them too.
 */
export function subtaskDeleteWords(direct: number, all: number, parentKey: string | null): { stay: string; checkbox: string } {
  const deeper = all - direct;
  return {
    stay: `Its ${plural(direct, 'sub-task')} ${parentKey ? `will move up to ${parentKey}` : 'will stay, as top-level tasks,'} unless you tick the box.`,
    checkbox: `Also delete its ${plural(direct, 'sub-task')}${deeper > 0 ? ` and the ${deeper} below ${direct === 1 ? 'it' : 'them'}` : ''}`,
  };
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Shortens text for messages: "A very long checklist it…". */
export function clip(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Copies text to the clipboard. The Clipboard API only exists on HTTPS/localhost, and this app is
 * usually opened over plain-HTTP LAN (http://192.168.x.x:8080), so fall back to execCommand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

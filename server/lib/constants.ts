/** Kanban columns in order. `color` is the default; users can change it (status_colors table). */
export const STATUSES = [
  { id: 'open', label: 'Open', color: '#64748b' },
  { id: 'in_progress', label: 'In Progress', color: '#2563eb' },
  { id: 'alpha_qa', label: 'Alpha QA', color: '#d97706' },
  { id: 'alpha_complete', label: 'Alpha Complete', color: '#0d9488' },
  { id: 'beta_in_progress', label: 'Beta In Progress', color: '#7c3aed' },
  { id: 'beta_qa', label: 'Beta QA', color: '#db2777' },
  { id: 'beta_complete', label: 'Beta Complete', color: '#059669' },
  { id: 'ready_to_ship', label: 'Ready to Ship', color: '#16a34a' },
] as const;

export const DEFAULT_TYPE_COLORS: Record<string, string> = {
  Feature: '#2563eb',
  Bug: '#dc2626',
  Content: '#d97706',
  Art: '#db2777',
  Audio: '#7c3aed',
  Refactor: '#0891b2',
  Test: '#16a34a',
  Chore: '#64748b',
};

export type StatusId = (typeof STATUSES)[number]['id'];

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DEFAULT_TYPES = ['Feature', 'Bug', 'Content', 'Art', 'Audio', 'Refactor', 'Test', 'Chore'];

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** Accepts a status id ("alpha_qa") or label ("Alpha QA", "alpha-qa"). Returns null when unknown. */
export function normalizeStatus(input: string): StatusId | null {
  const key = squash(input);
  const found = STATUSES.find((s) => squash(s.id) === key || squash(s.label) === key);
  return found ? found.id : null;
}

export function statusLabel(id: string): string {
  return STATUSES.find((s) => s.id === id)?.label ?? id;
}

export function nextStatus(id: string): StatusId | null {
  const i = STATUSES.findIndex((s) => s.id === id);
  return i >= 0 && i < STATUSES.length - 1 ? STATUSES[i + 1].id : null;
}

export function normalizePriority(input: string): Priority | null {
  const p = input.toLowerCase().trim();
  return (PRIORITIES as readonly string[]).includes(p) ? (p as Priority) : null;
}

import { badRequest } from './errors.ts';

/** Parses a numeric id from a route param. */
export function parseId(raw: string, what = 'id'): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${what}: "${raw}"`);
  return n;
}

/** Project keys: a letter, then up to 9 letters or digits ("T", "APP", "GAME2"). Stored upper-case. */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;

export type TaskRef = { id: number } | { key: string; number: number };

/** A task reference: its database id ("57", as the web app uses) or its key ("APP-12", case-insensitive). */
export function parseTaskRef(raw: string): TaskRef {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return { id: Number(s) };
  const m = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(s);
  if (!m) throw badRequest(`Invalid task reference "${raw}". Use a key like APP-12.`);
  return { key: m[1].toUpperCase(), number: Number(m[2]) };
}

export const taskKey = (projectKey: string, number: number) => `${projectKey}-${number}`;

/**
 * Parses a duration into minutes. Accepts numbers (minutes), "90", "90m",
 * "1.5h", "1h30m", "2h 15m", "45 min", "45min", "1hr", "2 hours".
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw badRequest('Duration must be a positive number of minutes');
    return Math.round(input);
  }
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  // Longest units first: alternation is ordered, so "h" must not win over "hours"/"hr".
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)/g;
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(re)) {
    total += m[2].startsWith('h') ? Number(m[1]) * 60 : Number(m[1]);
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, '').length !== s.replace(/\s/g, '').length) {
    throw badRequest(`Could not parse duration "${input}". Examples: 90, 45m, 1.5h, 1h30m`);
  }
  return Math.round(total);
}

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function assertColor(c: string): string {
  if (!COLOR_RE.test(c)) throw badRequest(`Invalid color "${c}". Use #RRGGBB.`);
  return c.toLowerCase();
}

export function has<T extends object>(obj: T, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Comma-separated query param -> trimmed non-empty values. */
export function csv(v: string | undefined): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export function nonEmpty(value: string, field: string, max = 500): string {
  const v = value.trim();
  if (!v) throw badRequest(`${field} cannot be empty`);
  if (v.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return v;
}

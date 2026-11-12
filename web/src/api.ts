export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

/**
 * Random id for this browser tab. The server tags live-update events with it so the tab that made a
 * change can skip refetching data it already refreshed. (Not crypto.randomUUID: that needs HTTPS.)
 */
export const CLIENT_ID = `tab-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
/** When this tab last started a write; data fetched after it already includes that write. */
export let lastWriteStartedAt = 0;

/** The project this tab works in, sent as X-PM-Project. Kept in sync by ProjectProvider. */
let currentProject: number | null = null;
export const setCurrentProject = (id: number | null) => {
  currentProject = id;
};
export const getCurrentProject = () => currentProject;

/** `project` overrides the current project (queries cached under one project fetch for that project). */
async function request<T>(method: string, url: string, body?: unknown, project = currentProject): Promise<T> {
  const headers: Record<string, string> = { 'x-pm-client': 'web', 'x-pm-client-id': CLIENT_ID };
  if (project !== null) headers['x-pm-project'] = String(project);
  if (method !== 'GET') lastWriteStartedAt = Date.now();
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (method !== 'GET' && method !== 'DELETE') {
    headers['content-type'] = 'application/json';
    payload = '{}';
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/login')) unauthorizedListeners.forEach((fn) => fn());
    const msg = (data as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string, project?: number) => request<T>('GET', url, undefined, project),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export const V1 = '/api/v1';

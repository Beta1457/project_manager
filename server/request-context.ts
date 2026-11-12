import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request values available anywhere during that request's handling. */
export interface RequestStore {
  /** Random id of the browser tab that made the request (x-pm-client-id header), if any. */
  client?: string;
  /** Project the request was checked against (set by Access); tags its change events so only that project's owner hears them. */
  projectId?: number;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();

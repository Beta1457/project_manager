import { EventEmitter } from 'node:events';
import { requestContext } from './request-context.ts';

export type ChangeKind =
  | 'tasks'
  | 'epochs'
  | 'folders'
  | 'files'
  | 'categories'
  | 'types'
  | 'diagrams'
  | 'time'
  | 'projects';

export interface ChangeEvent {
  kind: ChangeKind;
  id?: number;
  actor?: string;
  /** Client id of the browser tab whose request caused this change; that tab already refreshed itself. */
  origin?: string;
  /** Project the change happened in. Live updates only go to people who can see it. */
  projectId?: number;
  /** For changes to a user's own things (their project list): only that user hears about it. */
  userId?: number;
}

/** In-process change bus: drives live UI refresh (SSE) and backup dirty tracking. */
export class ChangeBus {
  private emitter = new EventEmitter();
  /** Incremented on every change; backups compare against it. */
  revision = 0;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: ChangeEvent): void {
    this.revision++;
    const store = requestContext.getStore();
    const tagged: ChangeEvent = { ...event };
    if (store?.client) tagged.origin = store.client;
    if (tagged.projectId === undefined && tagged.userId === undefined && store?.projectId !== undefined) tagged.projectId = store.projectId;
    this.emitter.emit('change', tagged);
  }

  /** Records a change that should be backed up but that live UIs don't need to hear about (users, tokens, passwords). */
  markDirty(): void {
    this.revision++;
  }

  subscribe(listener: (e: ChangeEvent) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }
}

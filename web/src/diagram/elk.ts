import type { ElkNode } from './model';
// Vite copies ELK's web worker as it is and hands back its URL; the worker only starts on the first layout.
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';

interface Engine {
  layout(graph: ElkNode): Promise<ElkNode>;
  terminateWorker(): void;
}

/** A layout asked for while another was waiting replaces it; the one replaced ends with this. */
export class Superseded extends Error {
  constructor() {
    super('A newer layout was asked for');
  }
}

/** Longer than this and the worker is assumed stuck: it is stopped and a fresh one starts next time. */
const TIME_LIMIT_MS = 120_000;
/** Recent layouts, so going back to a view (opening a group again, say) is instant. */
const CACHE_SIZE = 12;
const cache = new Map<string, ElkNode>();

let engine: Promise<Engine> | null = null;
const getEngine = () => {
  engine ??= import('elkjs/lib/elk-api.js').then(({ default: ELK }) => new ELK({ workerUrl }) as unknown as Engine);
  return engine;
};

interface Job {
  key: string;
  graph: ElkNode;
  resolve: (result: ElkNode) => void;
  reject: (err: Error) => void;
}
let running = false;
let waiting: Job | null = null;

/**
 * Lays out a graph with ELK in a web worker, so the page never freezes. One layout runs at a time; of the ones
 * asked for meanwhile, only the newest runs next.
 */
export function layoutGraph(graph: ElkNode): Promise<ElkNode> {
  const key = JSON.stringify(graph);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    waiting?.reject(new Superseded());
    waiting = { key, graph, resolve, reject };
    void next();
  });
}

async function next(): Promise<void> {
  if (running || !waiting) return;
  const job = waiting;
  waiting = null;
  running = true;
  let timer: number | undefined;
  try {
    const elk = await getEngine();
    const result = await Promise.race([
      elk.layout(job.graph),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          // Stuck, or far too big: stop this worker; the next layout gets a new one.
          elk.terminateWorker();
          engine = null;
          reject(new Error('Arranging took too long. Close some groups or hide some layers, then try again.'));
        }, TIME_LIMIT_MS);
      }),
    ]);
    cache.set(job.key, result);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    job.resolve(result);
  } catch (err) {
    job.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    window.clearTimeout(timer);
    running = false;
    void next();
  }
}

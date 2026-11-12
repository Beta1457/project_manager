import { useEffect, useState } from 'react';
import { fromElk, type ElkNode, type Layout } from './model';
import { Superseded, layoutGraph } from './elk';

export interface Arranged<T> {
  layout: Layout;
  /** The request this layout answers (with the view it shows), so the picture and the layout always match. */
  request: T;
}

/**
 * Lays out `request.graph` in the background. Until the new layout is ready the last one stays, with the request
 * it was made for, so the picture never goes blank or half-updated. A null request (manual layout) asks nothing.
 */
export function useAutoLayout<T extends { graph: ElkNode }>(request: T | null) {
  const [arranged, setArranged] = useState<Arranged<T> | null>(null);
  const [arranging, setArranging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!request) {
      setArranging(false);
      return;
    }
    let current = true;
    setArranging(true);
    layoutGraph(request.graph).then(
      (result) => {
        if (!current) return;
        setArranged({ layout: fromElk(result), request });
        setError(null);
        setArranging(false);
      },
      (err: Error) => {
        if (!current || err instanceof Superseded) return;
        setError(err.message);
        setArranging(false);
      },
    );
    return () => {
      current = false;
    };
  }, [request]);
  return { arranged, arranging, error };
}

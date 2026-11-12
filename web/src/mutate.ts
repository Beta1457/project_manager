import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateKinds } from './hooks';
import { useToast } from './components/Toast';
import { errorMessage } from './util';

/**
 * Returns a runner for write operations: awaits the API call, refreshes the
 * affected queries and reports errors as a toast. Resolves to undefined on error.
 */
export function useMutate() {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    async <T>(fn: () => Promise<T>, kinds: string[], success?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        invalidateKinds(qc, kinds);
        if (success) toast(success);
        return result;
      } catch (err) {
        toast(errorMessage(err), 'error');
        invalidateKinds(qc, kinds); // resync any optimistic UI
        return undefined;
      }
    },
    [qc, toast],
  );
}

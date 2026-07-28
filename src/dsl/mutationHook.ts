import { useCallback, useRef, useState } from 'react';
import type { MutateCallbacks } from '../types';

export type MutationHandle<TData, TInput> = {
  mutate(input: TInput, callbacks?: MutateCallbacks<TData>): void;
  mutateAsync(input: TInput): Promise<TData | null>;
  isPending: boolean;
  error: Error | null;
};

export const useMutationHandle = <TData, TInput>(run: (input: TInput) => Promise<TData | null>): MutationHandle<TData, TInput> => {
  const runRef = useRef(run);
  runRef.current = run;
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mutateAsync = useCallback(async (input: TInput): Promise<TData | null> => {
    setPending(true);
    setError(null);
    try {
      return await runRef.current(input);
    } catch (nextError) {
      setError(nextError as Error);
      throw nextError;
    } finally {
      setPending(false);
    }
  }, []);
  const mutate = useCallback(
    (input: TInput, callbacks?: MutateCallbacks<TData>) => {
      mutateAsync(input)
        .then(data => callbacks?.onSuccess?.(data))
        .catch(nextError => callbacks?.onError?.(nextError as Error))
        .finally(() => callbacks?.onSettled?.());
    },
    [mutateAsync]
  );
  return { mutate, mutateAsync, isPending, error };
};

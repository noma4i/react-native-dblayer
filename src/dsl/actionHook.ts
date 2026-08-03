import { useCallback, useRef, useState } from 'react';
import type { ModelActionHook } from '../types';

export const useActionHandle = <TInput, TResult>(run: (input: TInput) => Promise<TResult | null>): ModelActionHook<TInput, TResult> => {
  const runRef = useRef(run);
  runRef.current = run;
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const execute = useCallback(async (input: TInput): Promise<TResult | null> => {
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
  return { run: execute, isPending, error };
};

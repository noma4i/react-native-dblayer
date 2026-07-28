"use strict";

import { useCallback, useRef, useState } from 'react';
export const useMutationHandle = run => {
  const runRef = useRef(run);
  runRef.current = run;
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const mutateAsync = useCallback(async input => {
    setPending(true);
    setError(null);
    try {
      return await runRef.current(input);
    } catch (nextError) {
      setError(nextError);
      throw nextError;
    } finally {
      setPending(false);
    }
  }, []);
  const mutate = useCallback((input, callbacks) => {
    mutateAsync(input).then(data => callbacks?.onSuccess?.(data)).catch(nextError => callbacks?.onError?.(nextError)).finally(() => callbacks?.onSettled?.());
  }, [mutateAsync]);
  return {
    mutate,
    mutateAsync,
    isPending,
    error
  };
};
//# sourceMappingURL=mutationHook.js.map
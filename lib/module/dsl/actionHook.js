"use strict";

import { useCallback, useRef, useState } from 'react';
export const useActionHandle = run => {
  const runRef = useRef(run);
  runRef.current = run;
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const execute = useCallback(async input => {
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
  return {
    run: execute,
    isPending,
    error
  };
};
//# sourceMappingURL=actionHook.js.map
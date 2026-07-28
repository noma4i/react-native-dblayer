"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useMutationHandle = void 0;
var _react = require("react");
const useMutationHandle = run => {
  const runRef = (0, _react.useRef)(run);
  runRef.current = run;
  const [isPending, setPending] = (0, _react.useState)(false);
  const [error, setError] = (0, _react.useState)(null);
  const mutateAsync = (0, _react.useCallback)(async input => {
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
  const mutate = (0, _react.useCallback)((input, callbacks) => {
    mutateAsync(input).then(data => callbacks?.onSuccess?.(data)).catch(nextError => callbacks?.onError?.(nextError)).finally(() => callbacks?.onSettled?.());
  }, [mutateAsync]);
  return {
    mutate,
    mutateAsync,
    isPending,
    error
  };
};
exports.useMutationHandle = useMutationHandle;
//# sourceMappingURL=mutationHook.js.map
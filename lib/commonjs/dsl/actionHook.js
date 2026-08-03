"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useActionHandle = void 0;
var _react = require("react");
const useActionHandle = run => {
  const runRef = (0, _react.useRef)(run);
  runRef.current = run;
  const [isPending, setPending] = (0, _react.useState)(false);
  const [error, setError] = (0, _react.useState)(null);
  const execute = (0, _react.useCallback)(async input => {
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
exports.useActionHandle = useActionHandle;
//# sourceMappingURL=actionHook.js.map
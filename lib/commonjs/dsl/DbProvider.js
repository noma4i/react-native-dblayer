"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DbProvider = void 0;
var _react = _interopRequireWildcard(require("react"));
var _reactNative = require("react-native");
var _reactQuery = require("@tanstack/react-query");
var _configure = require("./configure.js");
var _lifecycle = require("./lifecycle.js");
var _jsxRuntime = require("react/jsx-runtime");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
/**
 * Provide the library-owned query client and gate database consumers until boot completes.
 *
 * @param props Children plus optional boot-only lifecycle options.
 * @returns The internal query provider with children after a successful boot, otherwise no children.
 */
const DbProvider = ({
  children,
  bootOptions
}) => {
  const [booted, setBooted] = (0, _react.useState)(false);
  const queryClient = (0, _configure.getInternalQueryClient)();
  const bootPromise = (0, _react.useRef)(null);
  const previousAppState = (0, _react.useRef)(_reactNative.AppState.currentState);
  (0, _react.useEffect)(() => {
    let mounted = true;
    bootPromise.current ??= (0, _lifecycle.bootDb)(bootOptions);
    void bootPromise.current.then(() => {
      if (mounted) setBooted(true);
    });
    return () => {
      mounted = false;
    };
  }, []);
  (0, _react.useEffect)(() => {
    _reactQuery.focusManager.setFocused(_reactNative.AppState.currentState === 'active');
    const subscription = _reactNative.AppState.addEventListener('change', state => {
      const previousState = previousAppState.current;
      if (state === 'active') {
        _reactQuery.focusManager.setFocused(true);
        const resumeStaleTime = (0, _configure.getDbRuntimeConfig)().defaults.resumeStaleTime;
        if ((previousState === 'background' || previousState === 'inactive') && resumeStaleTime !== null) {
          void queryClient.invalidateQueries({
            predicate: query => (query.queryKey[0] === 'dbl' || query.queryKey[0] === 'dbl-fetch') && Date.now() - query.state.dataUpdatedAt > resumeStaleTime,
            refetchType: 'active'
          });
        }
      } else if (state === 'background') {
        _reactQuery.focusManager.setFocused(false);
        (0, _lifecycle.suspendDb)();
      }
      previousAppState.current = state;
    });
    return () => subscription.remove();
  }, []);
  return /*#__PURE__*/(0, _jsxRuntime.jsx)(_reactQuery.QueryClientProvider, {
    client: queryClient,
    children: booted ? children : null
  });
};
exports.DbProvider = DbProvider;
//# sourceMappingURL=DbProvider.js.map
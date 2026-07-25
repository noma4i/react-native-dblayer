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
var _diagnostics = require("../core/diagnostics.js");
var _jsxRuntime = require("react/jsx-runtime");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
const resolveResumeStaleTime = (query, fallback) => {
  const metaValue = query.meta?.resumeStaleTime;
  return typeof metaValue === 'number' || metaValue === null ? metaValue : fallback;
};
/**
 * Provide the library-owned query client and gate database consumers until boot completes.
 *
 * A successful boot renders `children`. A rejected boot throws the rejection reason during
 * render (on the next render after the rejection is observed), so it surfaces as an ordinary
 * React render error instead of leaving consumers stuck behind a permanent `null` - `bootDb` is
 * intentionally fail-loud (see its JSDoc in `lifecycle.ts`), and this provider must not swallow
 * that by only handling the resolved case.
 *
 * @param props Children plus optional boot-only lifecycle options.
 * @returns The internal query provider with children after a successful boot; throws in render if boot rejected.
 */
const DbProvider = ({
  children,
  bootOptions
}) => {
  const [booted, setBooted] = (0, _react.useState)(false);
  const [bootError, setBootError] = (0, _react.useState)(null);
  const queryClient = (0, _configure.getInternalQueryClient)();
  const bootPromise = (0, _react.useRef)(null);
  const previousAppState = (0, _react.useRef)(_reactNative.AppState.currentState);
  const resumeDrainGeneration = (0, _react.useRef)(0);
  if (bootError) throw bootError;
  (0, _react.useEffect)(() => {
    let mounted = true;
    bootPromise.current ??= (0, _lifecycle.bootDb)(bootOptions);
    void bootPromise.current.then(() => {
      if (mounted) setBooted(true);
    }).catch(error => {
      if (mounted) setBootError(error);
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
        if (previousState === 'background' || previousState === 'inactive') {
          const generation = ++resumeDrainGeneration.current;
          const resumedAt = Date.now();
          const predicate = query => {
            const queryResumeStaleTime = resolveResumeStaleTime(query, resumeStaleTime);
            return (query.queryKey[0] === 'dbl' || query.queryKey[0] === 'dbl-fetch') && queryResumeStaleTime !== null && resumedAt - query.state.dataUpdatedAt > queryResumeStaleTime;
          };
          const staleQueries = queryClient.getQueryCache().findAll({
            predicate
          });
          if (staleQueries.length > 0) {
            const staleQuerySet = new Set(staleQueries);
            const staleCandidate = query => staleQuerySet.has(query);
            const activeQueries = staleQueries.filter(query => query.getObserversCount() > 0);
            const chunkSize = (0, _configure.getDbRuntimeConfig)().defaults.resumeRefetch?.chunkSize ?? 4;
            void (async () => {
              let refetched = 0;
              try {
                await queryClient.invalidateQueries({
                  predicate: staleCandidate,
                  refetchType: 'none'
                });
                for (let index = 0; index < activeQueries.length; index += chunkSize) {
                  if (resumeDrainGeneration.current !== generation) return;
                  const chunk = activeQueries.slice(index, index + chunkSize);
                  refetched += chunk.length;
                  await Promise.allSettled(chunk.map(query => queryClient.refetchQueries({
                    queryKey: query.queryKey,
                    exact: true
                  })));
                }
              } finally {
                (0, _diagnostics.noteResumeDrain)(refetched);
              }
            })();
          }
        }
      } else if (state === 'background') {
        resumeDrainGeneration.current += 1;
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
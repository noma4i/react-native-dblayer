"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useObservedQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _react = require("react");
var _configure = require("../../dsl/configure.js");
/**
 * Wire one reader to one query: an observer rebuilt when the key or the runtime generation moves,
 * subscribed together with the key-local state the query runtime does not model (offline pause,
 * next-page flight, invalidation sequence).
 *
 * Both fetch surfaces read through this. A second copy of the wiring is how two readers of the same
 * query start reporting different things.
 *
 * @param key Bucket key identifying this reader's query.
 * @param options Observer options, rebuilt by the caller on every render.
 * @param optionsSignature Changes exactly when `options` carry a new instruction. Re-applying options
 * that did not change re-publishes the observer's result and shows the reader an extra frame, so a
 * surface whose options are fixed passes a constant here.
 * @param localState Key-local state subscribed alongside the observer; one instance per definition.
 * @returns The observer's current result, re-read on every notification from either source.
 */
const useObservedQuery = (key, options, optionsSignature, localState) => {
  const client = (0, _configure.getDbQueryClient)();
  const generation = (0, _configure.getRuntimeGeneration)();
  const observerRef = (0, _react.useRef)(null);
  if (observerRef.current === null || observerRef.current.key !== key || observerRef.current.generation !== generation) {
    observerRef.current = {
      key,
      generation,
      signature: optionsSignature,
      observer: new _reactQuery.QueryObserver(client, options)
    };
  }
  const observer = observerRef.current.observer;
  (0, _react.useEffect)(() => {
    const current = observerRef.current;
    if (current?.observer !== observer || current.signature === optionsSignature) return;
    current.signature = optionsSignature;
    observer.setOptions(options);
  }, [observer, options, optionsSignature]);
  const subscribe = (0, _react.useCallback)(onStoreChange => {
    const unsubscribeObserver = observer.subscribe(onStoreChange);
    const unsubscribeLocal = localState.subscribe(key, onStoreChange);
    return () => {
      unsubscribeObserver();
      unsubscribeLocal();
    };
  }, [key, observer, localState]);
  const getSnapshot = (0, _react.useCallback)(() => {
    const result = observer.getCurrentResult();
    // Two landings within one millisecond share dataUpdatedAt; the update count tells them apart.
    return `${result.fetchStatus}:${result.status}:${result.failureCount}:${result.dataUpdatedAt}:${observer.getCurrentQuery().state.dataUpdateCount}:${localState.version(key)}`;
  }, [key, observer, localState]);
  (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
  return observer.getCurrentResult();
};
exports.useObservedQuery = useObservedQuery;
//# sourceMappingURL=useObservedQuery.js.map
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineFetch = void 0;
var _reactQuery = require("@tanstack/react-query");
var _react = require("react");
var _loadingState = require("../queries/base/loadingState.js");
var _compileDbWhere = require("../core/compileDbWhere.js");
var _reset = require("../core/reset.js");
var _keyedLocalState = require("../core/fetch/keyedLocalState.js");
var _transport = require("../core/transport.js");
var _logger = require("../core/logger.js");
var _fetchReaderRegistry = require("../core/fetch/fetchReaderRegistry.js");
var _networkState = require("../core/fetch/networkState.js");
var _configure = require("./configure.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
let fetchHandleSequence = 0;

/**
 * Define an ephemeral coordinator-owned fetch with no model-store writes.
 *
 * @param config Document or fetcher plus selection and freshness policy.
 * @returns Coordinator-backed reactive and imperative fetch methods.
 */
const defineFetch = config => {
  const hasDocument = config.document !== undefined;
  const hasFetcher = config.fetcher !== undefined;
  if (hasDocument === hasFetcher) throw new Error('defineFetch requires exactly one of document or fetcher');
  const handleKey = `fetch:${config.key ?? (fetchHandleSequence += 1)}`;
  const isEmpty = config.isEmpty ?? (data => data == null || Array.isArray(data) && data.length === 0);
  const keyOf = input => (0, _compileDbWhere.buildScopeKey)(input);
  const queryKeyOf = key => [handleKey, key];
  /** Offline pause is the one flag react-query's state machine does not carry in our vocabulary. */
  const localState = (0, _keyedLocalState.createKeyedLocalState)({
    isPaused: false
  });
  (0, _reset.registerKeyedReset)(`fetch:${handleKey}`, () => localState.clear());
  const setPaused = (key, paused) => localState.set(key, {
    isPaused: paused
  });
  const staleTimeOf = key => {
    const data = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(key));
    const defaults = (0, _configure.getDbRuntimeConfig)().defaults;
    return data?.empty === true && (config.emptyStaleTime ?? defaults.emptyStaleTime) != null ? config.emptyStaleTime ?? defaults.emptyStaleTime : config.staleTime ?? defaults.staleTime ?? 0;
  };
  const execute = async input => {
    let data;
    try {
      data = config.fetcher ? await config.fetcher(input) : (0, _transport.responseDataOrThrow)(await (0, _transport.getDbTransport)().query({
        query: config.document,
        variables: config.vars?.(input) ?? {}
      }));
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        (0, _configure.getDbRuntimeConfig)().defaults.onSyncError?.(reported, {
          source: 'query',
          key: config.key
        });
      } catch (observerError) {
        (0, _logger.getDbLogger)().error('defineFetch onSyncError failed', {
          error: observerError
        });
      }
      throw error;
    }
    const selected = config.select(data);
    return {
      selected,
      empty: isEmpty(selected)
    };
  };
  const isFreshKey = key => {
    const client = (0, _configure.getDbQueryClient)();
    const state = client.getQueryState(queryKeyOf(key));
    return state?.dataUpdatedAt !== undefined && state.dataUpdatedAt > 0 && Date.now() - state.dataUpdatedAt <= staleTimeOf(key) && !state.isInvalidated;
  };
  const run = async (input, options) => {
    const key = keyOf(input);
    const client = (0, _configure.getDbQueryClient)();
    const queryKey = queryKeyOf(key);
    if (!(0, _networkState.isFetchNetworkOnline)()) {
      setPaused(key, true);
      return client.getQueryData(queryKey)?.selected;
    }
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({
      queryKey
    });
    setPaused(key, false);
    const generation = (0, _configure.getRuntimeGeneration)();
    try {
      const data = await client.fetchQuery({
        queryKey,
        queryFn: async () => {
          const result = await execute(input);
          if ((0, _configure.getRuntimeGeneration)() !== generation) return client.getQueryData(queryKey) ?? result;
          return result;
        },
        staleTime: options.restart ? 0 : staleTimeOf(key)
      });
      return data.selected;
    } catch (error) {
      // A newer restart cancelled this fetch; the superseding run now owns key state and outcome.
      if (error instanceof _reactQuery.CancelledError) return client.getQueryData(queryKey)?.selected;
      if (!(0, _networkState.isFetchNetworkOnline)()) {
        setPaused(key, true);
        return client.getQueryData(queryKey)?.selected;
      }
      if (options.propagateFailure) throw error instanceof Error ? error : new Error(String(error));
      return client.getQueryData(queryKey)?.selected;
    }
  };
  const fetch = async input => {
    const generationFence = (0, _runtimeGeneration.createGenerationFence)();
    const key = keyOf(input);
    const cached = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(key));
    if (cached !== undefined && isFreshKey(key)) return cached.selected;
    const selected = await run(input, {
      restart: false,
      propagateFailure: true
    });
    if (!generationFence.isCurrent()) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    return selected;
  };
  const remove = () => {
    (0, _configure.getDbQueryClient)().removeQueries({
      queryKey: [handleKey]
    });
    localState.clear();
  };
  const use = input => {
    const key = keyOf(input);
    const enabled = config.enabled?.(input) ?? true;
    const client = (0, _configure.getDbQueryClient)();
    const generation = (0, _configure.getRuntimeGeneration)();
    const observerRef = (0, _react.useRef)(null);
    if (observerRef.current === null || observerRef.current.key !== key || observerRef.current.generation !== generation) {
      observerRef.current = {
        key,
        generation,
        observer: new _reactQuery.QueryObserver(client, {
          queryKey: queryKeyOf(key),
          enabled: false,
          staleTime: Infinity
        })
      };
    }
    const observer = observerRef.current.observer;
    const subscribe = (0, _react.useCallback)(onStoreChange => {
      const unsubscribeObserver = observer.subscribe(onStoreChange);
      const unsubscribePaused = localState.subscribe(key, onStoreChange);
      return () => {
        unsubscribeObserver();
        unsubscribePaused();
      };
    }, [key, observer]);
    const getSnapshot = (0, _react.useCallback)(() => {
      const result = observer.getCurrentResult();
      return `${result.fetchStatus}:${result.status}:${result.failureCount}:${result.dataUpdatedAt}:${localState.version(key)}`;
    }, [key, observer]);
    (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
    const result = observer.getCurrentResult();
    const state = {
      isFetching: result.fetchStatus === 'fetching',
      isFetched: (0, _loadingState.isFetchedResult)(result),
      isPaused: localState.get(key).isPaused,
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null
    };
    const mountedKey = (0, _react.useRef)(null);
    (0, _react.useEffect)(() => {
      if (!enabled) return;
      const queryKey = queryKeyOf(key);
      const resumeWindow = () => config.resumeStaleTime === undefined ? (0, _configure.getDbRuntimeConfig)().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = () => {
        const window = resumeWindow();
        const queryState = client.getQueryState(queryKey);
        const fresh = queryState?.dataUpdatedAt !== undefined && queryState.dataUpdatedAt > 0 && Date.now() - queryState.dataUpdatedAt <= window && !queryState.isInvalidated;
        if (window === null || fresh) return false;
        void client.invalidateQueries({
          queryKey,
          refetchType: 'none'
        });
        return true;
      };
      const release = (0, _fetchReaderRegistry.registerActiveFetchReaders)({
        queryKey,
        markResumeStale,
        refetch: async () => {
          await run(input, {
            restart: false
          });
        }
      });
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const canRefetch = !firstMount || !state.isFetched || (0, _configure.getDbRuntimeConfig)().defaults.refetchOnMount !== false;
      if (firstMount && canRefetch && !isFreshKey(key) && !state.isFetching) void run(input, {
        restart: false
      }).catch(() => {});
      const unsubscribeOnline = (0, _networkState.subscribeFetchNetwork)(() => {
        if ((0, _networkState.isFetchNetworkOnline)() && !isFreshKey(key)) void run(input, {
          restart: false
        }).catch(() => {});
      });
      return () => {
        unsubscribeOnline();
        release();
      };
    }, [client, enabled, input, key, state.isFetched, state.isFetching]);
    const data = result.data?.selected;
    const hasData = data !== undefined && !isEmpty(data);
    const phaseInput = {
      isInactive: !enabled && !hasData,
      isFetching: state.isFetching,
      committedRowsDied: false,
      isPaused: state.isPaused,
      retryAttempt: state.retryAttempt,
      hasData,
      isRefreshing: state.isFetching && hasData,
      isFetchingNextPage: false,
      isError: state.error !== null,
      hasFetchedData: state.isFetched
    };
    const loadingState = (0, _loadingState.computeLoadingState)((0, _loadingState.computePhase)(phaseInput), phaseInput);
    return (0, _react.useMemo)(() => ({
      data,
      loadingState,
      error: state.error,
      refetch: () => void run(input, {
        restart: true
      })
    }), [data, loadingState, state.error, input]);
  };
  return {
    use,
    fetch,
    remove
  };
};
exports.defineFetch = defineFetch;
//# sourceMappingURL=defineFetch.js.map
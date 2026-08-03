import { QueryObserver } from '@tanstack/react-query';
import type { QueryKey, QueryObserverOptions, QueryObserverResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getDbQueryClient, getRuntimeGeneration } from '../../dsl/configure';
import type { KeyedLocalState } from '../../types';

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
export const useObservedQuery = <TData>(
  key: string,
  options: QueryObserverOptions<TData, Error, TData, TData, QueryKey>,
  optionsSignature: string,
  localState: KeyedLocalState<unknown>
): QueryObserverResult<TData, Error> => {
  const client = getDbQueryClient();
  const generation = getRuntimeGeneration();
  const observerRef = useRef<{ key: string; generation: number; signature: string; observer: QueryObserver<TData, Error, TData, TData, QueryKey> } | null>(null);
  if (observerRef.current === null || observerRef.current.key !== key || observerRef.current.generation !== generation) {
    observerRef.current = { key, generation, signature: optionsSignature, observer: new QueryObserver<TData, Error, TData, TData, QueryKey>(client, options) };
  }
  const observer = observerRef.current.observer;
  useEffect(() => {
    const current = observerRef.current;
    if (current?.observer !== observer || current.signature === optionsSignature) return;
    current.signature = optionsSignature;
    observer.setOptions(options);
  }, [observer, options, optionsSignature]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribeObserver = observer.subscribe(onStoreChange);
      const unsubscribeLocal = localState.subscribe(key, onStoreChange);
      return () => {
        unsubscribeObserver();
        unsubscribeLocal();
      };
    },
    [key, observer, localState]
  );
  const getSnapshot = useCallback(() => {
    const result = observer.getCurrentResult();
    return `${result.fetchStatus}:${result.status}:${result.failureCount}:${result.dataUpdatedAt}:${localState.version(key)}`;
  }, [key, observer, localState]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return observer.getCurrentResult();
};

import type { QueryKey, QueryObserverOptions, QueryObserverResult } from '@tanstack/react-query';
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
export declare const useObservedQuery: <TData>(key: string, options: QueryObserverOptions<TData, Error, TData, TData, QueryKey>, optionsSignature: string, localState: KeyedLocalState<unknown>) => QueryObserverResult<TData, Error>;
//# sourceMappingURL=useObservedQuery.d.ts.map
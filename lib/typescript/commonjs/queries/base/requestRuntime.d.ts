import type { DbRequestInfiniteConfig, DbRequestSingleConfig } from '../../types';
/**
 * Execute a single request config outside React.
 * @param config Same config accepted by `useDbSingleRequest`.
 * @returns Selected or mapped result, or null when `read` owns the reactive data.
 */
export declare const executeDbSingleRequest: <TResponse, TResult = unknown, TSelected = unknown>(config: DbRequestSingleConfig<TResponse, TResult, TSelected>) => Promise<TResult>;
/**
 * Execute one page of an infinite request config outside React.
 * @param config Same config accepted by `useDbInfiniteRequest`.
 * @param pageParam Optional cursor for the page to load.
 * @returns Raw page response data.
 */
export declare const executeDbInfiniteRequest: <TResponse, TNode>(config: DbRequestInfiniteConfig<TResponse, TNode>, pageParam?: string) => Promise<TResponse>;
//# sourceMappingURL=requestRuntime.d.ts.map
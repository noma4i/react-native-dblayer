import type { BaseQueryCollection, DbRequestInfiniteConfig, DbRequestSingleConfig, DbRequestSingleData, InfiniteSyncContractResolverContext, SyncContract } from '../../types';
type InfiniteRequestPatchState = {
    nextGlobalIndex: number;
};
/**
 * Alternate infinite-request resolver that merges both the initial and every subsequently loaded page
 * into the target scope, instead of replacing the scope on the initial page.
 * Pass this explicitly via `resolveSyncContract` when a request's initial page should not clear rows
 * already present in the scope (e.g. a paginated thread read alongside other writers into the same scope).
 */
export declare const mergeInitialSyncContract: <TNode>({ pageParam, scope, snapshotSeq }: InfiniteSyncContractResolverContext<TNode>) => SyncContract;
/**
 * Default infinite-request resolver: replace the target scope on the initial page, then merge every
 * subsequently loaded page into it. `runDbInfiniteQueryDirect`/`useDbInfiniteRequest` use this whenever
 * a config omits `resolveSyncContract` - pass it explicitly only where a call site needs to name the
 * default resolution (e.g. composing it with other resolver logic).
 */
export declare const replaceInitialSyncContract: <TNode>({ pageParam, scope, snapshotSeq }: InfiniteSyncContractResolverContext<TNode>) => SyncContract;
/**
 * Run a single request config outside React.
 * @param config Same config accepted by `useDbSingleRequest`; `key`, `enabled`, `staleTime`, `gcTime`, and `refetchOnMount` are hook-only.
 * @returns Selected or mapped result, or null when `read` owns the reactive data.
 */
export declare const runDbQueryDirect: <TResponse, TResult = unknown, TSelected = unknown, TVariables = Record<string, unknown>, TRead extends BaseQueryCollection | undefined = BaseQueryCollection | undefined>(config: DbRequestSingleConfig<TResponse, TResult, TSelected, TVariables, TRead>) => Promise<DbRequestSingleData<TResult, TSelected, TRead>>;
/**
 * Run one page of an infinite request config outside React.
 * @param config Same config accepted by `useDbInfiniteRequest`.
 * @param pageParam Optional cursor for the page to load.
 * @returns Raw page response data.
 */
export declare const runDbInfiniteQueryDirect: <TResponse, TNode, TVariables = Record<string, unknown>>(config: DbRequestInfiniteConfig<TResponse, TNode, TVariables>, pageParam?: string, patchState?: InfiniteRequestPatchState) => Promise<TResponse>;
export {};
//# sourceMappingURL=requestRuntime.d.ts.map
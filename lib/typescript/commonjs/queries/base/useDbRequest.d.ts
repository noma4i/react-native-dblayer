import type { BaseQueryResult, DbRequestInfiniteConfig, DbRequestSingleConfig, InfiniteQueryResult } from '../../types';
/**
 * React hook that runs one GraphQL query, syncs selected data, and returns a reactive read.
 * @param config Query, selection, sync, extract, read, and React Query options.
 * @returns React Query result plus `loadingState`.
 *
 * @example
 * const { data, loadingState } = useDbSingleRequest({
 *   key: ['user', id],
 *   query: USER_QUERY,
 *   vars: { id },
 *   select: data => data.user,
 *   sync: { model: UserModel, contract: 'user' },
 *   read: { model: UserModel, id }
 * });
 */
export declare const useDbSingleRequest: <TResponse, TResult = unknown, TSelected = unknown>(config: DbRequestSingleConfig<TResponse, TResult, TSelected>) => BaseQueryResult<TResult>;
/**
 * React hook that runs cursor-paginated GraphQL queries and syncs page nodes.
 * @param config Paginated query, connection selector, collection binding, and pagination options.
 * @returns Infinite query result with reactive `items`, loading state, and pagination helpers.
 *
 * @example
 * const feed = useDbInfiniteRequest({
 *   key: ['feed'],
 *   query: FEED_QUERY,
 *   selectPage: data => data.feed,
 *   read: feedCollectionBinding
 * });
 */
export declare const useDbInfiniteRequest: <TResponse, TNode>(config: DbRequestInfiniteConfig<TResponse, TNode>) => InfiniteQueryResult<TNode>;
//# sourceMappingURL=useDbRequest.d.ts.map
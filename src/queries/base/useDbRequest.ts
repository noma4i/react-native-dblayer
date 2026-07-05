import { useMemo, useRef } from 'react';
import type { BaseQueryConfig, BaseQueryResult, DbRequestInfiniteConfig, DbRequestSingleConfig, InfiniteQueryConfig, InfiniteQueryResult } from '../../types';
import { stableSerialize } from '../../core/serialize';
import { makePageExtractor } from './extractPage';
import { executeDbInfiniteRequest, executeDbSingleRequest } from './requestRuntime';
import { useBaseInfiniteQuery } from './useBaseInfiniteQuery';
import { useBaseQuery } from './useBaseQuery';

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
export const useDbSingleRequest = <TResponse, TResult = unknown, TSelected = unknown>(config: DbRequestSingleConfig<TResponse, TResult, TSelected>): BaseQueryResult<TResult> => {
  const configRef = useRef(config);
  configRef.current = config;
  const keySignature = stableSerialize(config.key);
  const read = config.read;
  const readRef = useRef(read);
  readRef.current = read;
  const collectionModel = read?.model;
  const collectionHasId = !!read && 'id' in read;
  const collectionId = read && 'id' in read ? read.id : undefined;
  const collection = useMemo<BaseQueryConfig<TResult>['collection']>(() => readRef.current, [collectionHasId, collectionId, collectionModel]);
  const baseConfig = useMemo(
    (): BaseQueryConfig<TResult> => ({
      queryKey: config.key,
      queryFn: () => executeDbSingleRequest(configRef.current),
      collection,
      inactive: config.inactive,
      enabled: config.enabled,
      staleTime: config.staleTime,
      gcTime: config.gcTime,
      refetchOnMount: config.refetchOnMount
    }),
    [collection, config.enabled, config.gcTime, config.inactive, keySignature, config.query, config.refetchOnMount, config.staleTime]
  );

  return useBaseQuery<TResult>(baseConfig);
};

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
export const useDbInfiniteRequest = <TResponse, TNode>(config: DbRequestInfiniteConfig<TResponse, TNode>): InfiniteQueryResult<TNode> => {
  const configRef = useRef(config);
  configRef.current = config;
  const keySignature = stableSerialize(config.key);

  const baseConfig = useMemo<InfiniteQueryConfig<TResponse, TNode>>(() => {
    const extract = makePageExtractor<TResponse, TNode>(data => configRef.current.selectPage(data));

    return {
      queryKey: config.key,
      queryFn: ({ pageParam }: { pageParam?: string }) => executeDbInfiniteRequest(configRef.current, pageParam),
      extract,
      inactive: config.inactive,
      ...(config.getCursor ? { getCursor: data => configRef.current.getCursor!(data) } : {}),
      enabled: config.enabled,
      staleTime: config.staleTime,
      gcTime: config.gcTime,
      direction: config.direction,
      getFilter: () => configRef.current.filter?.(),
      getCurrentUserId: () => configRef.current.currentUserId?.(),
      ...(config.resolveSyncContract ? { resolveSyncContract: context => configRef.current.resolveSyncContract!(context) } : {}),
      collection: config.read,
      readMode: config.readMode
    };
  }, [config.direction, config.enabled, config.gcTime, config.getCursor, config.inactive, keySignature, config.query, config.read, config.readMode, config.resolveSyncContract, config.staleTime]);

  return useBaseInfiniteQuery<TResponse, TNode>(baseConfig);
};

import { useMemo, useRef } from 'react';
import type { BaseQueryConfig, BaseQueryResult, CollectionModel, DbRequestInfiniteConfig, DbRequestSingleConfig, InfiniteQueryConfig, InfiniteQueryResult } from '../../types';
import { deriveDbKey } from '../../core/deriveDbKey';
import { stableSerialize } from '../../core/serialize';
import { makePageExtractor } from './extractPage';
import { executeDbInfiniteRequest, executeDbSingleRequest } from './requestRuntime';
import { buildModelFilter, resolveRequestFilter } from './shared';
import { useBaseInfiniteQuery } from './useBaseInfiniteQuery';
import { useBaseQuery } from './useBaseQuery';

/**
 * Derive the base model-backed key portion, before the `vars` suffix is appended.
 * Throws when neither `read` nor `sync.model` can anchor a key.
 */
const resolveSingleRequestBaseKey = (config: DbRequestSingleConfig<unknown, unknown, unknown>): readonly unknown[] => {
  if (config.read) {
    return 'id' in config.read ? deriveDbKey(config.read.model as CollectionModel<any, any>, config.read.id != null ? { id: config.read.id } : undefined) : deriveDbKey(config.read.model as CollectionModel<any, any>);
  }
  if (config.sync && typeof config.sync !== 'function') {
    return deriveDbKey(config.sync.model as CollectionModel<any, any>);
  }
  throw new Error('useDbSingleRequest requires `key` unless `read` or `sync.model` can derive one.');
};

/**
 * Derive the React Query key for a single-request config.
 *
 * An explicit `config.key` always wins unchanged. Otherwise the key is derived from `read`/`sync.model`
 * (see `resolveSingleRequestBaseKey`) with a stable-serialized `config.vars` suffix appended when `vars`
 * is present, so two configs reading/syncing the same model with different `vars` do not collide on one
 * cache entry. The suffix is appended (never inserted before the model/scope segments), so
 * `invalidateModel(model, scope)` - which invalidates by key prefix - still matches every `vars` variant.
 */
const resolveSingleRequestKey = (config: DbRequestSingleConfig<unknown, unknown, unknown>): readonly unknown[] => {
  if (config.key) return config.key;

  const baseKey = resolveSingleRequestBaseKey(config);
  return config.vars !== undefined ? [...baseKey, stableSerialize(config.vars)] : baseKey;
};

const resolveInfiniteRequestKey = (config: DbRequestInfiniteConfig<unknown, unknown>): readonly unknown[] => {
  if (config.key) return config.key;
  const model = config.read._dbModel;
  if (!model) {
    throw new Error('useDbInfiniteRequest requires `key` unless `read` is created by createCollectionBinding().');
  }
  const modelFilter = buildModelFilter(resolveRequestFilter(config.filter, config.scope), config.currentUserId?.());
  return deriveDbKey(model as CollectionModel<any, any>, config.read._dbScope?.(modelFilter));
};

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
export const useDbSingleRequest = <TResponse, TResult = unknown, TSelected = unknown, TVariables = Record<string, unknown>>(
  config: DbRequestSingleConfig<TResponse, TResult, TSelected, TVariables>
): BaseQueryResult<TResult> => {
  const configRef = useRef(config);
  configRef.current = config;
  const queryKey = resolveSingleRequestKey(config as DbRequestSingleConfig<unknown, unknown, unknown>);
  const keySignature = stableSerialize(queryKey);
  const read = config.read;
  const readRef = useRef(read);
  readRef.current = read;
  const collectionModel = read?.model;
  const collectionHasId = !!read && 'id' in read;
  const collectionId = read && 'id' in read ? read.id : undefined;
  const collection = useMemo<BaseQueryConfig<TResult>['collection']>(() => readRef.current, [collectionHasId, collectionId, collectionModel]);
  const baseConfig = useMemo(
    (): BaseQueryConfig<TResult> => ({
      queryKey,
      queryFn: () => executeDbSingleRequest(configRef.current),
      collection,
      inactive: config.inactive,
      enabled: config.enabled,
      staleTime: config.staleTime,
      emptyStaleTime: config.emptyStaleTime,
      gcTime: config.gcTime,
      refetchOnMount: config.refetchOnMount
    }),
    [collection, config.emptyStaleTime, config.enabled, config.gcTime, config.inactive, keySignature, config.query, config.refetchOnMount, config.staleTime]
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
export const useDbInfiniteRequest = <TResponse, TNode, TVariables = Record<string, unknown>>(
  config: DbRequestInfiniteConfig<TResponse, TNode, TVariables>
): InfiniteQueryResult<TNode> => {
  const configRef = useRef(config);
  configRef.current = config;
  const patchStateRef = useRef({ nextGlobalIndex: 0 });
  const queryKey = resolveInfiniteRequestKey(config as DbRequestInfiniteConfig<unknown, unknown>);
  const keySignature = stableSerialize(queryKey);

  const baseConfig = useMemo<InfiniteQueryConfig<TResponse, TNode>>(() => {
    const extract = makePageExtractor<TResponse, TNode>(data => configRef.current.selectPage(data));

    return {
      queryKey,
      queryFn: ({ pageParam }: { pageParam?: string }) => executeDbInfiniteRequest(configRef.current, pageParam, patchStateRef.current),
      extract,
      inactive: config.inactive,
      ...(config.getCursor ? { getCursor: data => configRef.current.getCursor!(data) } : {}),
      enabled: config.enabled,
      staleTime: config.staleTime,
      emptyStaleTime: config.emptyStaleTime,
      gcTime: config.gcTime,
      refetchOnMount: config.refetchOnMount,
      direction: config.direction,
      getFilter: () => resolveRequestFilter(configRef.current.filter, configRef.current.scope),
      getCurrentUserId: () => configRef.current.currentUserId?.(),
      ...(config.resolveSyncContract ? { resolveSyncContract: context => configRef.current.resolveSyncContract!(context) } : {}),
      collection: config.read,
      readMode: config.readMode
    };
  }, [
    config.direction,
    config.emptyStaleTime,
    config.enabled,
    config.gcTime,
    config.getCursor,
    config.inactive,
    keySignature,
    config.query,
    config.read,
    config.readMode,
    config.refetchOnMount,
    config.resolveSyncContract,
    config.scope,
    config.staleTime
  ]);

  return useBaseInfiniteQuery<TResponse, TNode>(baseConfig);
};

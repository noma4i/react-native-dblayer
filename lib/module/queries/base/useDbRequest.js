"use strict";

import { useMemo, useRef } from 'react';
import { deriveDbKey } from "../../core/deriveDbKey.js";
import { stableSerialize } from "../../core/serialize.js";
import { makePageExtractor } from "./extractPage.js";
import { runDbInfiniteQueryDirect, runDbQueryDirect } from "./requestRuntime.js";
import { buildModelFilter, resolveRequestFilter } from "./shared.js";
import { useBaseInfiniteQuery } from "./useBaseInfiniteQuery.js";
import { useBaseQuery } from "./useBaseQuery.js";

/**
 * Derive the base model-backed key portion, before the `vars` suffix is appended.
 * Throws when neither `read` nor `sync.model` can anchor a key.
 */
const resolveSingleRequestBaseKey = config => {
  if (config.read) {
    return 'id' in config.read ? deriveDbKey(config.read.model, config.read.id != null ? {
      id: config.read.id
    } : undefined) : deriveDbKey(config.read.model);
  }
  if (config.sync && typeof config.sync !== 'function') {
    return deriveDbKey(config.sync.model);
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
const resolveSingleRequestKey = config => {
  if (config.key) return config.key;
  const baseKey = resolveSingleRequestBaseKey(config);
  return config.vars !== undefined ? [...baseKey, stableSerialize(config.vars)] : baseKey;
};
const resolveInfiniteRequestKey = config => {
  if (config.key) return config.key;
  const model = config.read._dbModel;
  if (!model) {
    throw new Error('useDbInfiniteRequest requires `key` unless `read` is created by createCollectionBinding().');
  }
  const modelFilter = buildModelFilter(resolveRequestFilter(config.filter, config.scope), config.currentUserId?.());
  return deriveDbKey(model, config.read._dbScope?.(modelFilter));
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
export const useDbSingleRequest = config => {
  const configRef = useRef(config);
  configRef.current = config;
  const queryKey = resolveSingleRequestKey(config);
  const keySignature = stableSerialize(queryKey);
  const read = config.read;
  const readRef = useRef(read);
  readRef.current = read;
  const collectionModel = read?.model;
  const collectionHasId = !!read && 'id' in read;
  const collectionId = read && 'id' in read ? read.id : undefined;
  const collection = useMemo(() => readRef.current, [collectionHasId, collectionId, collectionModel]);
  const baseConfig = useMemo(() => ({
    queryKey,
    queryFn: () => runDbQueryDirect(configRef.current),
    collection,
    enabled: config.enabled,
    staleTime: config.staleTime,
    emptyStaleTime: config.emptyStaleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  }), [collection, config.emptyStaleTime, config.enabled, config.gcTime, keySignature, config.query, config.refetchOnMount, config.staleTime]);
  return useBaseQuery(baseConfig);
};

/**
 * React hook that runs cursor-paginated GraphQL queries and syncs page nodes.
 * @param config Paginated query, connection selector, collection binding, and pagination options.
 * @returns Infinite query result with reactive `data`, loading state, and pagination helpers.
 *
 * @example
 * const feed = useDbInfiniteRequest({
 *   key: ['feed'],
 *   query: FEED_QUERY,
 *   selectPage: data => data.feed,
 *   read: feedCollectionBinding
 * });
 */
export const useDbInfiniteRequest = config => {
  const configRef = useRef(config);
  configRef.current = config;
  const patchStateRef = useRef({
    nextGlobalIndex: 0
  });
  const queryKey = resolveInfiniteRequestKey(config);
  const keySignature = stableSerialize(queryKey);
  const baseConfig = useMemo(() => {
    const extract = makePageExtractor(data => configRef.current.selectPage(data));
    return {
      queryKey,
      queryFn: ({
        pageParam
      }) => runDbInfiniteQueryDirect(configRef.current, pageParam, patchStateRef.current),
      extract,
      ...(config.getCursor ? {
        getCursor: data => configRef.current.getCursor(data)
      } : {}),
      enabled: config.enabled,
      staleTime: config.staleTime,
      emptyStaleTime: config.emptyStaleTime,
      gcTime: config.gcTime,
      refetchOnMount: config.refetchOnMount,
      direction: config.direction,
      getFilter: () => resolveRequestFilter(configRef.current.filter, configRef.current.scope),
      getCurrentUserId: () => configRef.current.currentUserId?.(),
      ...(config.resolveSyncContract ? {
        resolveSyncContract: context => configRef.current.resolveSyncContract(context)
      } : {}),
      collection: config.read,
      readMode: config.readMode
    };
  }, [config.direction, config.emptyStaleTime, config.enabled, config.gcTime, config.getCursor, keySignature, config.query, config.read, config.readMode, config.refetchOnMount, config.resolveSyncContract, config.scope, config.staleTime]);
  return useBaseInfiniteQuery(baseConfig);
};
//# sourceMappingURL=useDbRequest.js.map
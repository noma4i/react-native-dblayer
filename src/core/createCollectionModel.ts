import { createTransaction, count as dbCount, eq, inArray } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { createSchema } from '../schema/schema';
import type {
  CollectionFetchState,
  CollectionModel,
  CreateCollectionModelFieldsConfig,
  CreateCollectionModelNormalizeConfig,
  DbReadOptions,
  DbWhere,
  MergeResult,
  ModelFieldSpecs,
  ModelStoredFromFields,
  PersistentMutationTransaction,
  ReplaceResult,
  SyncContract
} from '../types';
import { toQueryValue } from '../utils/typeBoundary';
import { applyDbReadOptionsToQuery, applyDbReadOptionsToRows, applyDbWhereToQuery, createDbWhereSignature, matchesDbWhere, normalizeDbCondition } from './compileDbWhere';
import { createMerge } from './createMerge';
import { createPatchCrud } from './createPatchCrud';
import { createReplace } from './createReplace';
import { clearCollectionFetchState, clearCollectionFetchStates, getCollectionFetchState, registerCollectionFetchStateCache, setCollectionFetchState } from './freshnessStorage';
import { getDbModelDefaults } from './modelDefaults';
import { registerModel } from './modelRegistry';
import { isInManagedMutationBatch, registerModelRuntimeReset } from './registry';
import { stableSerialize } from './serialize';
import { runSideloads, withApplyingModel } from './sideload';

const EMPTY: readonly unknown[] = [];
const GROUP_ALL = 1 as const;
const ROOT_FETCH_SCOPE = '__root__';

const buildFetchScope = <TStored>(filter?: Partial<TStored>): string => {
  const normalized = normalizeDbCondition(filter);
  if (!normalized) return ROOT_FETCH_SCOPE;
  return stableSerialize(normalized);
};

const createFreshnessTracker = <TStored>(collectionId: string | null, staleTime: number) => {
  const fetchStateCache = new Map<string, CollectionFetchState | null>();

  if (collectionId) {
    fetchStateCache.set(ROOT_FETCH_SCOPE, getCollectionFetchState(collectionId));
    registerCollectionFetchStateCache(collectionId, scopeKey => {
      fetchStateCache.delete(scopeKey ?? ROOT_FETCH_SCOPE);
    });
  }

  const getFetchState = (filter?: Partial<TStored>): CollectionFetchState | null => {
    const scope = buildFetchScope(filter);
    if (fetchStateCache.has(scope)) {
      return fetchStateCache.get(scope) ?? null;
    }

    const nextState = collectionId ? getCollectionFetchState(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope) : null;
    fetchStateCache.set(scope, nextState);
    return nextState;
  };

  const markFetched = (filter?: Partial<TStored>, state?: Omit<CollectionFetchState, 'touchedAt'>): void => {
    const scope = buildFetchScope(filter);
    const nextState: CollectionFetchState = {
      touchedAt: Date.now(),
      empty: state?.empty === true,
      ...(state?.pageInfo ? { pageInfo: state.pageInfo } : {})
    };
    fetchStateCache.set(scope, nextState);
    if (collectionId) {
      setCollectionFetchState(collectionId, nextState, scope === ROOT_FETCH_SCOPE ? undefined : scope);
    }
  };

  const touch = (): void => {
    markFetched(undefined, { empty: false });
  };

  const clearFetchState = (filter?: Partial<TStored>): void => {
    const scope = buildFetchScope(filter);
    fetchStateCache.delete(scope);
    if (collectionId) {
      clearCollectionFetchState(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope);
    }
  };

  const isStale = (filter?: Partial<TStored>, maxAgeMs = staleTime): boolean => {
    const fetchState = getFetchState(filter);
    if (!fetchState) return true;
    if (maxAgeMs <= 0) return true;
    return Date.now() - fetchState.touchedAt > maxAgeMs;
  };

  const shouldSkipInitialFetch = (hasItems: (filter?: Partial<TStored>) => boolean, filter?: Partial<TStored>, maxAgeMs = staleTime): boolean => {
    const fetchState = getFetchState(filter);
    const hasKnownEmpty = fetchState?.empty === true;
    return (hasItems(filter) || hasKnownEmpty) && !isStale(filter, maxAgeMs);
  };

  const clear = (): void => {
    fetchStateCache.clear();
    if (collectionId) {
      clearCollectionFetchStates(collectionId);
    }
  };

  const reset = (): void => {
    fetchStateCache.clear();
  };

  return { getFetchState, markFetched, touch, clearFetchState, isStale, shouldSkipInitialFetch, clear, reset };
};

type RuntimeModelConfig = CreateCollectionModelNormalizeConfig<any, any, any> | CreateCollectionModelFieldsConfig<any, any>;

const hasFieldsConfig = (config: RuntimeModelConfig): config is CreateCollectionModelFieldsConfig<ModelFieldSpecs, Record<string, unknown>> => 'fields' in config;

const assertValidFieldsConfig = (name: string, fields: ModelFieldSpecs): void => {
  if (Object.prototype.hasOwnProperty.call(fields, 'id')) {
    throw new Error(`[${name}] fields cannot include "id". Use rowId or input.id for the row id.`);
  }
};

const resolveNormalize = (config: RuntimeModelConfig): ((item: unknown) => ({ id: string } & Record<string, unknown>) | null) => {
  if (!hasFieldsConfig(config)) return config.normalize as (item: unknown) => ({ id: string } & Record<string, unknown>) | null;

  assertValidFieldsConfig(config.name, config.fields);
  return createSchema({
    fields: config.fields,
    rowId: config.rowId,
    guard: config.guard
  }).normalize;
};

/** Create a collection model from a persistent collection and normalizer. */
export function createCollectionModel<TInput, TStored extends { id: string; updatedAt?: string | null }, TExt extends Record<string, unknown> = {}>(
  config: CreateCollectionModelNormalizeConfig<TInput, TStored, TExt>
): CollectionModel<TInput, TStored> & TExt;
export function createCollectionModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}>(
  config: CreateCollectionModelFieldsConfig<TFields, TExt>
): CollectionModel<unknown, ModelStoredFromFields<TFields>> & TExt;
export function createCollectionModel(config: RuntimeModelConfig): any {
  const { collection: rawCollection, staleTime = 0 } = config;
  const normalize = resolveNormalize(config);
  const collectionId = typeof rawCollection.id === 'string' && rawCollection.id.length > 0 ? rawCollection.id : null;
  const freshness = createFreshnessTracker<any>(collectionId, staleTime);
  let resetMergeState = (): void => {};

  const merge = createMerge<any, any>({
    collection: rawCollection,
    normalize,
    shouldOverwrite: config.merge?.shouldOverwrite,
    dedupeWindowMs: config.merge?.dedupeWindowMs,
    resolveDedupeWindowMs: () => getDbModelDefaults().merge?.dedupeWindowMs,
    registerReset: reset => {
      resetMergeState = reset;
    }
  });

  const replace = createReplace<any, any>({
    collection: rawCollection,
    normalize,
    shouldOverwrite: config.replace?.shouldOverwrite
  });

  const crud = createPatchCrud<any>({ collection: rawCollection });

  const tanstackCollection = rawCollection._collection;
  const acceptMutations = rawCollection.acceptMutations.bind(rawCollection);

  const withTransaction = (fn: () => void): void => {
    if (isInManagedMutationBatch()) {
      fn();
      return;
    }
    const tx = createTransaction({
      mutationFn: ({ transaction }) => {
        acceptMutations(transaction as PersistentMutationTransaction);
        return Promise.resolve();
      }
    });
    tx.mutate(fn);
  };

  const getSnapshotWhere = (filter: DbWhere<any>): any[] => {
    const results: any[] = [];
    for (const item of rawCollection.values()) {
      if (matchesDbWhere(item, filter)) results.push(item);
    }
    return results;
  };

  const getSnapshotFirstWhere = (filter?: DbWhere<any>, options?: Pick<DbReadOptions<any>, 'orderBy'>): any | undefined => {
    const rows = filter ? getSnapshotWhere(filter) : Array.from(rawCollection.values());
    return applyDbReadOptionsToRows(rows, options)[0];
  };

  const hasCached = (filter?: Partial<any>): boolean => {
    if (filter && Object.keys(normalizeDbCondition(filter) ?? {}).length > 0) {
      return getSnapshotFirstWhere(filter) !== undefined;
    }
    if ('size' in rawCollection && typeof rawCollection.size === 'number') {
      return rawCollection.size > 0;
    }
    for (const _ of rawCollection.keys()) return true;
    return false;
  };

  const shouldSkipInitialFetch = (filter?: Partial<any>, maxAgeMs?: number): boolean => freshness.shouldSkipInitialFetch(hasCached, filter, maxAgeMs);

  const clearScope = (): void => {
    const ids: string[] = [];
    for (const id of rawCollection.keys()) ids.push(String(id));
    withTransaction(() => {
      for (const id of ids) {
        rawCollection.delete(id);
      }
    });
    freshness.clear();
  };

  const destroyMany = (ids: string[]): number => {
    let deleted = 0;
    withTransaction(() => {
      for (const id of ids) {
        if (!rawCollection.has(id)) continue;
        rawCollection.delete(id);
        deleted += 1;
      }
    });
    return deleted;
  };

  const destroyWhere = (filter: Partial<any>): number => {
    const normalized = normalizeDbCondition(filter);
    if (!normalized) {
      throw new Error(`[${config.name}] destroyWhere requires a non-empty filter. Use clearScope() for full collection clears.`);
    }
    return destroyMany(getSnapshotWhere(normalized).map(item => item.id));
  };

  const applyServerData = (items: unknown[], contract: SyncContract): MergeResult | ReplaceResult => {
    if (contract.mode === 'replace' && contract.scope !== undefined && contract._scopeFilter === undefined) {
      throw new Error(`[${config.name}] scoped replace requires _scopeFilter. Use createCollectionBinding(...).applyServerData() or provide contract._scopeFilter explicitly.`);
    }

    let result: MergeResult | ReplaceResult = { merged: 0 };
    withApplyingModel(config.name, () => {
      withTransaction(() => {
        runSideloads(config.sideload, items, contract);
        if (contract.mode === 'replace') {
          const scopeFilter = contract._scopeFilter as ((item: any) => boolean) | undefined;
          result = replace(items, scopeFilter);
        } else {
          result = merge(items);
        }
      });
    });

    if (contract._freshnessFilter) {
      freshness.markFetched(contract._freshnessFilter as Partial<any>, { empty: items.length === 0 });
    } else if (contract.scope === undefined && contract._scopeFilter === undefined) {
      freshness.touch();
    }

    return result;
  };

  const useFind = (id: string | undefined | null): any | undefined => {
    const { data } = useLiveQuery(
      q =>
        id
          ? q
              .from({ items: tanstackCollection })
              .where(({ items }) => eq(toQueryValue((items as Record<string, unknown>).id), id))
              .findOne()
          : undefined,
      [id]
    );
    return data as unknown as any | undefined;
  };

  const useAll = (): any[] => {
    const { data } = useLiveQuery(q => {
      let query = q.from({ items: tanstackCollection });
      const defaultSort = config.defaultSort;
      if (defaultSort) {
        query = query.orderBy(({ items }) => toQueryValue((items as Record<string, unknown>)[defaultSort.field]), defaultSort.direction);
      }
      return query;
    });

    return (data ?? EMPTY) as any[];
  };

  const useWhere = (filter: DbWhere<any>, options?: DbReadOptions<any>): any[] => {
    const signature = createDbWhereSignature(filter, options);
    const { data } = useLiveQuery(
      q => applyDbReadOptionsToQuery(applyDbWhereToQuery(q.from({ items: tanstackCollection }) as any, filter), options),
      [signature]
    );

    return (data ?? EMPTY) as any[];
  };

  const useFirst = (filter?: DbWhere<any>, options?: Pick<DbReadOptions<any>, 'orderBy'>): any | undefined => {
    const signature = createDbWhereSignature(filter, options);
    const { data } = useLiveQuery(
      q => applyDbReadOptionsToQuery(applyDbWhereToQuery(q.from({ items: tanstackCollection }) as any, filter), options as DbReadOptions<any> | undefined).findOne(),
      [signature]
    );

    return data as unknown as any | undefined;
  };

  const useByIds = (ids: string[]): any[] => {
    const { data } = useLiveQuery(
      q => (ids.length > 0 ? q.from({ items: tanstackCollection }).where(({ items }) => inArray(toQueryValue((items as Record<string, unknown>).id), ids)) : undefined),
      [ids]
    );
    return (data ?? EMPTY) as any[];
  };

  const useCount = (filter?: DbWhere<any>): number => {
    const signature = createDbWhereSignature(filter);

    const { data } = useLiveQuery(
      q =>
        applyDbWhereToQuery(q.from({ items: tanstackCollection }) as any, filter)
          .groupBy(() => GROUP_ALL)
          .select(({ items }: { items: unknown }) => ({ total: dbCount(toQueryValue((items as Record<string, unknown>).id)) })),
      [signature]
    );

    return (data as Array<{ total: number }> | undefined)?.[0]?.total ?? 0;
  };

  registerModelRuntimeReset(config.name, () => {
    freshness.reset();
    resetMergeState();
  });

  const baseModel: CollectionModel<any, any> = {
    get: (id: string | undefined | null) => (id ? rawCollection.get(id) : undefined),
    getAll: () => Array.from(rawCollection.values()),
    getWhere: filter => getSnapshotWhere(filter),
    getFirstWhere: (filter, options) => getSnapshotFirstWhere(filter, options),
    getFirst: (filter, options) => getSnapshotFirstWhere(filter, options),
    patch: (id, updates) => crud.patch(id, updates),
    destroy: id => crud.destroy(id),
    destroyMany,
    destroyWhere,
    replaceRaw: (oldId: string, item: unknown): boolean => {
      const normalized = normalize(item);
      if (!normalized) return false;
      withApplyingModel(config.name, () => {
        withTransaction(() => {
          runSideloads(config.sideload, [item], { mode: 'merge', source: 'sideload' });
          rawCollection.delete(oldId);
          rawCollection.insert(normalized as any);
        });
      });
      return true;
    },
    insertStored: (item: any) => {
      rawCollection.insert(item);
    },
    applyServerData,
    markFetched: freshness.markFetched,
    getFetchState: freshness.getFetchState,
    clearFetchState: freshness.clearFetchState,
    shouldSkipInitialFetch,
    clearScope,
    find: useFind,
    all: useAll,
    where: useWhere,
    byIds: useByIds,
    first: useFirst,
    count: useCount,
    collection: tanstackCollection,
    _collection: tanstackCollection
  };

  const extensions = (config.statics as ((model: CollectionModel<any, any>) => Record<string, unknown>) | undefined)?.(baseModel);
  if (!extensions) {
    registerModel(config.name, baseModel);
    return baseModel;
  }

  for (const key of Object.keys(extensions)) {
    if (key in baseModel) {
      throw new Error(`[${config.name}] statics cannot override base model key "${key}".`);
    }
  }

  const model = { ...baseModel, ...extensions };
  registerModel(config.name, model);
  return model;
}

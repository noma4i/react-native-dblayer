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
  FieldsCollectionModel,
  MergeResult,
  ModelBuildStoredInput,
  ModelFieldSpecs,
  ModelRelationsConfig,
  ModelStoredFromFields,
  PersistentMutationTransaction,
  RelatedSurface,
  RowRelatedSurface,
  ReplaceResult,
  StoredRowBase,
  SyncContract
} from '../types';
import { toQueryValue } from '../utils/typeBoundary';
import { applyDbReadOptionsToQuery, applyDbReadOptionsToRows, applyDbWhereToQuery, createDbWhereSignature, matchesDbWhere, normalizeDbCondition } from './compileDbWhere';
import { createMerge } from './createMerge';
import { createPatchCrud } from './createPatchCrud';
import { createReplace } from './createReplace';
import {
  clearCollectionFetchState,
  clearCollectionFetchStates,
  getCollectionFetchState,
  listCollectionFetchScopes,
  registerCollectionFetchStateCache,
  setCollectionFetchState
} from './freshnessStorage';
import { getDbLogger } from './logger';
import { getDbModelDefaults } from './modelDefaults';
import { registerModel } from './modelRegistry';
import { attachRowRelated, buildRelatedAccessors, getCascadeController, registerCascadeController, relationValues, touchBelongsToParents } from './relations';
import { isInManagedMutationBatch, registerModelRuntimeReset } from './registry';
import { stableSerialize } from './serialize';
import { isModelApplying, runSideloads, withApplyingModel } from './sideload';

const EMPTY: readonly unknown[] = [];
const GROUP_ALL = 1 as const;
const ROOT_FETCH_SCOPE = '__root__';

const buildFetchScope = <TStored>(filter?: Partial<TStored>): { scope: string; filter?: Record<string, unknown> } => {
  const normalized = normalizeDbCondition(filter);
  if (!normalized) return { scope: ROOT_FETCH_SCOPE };
  return { scope: stableSerialize(normalized), filter: normalized as Record<string, unknown> };
};

const createFreshnessTracker = <TStored>(modelName: string, collectionId: string | null, staleTime: number, emptyStaleTime: number) => {
  const fetchStateCache = new Map<string, CollectionFetchState | null>();

  if (collectionId) {
    fetchStateCache.set(ROOT_FETCH_SCOPE, getCollectionFetchState(collectionId));
    registerCollectionFetchStateCache(collectionId, scopeKey => {
      fetchStateCache.delete(scopeKey ?? ROOT_FETCH_SCOPE);
    });
  }

  const getFetchState = (filter?: Partial<TStored>): CollectionFetchState | null => {
    const { scope } = buildFetchScope(filter);
    if (fetchStateCache.has(scope)) {
      return fetchStateCache.get(scope) ?? null;
    }

    const nextState = collectionId ? getCollectionFetchState(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope) : null;
    fetchStateCache.set(scope, nextState);
    return nextState;
  };

  const markFetched = (filter?: Partial<TStored>, state?: Omit<CollectionFetchState, 'touchedAt'>): void => {
    const { scope, filter: normalizedFilter } = buildFetchScope(filter);
    const nextState: CollectionFetchState = {
      touchedAt: Date.now(),
      empty: state?.empty === true,
      ...(state?.pageInfo ? { pageInfo: state.pageInfo } : {})
    };
    fetchStateCache.set(scope, nextState);
    if (collectionId) {
      setCollectionFetchState(collectionId, nextState, scope === ROOT_FETCH_SCOPE ? undefined : scope, normalizedFilter);
    }
  };

  const touch = (): void => {
    markFetched(undefined, { empty: false });
  };

  const clearFetchState = (filter?: Partial<TStored>): void => {
    const { scope, filter: normalizedFilter } = buildFetchScope(filter);
    fetchStateCache.delete(scope);
    if (collectionId) {
      getDbLogger().debug('db', 'freshness:clear', { model: modelName, scope: normalizedFilter });
      clearCollectionFetchState(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope);
    }
  };

  const isStale = (filter?: Partial<TStored>, maxAgeMs = staleTime, emptyMaxAgeMs = emptyStaleTime): boolean => {
    const fetchState = getFetchState(filter);
    if (!fetchState) return true;
    const effectiveMaxAgeMs = fetchState.empty ? emptyMaxAgeMs : maxAgeMs;
    if (effectiveMaxAgeMs <= 0) return true;
    return Date.now() - fetchState.touchedAt > effectiveMaxAgeMs;
  };

  const shouldSkipInitialFetch = (
    hasItems: (filter?: Partial<TStored>) => boolean,
    filter?: Partial<TStored>,
    maxAgeMs = staleTime,
    emptyMaxAgeMs = emptyStaleTime
  ): boolean => {
    const fetchState = getFetchState(filter);
    if (fetchState?.empty === true) {
      return !isStale(filter, maxAgeMs, emptyMaxAgeMs);
    }
    return hasItems(filter) && !isStale(filter, maxAgeMs, emptyMaxAgeMs);
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

type RuntimeModelConfig = CreateCollectionModelNormalizeConfig<any, any, any, any> | CreateCollectionModelFieldsConfig<any, any, any>;

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

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const hasFactoryDefault = (field: ModelFieldSpecs[string]): boolean => hasOwn(field, 'factoryDefault');

const resolveFactoryDefault = (field: ModelFieldSpecs[string]): unknown => {
  const value = field.factoryDefault;
  return typeof value === 'function' ? (value as () => unknown)() : value;
};

const createStoredRowBuilder =
  (name: string, fields: ModelFieldSpecs) =>
  (partial: Record<string, unknown>): Record<string, unknown> & { id: string } => {
    const input = typeof partial === 'object' && partial !== null ? partial : {};
    if (!hasOwn(input, 'id')) {
      throw new Error(`[${name}] buildStored missing required field "id".`);
    }

    const output: Record<string, unknown> & { id: string } = { ...(input as Record<string, unknown>) } as Record<string, unknown> & { id: string };

    for (const key of Object.keys(fields)) {
      if (hasOwn(input, key)) continue;

      const field = fields[key]!;
      if (hasFactoryDefault(field)) {
        output[key] = resolveFactoryDefault(field);
      } else if (field.mode === 'nullable') {
        output[key] = null;
      } else if (field.mode === 'required') {
        throw new Error(`[${name}] buildStored missing required field "${key}".`);
      }
    }

    return output;
  };

/**
 * Create a collection model from a persistent collection, normalizer, and relations.
 *
 * @param config Collection id, storage collection, normalize function, optional statics, freshness settings, sideloads, and lazy relations.
 * @returns A reactive collection model extended with supplied statics and relation accessors.
 */
export function createCollectionModel<
  TInput,
  TStored extends { id: string; updatedAt?: string | null },
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig = any
>(
  config: CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, TRelations> & { relations: () => TRelations }
): CollectionModel<TInput, TStored & RowRelatedSurface<TRelations>> & TExt & RelatedSurface<TRelations>;
/**
 * Create a collection model from a persistent collection and normalizer.
 *
 * @param config Collection id, storage collection, normalize function, optional statics, freshness settings, and sideloads.
 * @returns A reactive collection model extended with supplied statics.
 */
export function createCollectionModel<TInput, TStored extends { id: string; updatedAt?: string | null }, TExt extends Record<string, unknown> = {}>(
  config: Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, TExt>, 'relations'> & { relations?: undefined }
): CollectionModel<TInput, TStored> & TExt;
/**
 * Create a fields-schema model with relation accessors and generated normalize/buildStored helpers.
 *
 * @param config Collection id, fields schema, optional rowId/guard/statics/freshness settings/sideloads, and lazy relations.
 * @returns A reactive fields collection model extended with supplied statics and relation accessors.
 */
export function createCollectionModel<
  TFields extends ModelFieldSpecs,
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig = any
>(
  config: CreateCollectionModelFieldsConfig<TFields, TExt, TRelations> & { relations: () => TRelations }
): FieldsCollectionModel<ModelStoredFromFields<TFields> & RowRelatedSurface<TRelations>, ModelBuildStoredInput<TFields>, ModelStoredFromFields<TFields>> & TExt & RelatedSurface<TRelations>;
/**
 * Create a fields-schema model with generated normalize/buildStored helpers.
 *
 * @param config Collection id, fields schema, optional rowId/guard/statics/freshness settings, and sideloads.
 * @returns A reactive fields collection model extended with supplied statics.
 */
export function createCollectionModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}>(
  config: Omit<CreateCollectionModelFieldsConfig<TFields, TExt>, 'relations'> & { relations?: undefined }
): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>> & TExt;
export function createCollectionModel(config: RuntimeModelConfig): any {
  const { collection: rawCollection, staleTime = 0, emptyStaleTime = 0 } = config;
  const normalizeBase = resolveNormalize(config);
  let attachRelatedToRow = <TRow extends StoredRowBase>(row: TRow): TRow => row;
  let touchRelatedParents = (_row: StoredRowBase | undefined): void => {};
  const normalize = (item: unknown): ({ id: string } & Record<string, unknown>) | null => {
    const normalized = normalizeBase(item);
    return normalized ? attachRelatedToRow(normalized as StoredRowBase & Record<string, unknown>) : null;
  };
  const collectionId = typeof rawCollection.id === 'string' && rawCollection.id.length > 0 ? rawCollection.id : null;
  const freshness = createFreshnessTracker<any>(config.name, collectionId, staleTime, emptyStaleTime);
  let resetMergeState = (): void => {};
  let relationCache: ModelRelationsConfig | null = null;
  let relatedAccessorsCache: unknown;
  const runtimeCollection = {
    get id() {
      return rawCollection.id;
    },
    get: (id: string) => {
      const row = rawCollection.get(id);
      return row ? attachRelatedToRow(row) : undefined;
    },
    has: (id: string) => rawCollection.has(id),
    insert: (item: StoredRowBase & Record<string, unknown>) => {
      rawCollection.insert(attachRelatedToRow(item));
      const row = rawCollection.get(item.id);
      if (row) {
        attachRelatedToRow(row);
        touchRelatedParents(row);
      }
    },
    update: (id: string, updater: (draft: StoredRowBase & Record<string, unknown>) => void) => {
      rawCollection.update(id, updater);
      const row = rawCollection.get(id);
      if (row) {
        attachRelatedToRow(row);
        touchRelatedParents(row);
      }
    },
    delete: (id: string) => rawCollection.delete(id),
    keys: () => rawCollection.keys(),
    values: () => rawCollection.values(),
    get size() {
      return rawCollection.size;
    },
    acceptMutations: rawCollection.acceptMutations
  };

  const merge = createMerge<any, any>({
    collection: runtimeCollection,
    normalize,
    shouldOverwrite: config.merge?.shouldOverwrite,
    dedupeWindowMs: config.merge?.dedupeWindowMs,
    resolveDedupeWindowMs: () => getDbModelDefaults().merge?.dedupeWindowMs,
    registerReset: reset => {
      resetMergeState = reset;
    }
  });

  const replace = createReplace<any, any>({
    collection: runtimeCollection,
    normalize,
    shouldOverwrite: config.replace?.shouldOverwrite
  });

  const crud = createPatchCrud<any>({ collection: runtimeCollection });

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
      if (matchesDbWhere(item, filter)) results.push(attachRelatedToRow(item));
    }
    return results;
  };

  const getSnapshotFirstWhere = (filter?: DbWhere<any>, options?: Pick<DbReadOptions<any>, 'orderBy'>): any | undefined => {
    const rows = filter ? getSnapshotWhere(filter) : attachRelatedToRows(Array.from(rawCollection.values()));
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

  const shouldSkipInitialFetch = (filter?: Partial<any>, maxAgeMs?: number, emptyMaxAgeMs?: number): boolean => freshness.shouldSkipInitialFetch(hasCached, filter, maxAgeMs, emptyMaxAgeMs);

  const resolveRelationMap = (): ModelRelationsConfig => {
    if (relationCache !== null) return relationCache;
    const nextRelations = config.relations?.() ?? {};
    relationCache = nextRelations;
    return nextRelations;
  };

  const resolveRelations = (): ReturnType<typeof relationValues> => relationValues(resolveRelationMap());

  const hasRelations = (): boolean => typeof config.relations === 'function';

  const resolveRelatedAccessors = (): any => {
    if (!relatedAccessorsCache) {
      relatedAccessorsCache = buildRelatedAccessors(config.name, resolveRelationMap, {
        collection: tanstackCollection as CollectionModel<unknown, StoredRowBase>['collection'],
        getRow: id => {
          const row = id ? rawCollection.get(id) : undefined;
          return row ? attachRelatedToRow(row) : undefined;
        }
      });
    }
    return relatedAccessorsCache;
  };

  attachRelatedToRow = <TRow extends StoredRowBase>(row: TRow): TRow => {
    if (!hasRelations()) return row;
    return attachRowRelated(config.name, row, resolveRelationMap, resolveRelatedAccessors) as TRow;
  };

  touchRelatedParents = (row: StoredRowBase | undefined): void => {
    if (!hasRelations() || isModelApplying(config.name)) return;
    touchBelongsToParents(resolveRelationMap(), row);
  };

  const attachRelatedToRows = <TRow extends StoredRowBase>(rows: TRow[]): TRow[] => {
    if (!hasRelations() || rows.length === 0) return rows;
    for (const row of rows) {
      attachRelatedToRow(row);
    }
    return rows;
  };

  const attachHydratedRows = (): void => {
    if (!hasRelations()) return;
    attachRelatedToRows(Array.from(rawCollection.values()) as Array<StoredRowBase & Record<string, unknown>>);
  };

  if (hasRelations()) {
    if (tanstackCollection.isReady()) {
      attachHydratedRows();
    } else {
      void tanstackCollection.stateWhenReady().then(attachHydratedRows, () => {});
    }
  }

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

  const scopeMatchesRow = (scope: Record<string, unknown>, row: Record<string, unknown>): boolean => Object.entries(scope).every(([field, value]) => row[field] === value);

  const clearFetchStatesForRows = (rows: Array<StoredRowBase & Record<string, unknown>>): void => {
    if (!collectionId || rows.length === 0) return;
    for (const record of listCollectionFetchScopes(collectionId)) {
      if (!record.scopeKey || !record.scope) continue;
      const scope = record.scope;
      if (rows.some(row => scopeMatchesRow(scope, row))) {
        clearCollectionFetchState(collectionId, record.scopeKey);
      }
    }
  };

  const deleteManyWithoutCascade = (ids: string[], options?: { clearFreshness?: boolean }): number => {
    let deleted = 0;
    const rowsToDelete = options?.clearFreshness === false
      ? []
      : ids.map(id => rawCollection.get(id)).filter((row): row is StoredRowBase & Record<string, unknown> => Boolean(row));
    withTransaction(() => {
      for (const id of ids) {
        if (!rawCollection.has(id)) continue;
        rawCollection.delete(id);
        deleted += 1;
      }
    });
    clearFetchStatesForRows(rowsToDelete);
    return deleted;
  };

  const cascadeDependents = (victimIds: string[], visitedModelNames: Set<string>): void => {
    if (!hasRelations() || victimIds.length === 0) return;
    const relations = resolveRelations();
    if (relations.length === 0) return;

    const victimSet = new Set(victimIds);
    for (const relation of relations) {
      if (relation.kind !== 'hasMany' || relation.dependent !== 'destroy') continue;

      const childController = getCascadeController(relation.model);
      if (!childController) {
        throw new Error(`[${config.name}] relation "${relation.foreignKey}" target is not registered for cascade destroy.`);
      }
      const childIds = childController.getIdsWhereFieldIn(relation.foreignKey, victimSet);
      if (childIds.length === 0) continue;
      childController.destroyManyWithCascade(childIds, visitedModelNames);
    }
  };

  const destroyManyWithCascade = (ids: string[], visitedModelNames: Set<string>): number => {
    const victimIds = ids.filter((id, index) => ids.indexOf(id) === index && rawCollection.has(id));
    if (victimIds.length === 0) return 0;
    if (visitedModelNames.has(config.name)) return deleteManyWithoutCascade(victimIds);

    const nextVisitedModelNames = new Set(visitedModelNames);
    nextVisitedModelNames.add(config.name);
    cascadeDependents(victimIds, nextVisitedModelNames);
    const deletedDuringCascade = victimIds.filter(id => !rawCollection.has(id)).length;
    return deletedDuringCascade + deleteManyWithoutCascade(victimIds);
  };

  const destroyMany = (ids: string[]): number => destroyManyWithCascade(ids, new Set());

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
    return data ? attachRelatedToRow(data as unknown as StoredRowBase & Record<string, unknown>) : undefined;
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

    return attachRelatedToRows((data ?? EMPTY) as Array<StoredRowBase & Record<string, unknown>>);
  };

  const useWhere = (filter: DbWhere<any>, options?: DbReadOptions<any>): any[] => {
    const signature = createDbWhereSignature(filter, options);
    const { data } = useLiveQuery(
      q => applyDbReadOptionsToQuery(applyDbWhereToQuery(q.from({ items: tanstackCollection }) as any, filter), options),
      [signature]
    );

    return attachRelatedToRows((data ?? EMPTY) as Array<StoredRowBase & Record<string, unknown>>);
  };

  const useFirst = (filter?: DbWhere<any>, options?: Pick<DbReadOptions<any>, 'orderBy'>): any | undefined => {
    const signature = createDbWhereSignature(filter, options);
    const { data } = useLiveQuery(
      q => applyDbReadOptionsToQuery(applyDbWhereToQuery(q.from({ items: tanstackCollection }) as any, filter), options as DbReadOptions<any> | undefined).findOne(),
      [signature]
    );

    return data ? attachRelatedToRow(data as unknown as StoredRowBase & Record<string, unknown>) : undefined;
  };

  const useByIds = (ids: string[]): any[] => {
    const { data } = useLiveQuery(
      q => (ids.length > 0 ? q.from({ items: tanstackCollection }).where(({ items }) => inArray(toQueryValue((items as Record<string, unknown>).id), ids)) : undefined),
      [ids]
    );
    return attachRelatedToRows((data ?? EMPTY) as Array<StoredRowBase & Record<string, unknown>>);
  };

  const useCount = (...args: [DbWhere<any>?]): number => {
    const filter = args[0];
    if (args.length > 0 && filter == null) return 0;
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

  const getIdsWhereFieldIn = (field: string, values: ReadonlySet<string>): string[] => {
    const ids: string[] = [];
    for (const row of rawCollection.values()) {
      const value = (row as Record<string, unknown>)[field];
      if (typeof value === 'string' && values.has(value)) {
        ids.push(row.id);
      }
    }
    return ids;
  };

  const registerModelCascadeController = (model: object): void => {
    registerCascadeController(model, {
      modelName: config.name,
      attachRowRelated: row => attachRelatedToRow(row),
      destroyManyWithCascade,
      getIdsWhereFieldIn,
      getRelation: name => (hasRelations() ? resolveRelationMap()[name] : undefined)
    });
  };

  const baseModel: CollectionModel<any, any> = {
    get: (id: string | undefined | null) => {
      const row = id ? rawCollection.get(id) : undefined;
      return row ? attachRelatedToRow(row) : undefined;
    },
    getAll: () => attachRelatedToRows(Array.from(rawCollection.values())),
    getWhere: filter => getSnapshotWhere(filter),
    getFirstWhere: (filter, options) => getSnapshotFirstWhere(filter, options),
    getFirst: (filter, options) => getSnapshotFirstWhere(filter, options),
    patch: (id, updates) => {
      const changed = crud.patch(id, updates);
      if (changed) {
        const row = rawCollection.get(id);
        if (row) attachRelatedToRow(row);
      }
      return changed;
    },
    destroy: id => destroyMany([id]) === 1,
    destroyMany,
    destroyWhere,
    _deleteManyWithoutFreshness: ids => deleteManyWithoutCascade(ids, { clearFreshness: false }),
    replaceRaw: (oldId: string, item: unknown): boolean => {
      const normalized = normalize(item);
      if (!normalized) return false;
      withTransaction(() => {
        withApplyingModel(config.name, () => {
          runSideloads(config.sideload, [item], { mode: 'merge', source: 'sideload' });
        });
        rawCollection.delete(oldId);
        runtimeCollection.insert(normalized as any);
      });
      return true;
    },
    insertStored: (item: any) => {
      runtimeCollection.insert(item);
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

  const modelBase = hasFieldsConfig(config) ? { ...baseModel, buildStored: createStoredRowBuilder(config.name, config.fields) } : baseModel;
  registerModelCascadeController(modelBase);

  const attachRelatedAccessors = <TModel extends object>(model: TModel): TModel => {
    if (!hasRelations()) return model;

    Object.defineProperty(model, 'related', {
      enumerable: true,
      configurable: false,
      get() {
        return resolveRelatedAccessors();
      }
    });
    return model;
  };

  const extensions = (config.statics as ((model: typeof modelBase) => Record<string, unknown>) | undefined)?.(modelBase);
  if (!extensions) {
    const model = attachRelatedAccessors(modelBase);
    registerModel(config.name, model);
    return model;
  }

  for (const key of Object.keys(extensions)) {
    if (key in modelBase) {
      throw new Error(`[${config.name}] statics cannot override base model key "${key}".`);
    }
  }

  const model = { ...modelBase, ...extensions };
  const modelWithRelated = attachRelatedAccessors(model);
  registerModelCascadeController(modelWithRelated);
  registerModel(config.name, modelWithRelated);
  return modelWithRelated;
}

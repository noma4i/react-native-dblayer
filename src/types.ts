import type { Collection, StorageEventApi } from '@tanstack/db';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { DocumentNode } from 'graphql';
import type { UseQueryResult } from '@tanstack/react-query';
import type { SideloadSpec } from './core/sideload';
import type { FieldSpec } from './schema/fieldSpec';
import type { InferBuildStoredInput, InferStoredFields } from './schema/infer';

export type PersistentMutationTransaction = {
  /** Raw TanStack DB mutation records accepted by persistent collections. */
  mutations: Array<unknown>;
};

export type StorageAdapter = {
  /** Read a persisted value synchronously. */
  getItem(key: string): string | null;
  /** Write a persisted value synchronously. */
  setItem(key: string, value: string): void;
  /** Remove a persisted value synchronously. */
  removeItem(key: string): void;
  /** Enumerate stored keys for freshness pruning. */
  getAllKeys(): string[];
  /** Clear every key owned by the adapter. */
  clear(): void;
  /** Cross-context change events; a no-op implementation is valid on React Native. */
  eventApi: StorageEventApi;
};

export type DbLogger = {
  /** Verbose lifecycle logs from request and mutation runtimes. */
  debug: (...args: unknown[]) => void;
  /** Errors observed by request and mutation runtimes. */
  error: (...args: unknown[]) => void;
};

export type DbTrackEvent = {
  /** Analytics-agnostic event name. */
  name: string;
  /** Optional structured event payload. */
  payload?: Record<string, unknown>;
};

export type DbTrackSink = (event: DbTrackEvent) => void;

/** Domain-defined extract payload or preset. */
export type DbExtractSpec = unknown;

/** GraphQL document accepted by the transport adapter. */
export type DbGraphQLDocument<TData = unknown, TVariables = Record<string, unknown>> = TypedDocumentNode<TData, TVariables> | DocumentNode;

export type DbQueryOperation<TData = unknown, TVariables = Record<string, unknown>> = {
  /** GraphQL query document to execute. */
  query: DbGraphQLDocument<TData, TVariables>;
  /** Query variables passed to the transport. */
  variables?: TVariables;
} & Record<string, unknown>;

export type DbMutationOperation<TData = unknown, TVariables = Record<string, unknown>> = {
  /** GraphQL mutation document to execute. */
  mutation: DbGraphQLDocument<TData, TVariables>;
  /** Mutation variables passed to the transport. */
  variables?: TVariables;
} & Record<string, unknown>;

export type TransportResult<TData> = {
  /** Operation response data returned by the transport. */
  data: TData;
};

export type DbTransport = {
  /** Execute a GraphQL query and resolve to `{ data }`. */
  query: <TData = unknown, TVariables = Record<string, unknown>>(operation: DbQueryOperation<TData, TVariables>) => Promise<TransportResult<TData>>;
  /** Execute a GraphQL mutation and resolve to `{ data }`. */
  mutation: <TData = unknown, TVariables = Record<string, unknown>>(operation: DbMutationOperation<TData, TVariables>) => Promise<TransportResult<TData>>;
};

export interface DbCollection<T> {
  /** Optional collection id used as a storage key prefix. */
  readonly id?: string;
  /** Snapshot read by id. */
  get(id: string): T | undefined;
  /** Snapshot existence check by id. */
  has(id: string): boolean;
  /** Insert or replace an item. */
  insert(item: T): void;
  /** Update an item through a draft callback. */
  update(id: string, updater: (draft: T) => void): void;
  /** Delete an item by id. */
  delete(id: string): void | boolean;
  /** Snapshot iterator of ids. */
  keys(): IterableIterator<string>;
  /** Snapshot iterator of rows. */
  values(): IterableIterator<T>;
  /** Snapshot collection size when available. */
  size?: number;
  /** Commit a persisted TanStack DB transaction. */
  acceptMutations?: (transaction: PersistentMutationTransaction) => void;
}

export type PersistentCollection<T extends { id: string }> = DbCollection<T> & {
  /** Required collection id used as a storage key prefix. */
  readonly id: string;
  /** Backing TanStack DB collection. */
  readonly _collection: Collection<T, string>;
  /** Commit a persisted TanStack DB transaction. */
  acceptMutations: (transaction: PersistentMutationTransaction) => void;
};

export type StoredRowBase = { id: string; updatedAt?: string | null };

export type StringFieldKey<TStored extends StoredRowBase> = {
  [K in keyof TStored & string]: TStored[K] extends string ? K : never;
}[keyof TStored & string];

export type HasManyDependent = 'destroy';

export type HasManyOptions<TChildStored extends StoredRowBase, TForeignKey extends StringFieldKey<TChildStored>> = {
  /** Child row field that stores the parent id. */
  foreignKey: TForeignKey;
  /** Dependent action for child rows. Omit for query-only relations. */
  dependent?: HasManyDependent;
};

export type RelationModel<TStored extends StoredRowBase> = {
  getAll(): TStored[];
  getWhere(filter: DbWhere<any>): TStored[];
  where(filter: DbWhere<any>, options?: DbReadOptions<any>): TStored[];
  count(filter?: DbWhere<any> | null): number;
  destroyMany(ids: string[]): number;
  destroyWhere(filter: Partial<any>): number;
  collection: Collection<TStored, string>;
};

export type BelongsToModel<TStored extends StoredRowBase> = {
  get(id: string | undefined | null): TStored | undefined;
  find(id: string | undefined | null): TStored | undefined;
  patch(id: string, updates: Partial<any>): boolean;
  collection: Collection<TStored, string>;
};

export type ModelRelationDefinition = {
  /** Relation kind. */
  kind: 'hasMany';
  /** Runtime child model reference. */
  model: unknown;
  /** Child row field that stores the parent id. */
  foreignKey: string;
  /** Dependent action for child rows. Omitted for query-only relations. */
  dependent?: HasManyDependent;
};

export type HasManyRelation<
  TChildStored extends StoredRowBase,
  TForeignKey extends string,
  TChildModel = RelationModel<TChildStored>
> = ModelRelationDefinition & {
  /** Child model. */
  model: TChildModel & RelationModel<TChildStored>;
  /** Child row field that stores the parent id. */
  foreignKey: TForeignKey;
};

export type BelongsToRelation<
  TParentStored extends StoredRowBase,
  TForeignKey extends string,
  TParentModel = BelongsToModel<TParentStored>
> = {
  /** Relation kind. */
  kind: 'belongsTo';
  /** Parent model. */
  model: TParentModel & BelongsToModel<TParentStored>;
  /** Field on this child row that stores the parent id. */
  foreignKey: TForeignKey;
  /** Whether local child writes should bump the parent timestamp. */
  touch: boolean;
};

export type HasManyThroughRelation<TThrough extends string = string, TSource extends string = string> = {
  /** Relation kind. */
  kind: 'hasManyThrough';
  /** Direct hasMany relation name on this model. */
  through: TThrough;
  /** Direct hasMany relation name on the through-child model. */
  source: TSource;
};

export type ModelRelationConfigValue = ModelRelationDefinition | BelongsToRelation<any, string, any> | HasManyThroughRelation;

export type ModelRelationsConfig = Record<string, ModelRelationConfigValue>;

export type RelatedAccessor<TChildStored extends StoredRowBase> = {
  /** Snapshot read of child rows for a parent id. Nullish parent returns an empty array. */
  get(parentId: string | null | undefined): TChildStored[];
  /** React hook: reactive child rows for a parent id. Nullish parent returns a stable empty array. */
  use(parentId: string | null | undefined): TChildStored[];
  /** React hook: reactive child count for a parent id. Nullish parent returns zero. */
  count(parentId: string | null | undefined): number;
};

export type BelongsToAccessor<TParentStored extends StoredRowBase> = {
  /** Snapshot read of the parent row for a child id. Nullish child returns undefined. */
  get(childId: string | null | undefined): TParentStored | undefined;
  /** React hook: reactive parent row for a child id. Nullish child returns undefined. */
  use(childId: string | null | undefined): TParentStored | undefined;
};

type RelatedSourceRecord<TModel> = TModel extends { readonly related: infer TRelated } ? TRelated : never;

type RelatedSourceChild<
  TRelations extends ModelRelationsConfig,
  TThrough extends string,
  TSource extends string
> = TThrough extends keyof TRelations
  ? TRelations[TThrough] extends { kind: 'hasMany'; model: infer TThroughModel }
    ? TSource extends keyof RelatedSourceRecord<TThroughModel>
      ? RelatedSourceRecord<TThroughModel>[TSource] extends RelatedAccessor<infer TSourceStored>
        ? TSourceStored
        : never
      : never
    : never
  : never;

export type ChildStoredOf<
  TRelation,
  TRelations extends ModelRelationsConfig
> = TRelation extends { kind: 'belongsTo'; model: BelongsToModel<infer TParentStored> }
  ? TParentStored
  : TRelation extends { kind: 'hasMany'; model: RelationModel<infer TChildStored> }
  ? TChildStored
  : TRelation extends HasManyThroughRelation<infer TThrough, infer TSource>
    ? RelatedSourceChild<TRelations, TThrough, TSource>
    : never;

export type RelatedRecord<TRelations extends ModelRelationsConfig> = {
  [K in keyof TRelations]: TRelations[K] extends { kind: 'belongsTo' }
    ? BelongsToAccessor<ChildStoredOf<TRelations[K], TRelations>>
    : RelatedAccessor<ChildStoredOf<TRelations[K], TRelations>>;
};

export type RowRelatedRecord<TRelations extends ModelRelationsConfig> = {
  readonly [K in keyof TRelations]: TRelations[K] extends { kind: 'belongsTo' }
    ? ChildStoredOf<TRelations[K], TRelations> | undefined
    : Array<ChildStoredOf<TRelations[K], TRelations>>;
};

type IsAny<T> = 0 extends 1 & T ? true : false;
type HasBroadRelationKeys<TRelations> = IsAny<TRelations> extends true ? true : string extends keyof TRelations ? true : false;

export type RelatedSurface<TRelations extends ModelRelationsConfig | undefined> = [TRelations] extends [ModelRelationsConfig]
  ? HasBroadRelationKeys<TRelations> extends true
    ? { readonly related: never }
    : { readonly related: RelatedRecord<TRelations> }
  : {};

export type RowRelatedSurface<TRelations extends ModelRelationsConfig | undefined> = [TRelations] extends [ModelRelationsConfig]
  ? HasBroadRelationKeys<TRelations> extends true
    ? { readonly related: never }
    : { readonly related: RowRelatedRecord<TRelations> }
  : {};

export type StoredWriteInput<TStored> = TStored extends { readonly related: unknown } ? Omit<TStored, 'related'> : TStored;

export interface MergeResult {
  /** Number of rows inserted or updated. */
  merged: number;
}

export interface CreateMergeConfig<TInput, TOutput extends { id: string; updatedAt?: string | null }> {
  /** Target collection. */
  collection: DbCollection<TOutput>;
  /** Convert input into a stored row patch; return null to drop it. */
  normalize: (item: TInput) => (Partial<TOutput> & { id: string }) | null;
  /** Force-accept a merge the timestamp gate would reject. */
  shouldOverwrite?: (existing: TOutput, incoming: Partial<TOutput> & { id: string }) => boolean;
  /**
   * Skip an identical merge batch within this window.
   * @default 0
   */
  dedupeWindowMs?: number;
  /** Resolve the default dedupe window when no model-level value is configured. */
  resolveDedupeWindowMs?: () => number | undefined;
  /** Register a runtime reset callback for dedupe state. */
  registerReset?: (reset: () => void) => void;
}

export type DbModelDefaults = {
  merge?: {
    /**
     * Skip an identical merge batch within this window.
     * @default 0
     */
    dedupeWindowMs?: number;
  };
};

export interface ReplaceResult {
  /** Number of rows inserted or updated. */
  merged: number;
  /** Number of existing rows removed. */
  deleted: number;
}

export interface CreateReplaceConfig<TInput, TOutput extends { id: string }> {
  /** Target collection. */
  collection: DbCollection<TOutput>;
  /** Convert input into a stored row patch; return null to drop it. */
  normalize: (item: TInput) => (Partial<TOutput> & { id: string }) | null;
  /** Force-accept a replace write the timestamp gate would reject. */
  shouldOverwrite?: (existing: TOutput, incoming: Partial<TOutput> & { id: string }) => boolean;
}

export interface CreatePatchCrudConfig<T extends { id: string }> {
  /** Target collection. */
  collection: DbCollection<T>;
}

export interface PatchCrud<T extends { id: string }> {
  /** Shallow-update a row by id. */
  patch(id: string, updates: Partial<T>): boolean;
  /** Delete a row by id. */
  destroy(id: string): boolean;
}

export type IncomingRecord = Record<string, unknown> & { updatedAt?: string | null };

export interface ShouldAcceptIncomingOptions<TExisting extends IncomingRecord, TIncoming extends IncomingRecord> {
  /** Timestamp comparison strategy. */
  timestampMode?: 'incoming-newer' | 'when-both-present';
  /** Equality strategy used before accepting an incoming row. */
  equalityMode?: 'full' | 'defined-fields';
  /** Force-accept an incoming row. */
  shouldOverwrite?: (existing: TExisting, incoming: TIncoming) => boolean;
}

/**
 * Public write contract for a server-data sync: write strategy, freshness label, and optional scope tag.
 * `source` is optional rather than the originally proposed required field - `mergeSyncContract`/
 * `replaceSyncContract` always set it, but some package-internal test call sites construct a bare
 * `{ mode: 'merge' }` literal directly against a model's `applyServerData` without it; making it
 * required would silently break those callers (see the P2a-fix report for the exact list).
 */
export interface SyncContract<TScope = unknown> {
  /** Write strategy: merge new data or replace the scoped set. */
  mode: 'merge' | 'replace';
  /** Freshness/debug label for this write. */
  source?: string;
  /** Optional opaque scope tag for scoped writes. */
  scope?: TScope;
}

/**
 * Package-internal widening of `SyncContract` carrying the scoped-replace predicate and freshness
 * scope that `createCollectionBinding`'s `applyServerData` wrapper computes before forwarding to a
 * model's `applyServerData` implementation. Never part of the public surface - callers only ever
 * construct or receive a plain `SyncContract`.
 * Only package internals and package tests (`src/__tests__`) may construct this type directly; app
 * code always goes through `mergeSyncContract`/`replaceSyncContract`.
 */
export interface InternalSyncContract<TScope = unknown> extends SyncContract<TScope> {
  /** Scoped replace predicate; required when replacing with `scope`. */
  _scopeFilter?: (item: unknown) => boolean;
  /** Freshness scope recorded after the write. */
  _freshnessFilter?: Record<string, unknown>;
}

export type CollectionFetchState = {
  /** Millisecond timestamp when the scope was marked fetched. */
  touchedAt: number;
  /** Whether the fetched scope was known empty. */
  empty: boolean;
  /** Last known pagination state for the fetched scope. */
  pageInfo?: PageInfo;
};

export type CollectionFetchScopeRecord = {
  /** Storage key suffix for the fetch-state scope; undefined is the root scope. */
  scopeKey?: string;
  /** Stored-row filter persisted with scoped fetch-state metadata. */
  scope?: Record<string, unknown>;
  /** Snapshot freshness state for this scope. */
  state: CollectionFetchState;
};

export interface FetchStateRemovalListener {
  /** Called when a freshness scope is removed. */
  (scopeKey?: string): void;
}

export type ModelFieldSpecs = Record<string, FieldSpec<any, any, any, any>>;
export type ModelStoredFromFields<TFields extends ModelFieldSpecs> = InferStoredFields<TFields> extends { id: string; updatedAt?: string | null } ? InferStoredFields<TFields> : never;
export type ModelBuildStoredInput<TFields extends ModelFieldSpecs> = InferBuildStoredInput<TFields>;
export interface FieldsCollectionModel<TStored extends { id: string; updatedAt?: string | null }, TBuildInput, TBuildOutput = StoredWriteInput<TStored>> extends CollectionModel<unknown, TStored> {
  /** Build a complete stored row from explicit values plus field factory defaults. */
  buildStored(partial: TBuildInput): TBuildOutput;
}

interface CreateCollectionModelBaseConfig<
  TInput,
  TStored extends { id: string; updatedAt?: string | null },
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig | undefined = ModelRelationsConfig | undefined,
  TModel extends CollectionModel<TInput, TStored> = CollectionModel<TInput, TStored>
> {
  /** Unique model name used as a runtime-registry key and log tag. */
  name: string;
  /** Persistent collection backing the model. */
  collection: PersistentCollection<TStored>;
  /** Extra class-level model methods composed from the base model DSL. */
  statics?: (model: TModel) => TExt;
  /**
   * Freshness window in milliseconds.
   * @default 0
   */
  staleTime?: number;
  /**
   * Freshness window for known-empty scopes in milliseconds.
   * @default 0
   */
  emptyStaleTime?: number;
  merge?: {
    /**
     * Skip an identical merge batch within this window.
     * @default 0
     */
    dedupeWindowMs?: number;
    /** Force-accept a merge the timestamp gate would reject. */
    shouldOverwrite?: (existing: TStored, incoming: Partial<TStored> & { id: string }) => boolean;
  };
  replace?: {
    /** Force-accept a replace write the timestamp gate would reject. */
    shouldOverwrite?: (existing: TStored, incoming: Partial<TStored> & { id: string }) => boolean;
  };
  /** Sort applied by the reactive `all()` hook. */
  defaultSort?: { field: keyof TStored & string; direction: 'asc' | 'desc' };
  /** Nested payloads to sync before writing this model. */
  sideload?: SideloadSpec<TInput>[];
  /** Lazy relation declarations. Lazy resolution avoids circular model import timing. */
  relations?: () => TRelations;
}

export interface CreateCollectionModelNormalizeConfig<
  TInput,
  TStored extends { id: string; updatedAt?: string | null },
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig | undefined = ModelRelationsConfig | undefined
> extends CreateCollectionModelBaseConfig<TInput, TStored, TExt, TRelations> {
  /** Map an input to a stored row patch; return null to drop it. */
  normalize: (item: TInput) => (Partial<TStored> & { id: string }) | null;
  fields?: never;
  rowId?: never;
  guard?: never;
}

export interface CreateCollectionModelFieldsConfig<
  TFields extends ModelFieldSpecs,
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig | undefined = ModelRelationsConfig | undefined
>
  extends CreateCollectionModelBaseConfig<
    unknown,
    ModelStoredFromFields<TFields>,
    TExt,
    TRelations,
    FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>>
  > {
  /** Declarative field specs used to generate the model normalizer. */
  fields: TFields;
  /** Optional row id resolver; defaults to `input.id`. */
  rowId?: (input: unknown) => string | null | undefined;
  /** Return false to drop an incoming row before normalization. */
  guard?: (input: unknown) => boolean;
  normalize?: never;
}

export type CreateCollectionModelConfig<
  TInput,
  TStored extends { id: string; updatedAt?: string | null },
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig | undefined = ModelRelationsConfig | undefined
> = CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, TRelations>;

export type DbCondition<T> = Partial<T>;

export type DbWhere<T> =
  | DbCondition<T>
  | { and: Array<DbWhere<T>> }
  | { or: Array<DbWhere<T>> }
  | { not: DbWhere<T> };

export interface DbReadOptions<T> {
  orderBy?: { field: keyof T & string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface CollectionModel<TInput, TStored extends { id: string; updatedAt?: string | null }> {
  /** Snapshot read by id; safe outside React. */
  get(id: string | undefined | null): TStored | undefined;
  /** Snapshot read of every row; safe outside React. */
  getAll(): TStored[];
  /** Snapshot read of rows matching a typed predicate. */
  getWhere(filter: DbWhere<TStored>): TStored[];
  /** Snapshot read of the first row matching a typed predicate. */
  getFirst(filter?: DbWhere<TStored>, options?: Pick<DbReadOptions<TStored>, 'orderBy'>): TStored | undefined;
  /** Shallow-update one row and return whether it changed. */
  patch(id: string, updates: Partial<StoredWriteInput<TStored>>): boolean;
  /** Delete one row and return whether it existed. */
  destroy(id: string): boolean;
  /** Delete many rows and return the number removed. */
  destroyMany(ids: string[]): number;
  /** Delete rows matching a non-empty filter and return the number removed. */
  destroyWhere(filter: Partial<TStored>): number;
  /** Atomically delete `oldId` and insert the normalized server item. */
  replaceRaw(oldId: string, item: TInput): boolean;
  /** Insert an already-normalized stored row. */
  insertStored(item: StoredWriteInput<TStored>): void;
  /** Apply server data using a merge or replace sync contract. */
  applyServerData(items: unknown[], contract: SyncContract): MergeResult | ReplaceResult;
  /** Mark a filter scope as fetched now. */
  markFetched(filter?: Partial<TStored>, state?: Omit<CollectionFetchState, 'touchedAt'>): void;
  /** Snapshot read of freshness metadata for a filter scope. */
  getFetchState(filter?: Partial<TStored>): CollectionFetchState | null;
  /** Clear freshness metadata for a filter scope. */
  clearFetchState(filter?: Partial<TStored>): void;
  /** Return true when the scope has data or opted-in known-empty freshness and is not stale. */
  shouldSkipInitialFetch(filter?: Partial<TStored>, maxAgeMs?: number, emptyMaxAgeMs?: number): boolean;
  /** Internal maintenance delete that skips cascade and freshness clearing. */
  _deleteManyWithoutFreshness?(ids: string[]): number;
  /** Delete every row and clear freshness metadata. */
  clearScope(): void;
  /** React hook: read one row by id and re-render on change. */
  find(id: string | undefined | null): TStored | undefined;
  /** React hook: read all rows and re-render on change. */
  all(): TStored[];
  /** React hook: read rows matching a typed predicate. */
  where(filter: DbWhere<TStored>, options?: DbReadOptions<TStored>): TStored[];
  /** React hook: read rows matching the supplied ids. */
  byIds(ids: string[]): TStored[];
  /** React hook: read the first row matching a typed predicate. */
  first(filter?: DbWhere<TStored>, options?: Pick<DbReadOptions<TStored>, 'orderBy'>): TStored | undefined;
  /** React hook: count rows, optionally filtered by a typed predicate. Explicit nullish filters return 0. */
  count(filter?: DbWhere<TStored> | null): number;
  /** Public backing TanStack DB collection for live-query joins. */
  collection: Collection<TStored, string>;
}

export type DbKeyModelSource = {
  collection: { readonly id: string };
};

export type CollectionBindingUseDataContext<TStored, TRead = TStored> = {
  /** Original runtime filter passed to the binding. */
  filter: unknown;
  /** Stored-row scope derived through `scopeMap`. */
  scope: Partial<TStored> | undefined;
  /** Rows read from the bound model after scope filtering and ordering. */
  rows: TStored[];
  /** Whether the owning query has disabled collection reads (derived from `enabled === false`). */
  disabled: boolean;
  /** Stable empty result for no-data projections. */
  empty: TRead[];
};

type CollectionReadBaseConfig<TStored, TRead = TStored> = {
  /** Map scope keys to stored row fields. */
  scopeMap?: Record<string, keyof TStored & string>;
  /** Override the bound read hook while retaining model writes, freshness, and scope plumbing. */
  useData?: (context: CollectionBindingUseDataContext<TStored, TRead>) => TRead[];
};

type CollectionReadSortFieldConfig<TStored, TRead = TStored> = CollectionReadBaseConfig<TStored, TRead> & {
  /** Optional field used to sort read results. */
  sortField?: keyof TStored & string;
  /** Sort direction for `sortField`. */
  sortDirection?: 'asc' | 'desc';
  comparator?: never;
};

type CollectionReadComparatorConfig<TStored, TRead = TStored> = CollectionReadBaseConfig<TStored, TRead> & {
  sortField?: never;
  sortDirection?: never;
  /** Optional comparator used to sort read results. Mutually exclusive with `sortField`. */
  comparator?: (left: TStored, right: TStored) => number;
};

export type CollectionReadConfig<TStored, TRead = TStored> = CollectionReadSortFieldConfig<TStored, TRead> | CollectionReadComparatorConfig<TStored, TRead>;

type StableProjectionBaseConfig<TSource, TEntry extends { item: TItem }, TItem> = {
  /** Build a projection entry from source data. */
  buildEntry?: (source: TSource) => TEntry | null;
  /** Shared empty item array returned when no data is present. */
  emptyItems?: TItem[];
};

type StableProjectionKeyConfig<TSource, TEntry extends { item: TItem }, TItem> =
  | (StableProjectionBaseConfig<TSource, TEntry, TItem> & {
    /** Stable key for a source value. */
    getKey: (source: TSource) => string;
  })
  | (TSource extends { id: string }
    ? StableProjectionBaseConfig<TSource, TEntry, TItem> & {
      /** Omit to use the source item's string `id`. */
      getKey?: undefined;
    }
    : never);

export type StableProjectionConfig<TSource, TEntry extends { item: TItem }, TItem> = StableProjectionKeyConfig<TSource, TEntry, TItem> & {
  /** Compare projection entries for stability. */
  entriesEqual: (prev: TEntry, next: TEntry) => boolean;
  /** Use `renderKeys` only with `useStableItems`; not with custom entry equality. */
  renderKeys?: never;
};

export type StableProjectionRenderKeysConfig<TSource, TEntry extends { item: TItem }, TItem extends object> = StableProjectionKeyConfig<TSource, TEntry, TItem> & {
  /** Item fields that determine rendered equality. */
  renderKeys: Array<keyof TItem>;
  /** Custom entry equality is mutually exclusive with render key equality. */
  entriesEqual?: never;
};

export type StableItemsConfig<TSource, TEntry extends { item: TItem }, TItem extends object> =
  | StableProjectionConfig<TSource, TEntry, TItem>
  | StableProjectionRenderKeysConfig<TSource, TEntry, TItem>;

export type StableEntityVolatileKeysConfig<TItem extends object> = {
  /** Fields ignored when comparing the current entity with the previous one. */
  volatileKeys: ReadonlyArray<keyof TItem & string>;
  renderKeys?: never;
};

export type StableEntityRenderKeysConfig<TItem extends object> = {
  /** Fields that determine rendered equality. */
  renderKeys: ReadonlyArray<keyof TItem>;
  volatileKeys?: never;
};

export type StableEntityConfig<TItem extends object> = StableEntityVolatileKeysConfig<TItem> | StableEntityRenderKeysConfig<TItem>;

type BaseQueryCollectionFind<TStored = unknown> = {
  /** Model used for a reactive single-row read. */
  model: DbKeyModelSource & {
    /** React hook: read one row by id. */
    find: (id: string | undefined | null) => TStored | undefined;
    /** Freshness gate for the row scope. */
    shouldSkipInitialFetch?: (filter?: any, maxAgeMs?: number, emptyMaxAgeMs?: number) => boolean;
    /** Snapshot freshness state for the row scope. */
    getFetchState?: (filter?: any) => CollectionFetchState | null;
    /** Mark the row scope as fetched. */
    markFetched?: (filter?: any, state?: Omit<CollectionFetchState, 'touchedAt'>) => void;
  };
  /** Row id to read reactively. */
  id: string | undefined | null;
};

type BaseQueryCollectionAll<TStored = unknown> = {
  /** Model used for a reactive all-rows read. */
  model: DbKeyModelSource & {
    /** React hook: read all rows. */
    all: () => TStored[];
    /** Freshness gate for the root scope. */
    shouldSkipInitialFetch?: (filter?: undefined, maxAgeMs?: number, emptyMaxAgeMs?: number) => boolean;
    /** Snapshot freshness state for the root scope. */
    getFetchState?: () => CollectionFetchState | null;
    /** Mark the root scope as fetched. */
    markFetched?: (filter?: undefined, state?: Omit<CollectionFetchState, 'touchedAt'>) => void;
  };
};

/**
 * Reactive read config attached to a base query.
 *
 * @template TStored Stored row type returned by the model read hooks. Omit it for the staged-adoption
 * escape hatch: untyped collections still read as `unknown`.
 */
export type BaseQueryCollection<TStored = unknown> = BaseQueryCollectionFind<TStored> | BaseQueryCollectionAll<TStored>;

type BaseQueryCollectionReadData<TCollection> = TCollection extends BaseQueryCollectionFind<infer TStored>
  ? TStored | null
  : TCollection extends BaseQueryCollectionAll<infer TStored>
    ? TStored[]
    : unknown;

type IsUnknown<T> = unknown extends T ? ([T] extends [unknown] ? true : false) : false;

/** Data shape produced by a typed base-query collection read. */
export type BaseQueryCollectionData<TCollection extends BaseQueryCollection | undefined> =
  NonNullable<TCollection> extends BaseQueryCollection ? BaseQueryCollectionReadData<NonNullable<TCollection>> : unknown;

/** Default single-request result data after applying explicit result, model read, or selected payload inference. */
export type DbRequestSingleData<TResult, TSelected, TRead extends BaseQueryCollection | undefined> = IsUnknown<TResult> extends true
  ? NonNullable<TRead> extends BaseQueryCollection
    ? BaseQueryCollectionData<TRead>
    : TSelected
  : TResult;

export type BaseQueryConfig<TData, TCollection extends BaseQueryCollection | undefined = BaseQueryCollection | undefined> = {
  /** React Query cache key. */
  queryKey: readonly unknown[];
  /** Function that resolves query data. */
  queryFn: () => Promise<TData>;
  /**
   * Gate query execution. `false` marks the query fully inactive: the network request is disabled, the
   * freshness gate is skipped, the collection read is suppressed, `data` is `undefined`,
   * `hasFetchedData` is `false`, and the derived loading phase is `'idle'` (not `'initial_loading'`),
   * so `showSkeleton` stays `false` while disabled instead of showing a skeleton with no active fetch.
   */
  enabled?: boolean;
  /** React Query freshness window in milliseconds. */
  staleTime?: number;
  /** Freshness window for known-empty DB scopes in milliseconds. */
  emptyStaleTime?: number;
  /** React Query cache garbage-collection window in milliseconds. */
  gcTime?: number;
  /** React Query remount refetch behavior. */
  refetchOnMount?: boolean;
  /** Optional model read used to derive displayed data and freshness. */
  collection?: TCollection;
};

export type PageInfo = {
  /** Whether another page is available after the current page. */
  hasNextPage: boolean;
  /** Whether another page is available before the current page. */
  hasPreviousPage: boolean;
  /** Cursor of the first item in the page. */
  startCursor?: string | null;
  /** Cursor of the last item in the page. */
  endCursor?: string | null;
};

export type PageInfoInput = {
  /** Optional raw next-page flag from a connection. */
  hasNextPage?: boolean | null;
  /** Optional raw previous-page flag from a connection. */
  hasPreviousPage?: boolean | null;
  /** Optional raw start cursor from a connection. */
  startCursor?: string | null;
  /** Optional raw end cursor from a connection. */
  endCursor?: string | null;
};

/** Normalized nodes and pagination metadata from a connection. */
export type ConnectionResult<TNode> = { nodes: TNode[]; pageInfo: PageInfo };

export type ConnectionWithNodes = {
  /** Connection nodes. */
  nodes?: Array<unknown> | null;
  /** Connection pagination metadata. */
  pageInfo?: PageInfoInput | null;
};

export type ConnectionWithEdges = {
  /** Connection edges containing nodes. */
  edges?: Array<{ node?: unknown } | null | undefined> | null;
  /** Connection pagination metadata. */
  pageInfo?: PageInfoInput | null;
};

export type PaginationState = {
  /** Last known pagination metadata. */
  pageInfo?: PageInfo;
  /** Whether another page is available. */
  hasNextPage: boolean;
  /** Whether a next-page request is in flight. */
  isFetchingNextPage: boolean;
};

export type InfiniteSyncContractResolverContext<TNode> = {
  /** Cursor used for the page being written. */
  pageParam?: string;
  /** Nodes extracted from the page. */
  nodes: TNode[];
  /** Scope computed from filter and current user id. */
  scope: unknown;
};

export type InfiniteQueryConfig<TData, TNode> = {
  /** React Query cache key. */
  queryKey: readonly unknown[];
  /** Function that resolves one page of query data. */
  queryFn: (params: { pageParam?: string }) => Promise<TData>;
  /** Extract nodes and pagination metadata from page data. */
  extract: (data: TData) => ConnectionResult<TNode>;
  /**
   * Gate query execution. `false` marks the query fully inactive: the network request is disabled, the
   * freshness gate is skipped, the collection read is suppressed, `data` is `undefined`,
   * `hasFetchedData` is `false`, the derived loading phase is `'idle'` (not `'initial_loading'`, so
   * `showSkeleton` stays `false` while disabled), and the imperative `loadMore`/`refresh` triggers
   * early-return instead of calling `queryFn` directly (their fallback branches bypass this `enabled`
   * gate otherwise).
   */
  enabled?: boolean;
  /** React Query freshness window in milliseconds. */
  staleTime?: number;
  /** Freshness window for known-empty DB scopes in milliseconds. */
  emptyStaleTime?: number;
  /** React Query cache garbage-collection window in milliseconds. */
  gcTime?: number;
  /** React Query remount refetch behavior. */
  refetchOnMount?: boolean;
  /** Pagination direction. */
  direction?: 'forward' | 'backward';
  /** Read the next cursor from page data. */
  getCursor?: (data: TData) => string | number | null | undefined;
  /** Build a scope filter for reads and writes. */
  getFilter?: () => unknown;
  /** Provide current-user scope input. */
  getCurrentUserId?: () => string | undefined;
  /** Override how each page is written to the collection. */
  resolveSyncContract?: (context: InfiniteSyncContractResolverContext<TNode>) => SyncContract;
  collection: {
    /** Model used for derived query keys. */
    _dbModel?: DbKeyModelSource;
    /** Map the runtime filter to the same stored scope used by freshness metadata. */
    _dbScope?: (filter?: unknown) => object | undefined;
    /** Write extracted nodes to the collection. */
    applyServerData: (items: unknown[], contract: SyncContract) => void;
    /** React hook: read paged data from the collection. `disabled` suppresses the read (derived from `enabled === false`) independent of the filter's own nullishness. */
    useData: (filter?: unknown, disabled?: boolean) => TNode[];
    /** React hook: count rows matching the runtime filter. Explicit nullish filters return 0. */
    count?: (filter?: unknown | null) => number;
    /** Freshness gate for the page scope. */
    shouldSkipInitialFetch: (filter?: unknown, maxAgeMs?: number, emptyMaxAgeMs?: number) => boolean;
    /** Snapshot freshness state for the page scope. */
    getFetchState?: (filter?: unknown) => CollectionFetchState | null;
    /** Mark the page scope as fetched. */
    markFetched?: (filter?: unknown, state?: Omit<CollectionFetchState, 'touchedAt'>) => void;
  };
  /** Whether the query should return reactive data or leave reads to another hook. */
  readMode?: 'data' | 'none';
};

export type SyncConfig = {
  /** Model that receives selected query payloads. */
  model: DbKeyModelSource & {
    /** Write selected payloads using the configured sync contract. */
    applyServerData: (items: unknown[], contract: SyncContract) => unknown;
  };
  /** Source label used for the merge sync contract. */
  contract: string;
};

export type DbInfinitePatchContext = {
  /** Node index within the page. */
  index: number;
  /** Node index across the current request lifecycle; resets on initial-page fetches. */
  globalIndex: number;
  /** Cursor used for the page being patched. */
  pageParam?: string;
};

export type DbRequestSingleConfig<
  TResponse,
  TResult = unknown,
  TSelected = unknown,
  TVariables = Record<string, unknown>,
  TRead extends BaseQueryCollection | undefined = BaseQueryCollection | undefined
> = {
  /** GraphQL query document. */
  query: DbGraphQLDocument<TResponse, TVariables>;
  /** React Query cache key. Derived from a model-backed read or sync when omitted. */
  key?: readonly unknown[];
  /** Pick the payload from response data. Defaults to the full response data. */
  select?: (data: TResponse) => TSelected;
  /** Query variables. */
  vars?: TVariables;
  /** Transform the selected payload before returning it when no `read` is configured. */
  map?: (selected: TSelected) => TResult;
  /** Write selected data to a model or custom sync function. */
  sync?: ((selected: TSelected) => void) | SyncConfig;
  /** Side-load payload passed to the extract sink with source `query`. */
  extract?: (params: { data: TResponse; selected: TSelected }) => unknown;
  /** Reactive read returned from the model after the query writes. */
  read?: TRead;
  /**
   * Gate query execution. `false` marks the query fully inactive: the network request is disabled, the
   * freshness gate is skipped, the collection read is suppressed, `data` is `undefined`,
   * `hasFetchedData` is `false`, and the derived loading phase is `'idle'` (not `'initial_loading'`),
   * so `showSkeleton` stays `false` while disabled instead of showing a skeleton with no active fetch.
   * @default true
   */
  enabled?: boolean;
  /** React Query freshness window in milliseconds. */
  staleTime?: number;
  /** Freshness window for known-empty DB scopes in milliseconds. */
  emptyStaleTime?: number;
  /** React Query cache garbage-collection window in milliseconds. */
  gcTime?: number;
  /** React Query remount refetch behavior. */
  refetchOnMount?: boolean;
};

export type DbRequestInfiniteConfig<TResponse, TNode, TVariables = Record<string, unknown>> = {
  /** Paginated GraphQL query document. */
  query: DbGraphQLDocument<TResponse, TVariables>;
  /** React Query cache key. Derived from the collection binding and scope when omitted. */
  key?: readonly unknown[];
  /** Pick a connection with `nodes` or `edges` from response data. */
  selectPage: (data: TResponse) => ConnectionWithNodes | ConnectionWithEdges | null | undefined;
  /** Base query variables. */
  vars?: TVariables;
  /** Scope values used as default query variables and, when `filter` is omitted, as the read/write filter. */
  scope?: unknown | (() => unknown);
  /** Map a cursor to page-specific variables. */
  getPageVars?: (pageParam: string) => Record<string, unknown>;
  /** Decorate each node before writing it. */
  patchNode?: (node: TNode, context: DbInfinitePatchContext) => Record<string, unknown> | null | undefined;
  /** Side-load payload passed to the extract sink with source `query`. */
  extract?: (params: { data: TResponse; nodes: TNode[] }) => unknown;
  /** Override how each page is written to the collection. */
  resolveSyncContract?: (context: InfiniteSyncContractResolverContext<TNode>) => SyncContract;
  /** Collection binding that stores page nodes and reads them reactively. */
  read: InfiniteQueryConfig<TResponse, TNode>['collection'];
  /**
   * Whether this hook returns reactive data.
   * @default 'data'
   */
  readMode?: InfiniteQueryConfig<TResponse, TNode>['readMode'];
  /** Read the next cursor from page data. */
  getCursor?: (data: TResponse) => string | number | null | undefined;
  /** Build a scope filter for reads and writes. */
  filter?: () => unknown;
  /** Provide current-user scope input. */
  currentUserId?: () => string | undefined;
  /**
   * Pagination direction.
   * @default 'forward'
   */
  direction?: 'forward' | 'backward';
  /**
   * Gate query execution. `false` marks the query fully inactive: the network request is disabled, the
   * freshness gate is skipped, the collection read is suppressed, `data` is `undefined`,
   * `hasFetchedData` is `false`, the derived loading phase is `'idle'` (not `'initial_loading'`, so
   * `showSkeleton` stays `false` while disabled), and the imperative `loadMore`/`refresh` triggers
   * early-return instead of calling `queryFn` directly (their fallback branches bypass this `enabled`
   * gate otherwise).
   * @default true
   */
  enabled?: boolean;
  /** React Query freshness window in milliseconds. */
  staleTime?: number;
  /** Freshness window for known-empty DB scopes in milliseconds. */
  emptyStaleTime?: number;
  /** React Query cache garbage-collection window in milliseconds. */
  gcTime?: number;
  /** React Query remount refetch behavior. */
  refetchOnMount?: boolean;
};

/** UI loading-state phase. */
export type LoadingPhase = 'idle' | 'hydrating' | 'initial_loading' | 'ready' | 'refreshing' | 'loading_more' | 'error';

/** UI state machine derived from query and collection state. */
export type LoadingState = {
  /** Current loading phase. */
  phase: LoadingPhase;
  /** Whether any data is available. */
  hasData: boolean;
  /** Whether the UI can show ready data. */
  isReady: boolean;
  /** Whether the initial skeleton should be visible. */
  showSkeleton: boolean;
  /** Whether primary data should be visible. */
  showData: boolean;
  /** Whether an empty state should be visible. */
  showEmptyState: boolean;
  /** Whether a pull/refresh indicator should be visible. */
  showRefreshIndicator: boolean;
  /** Whether a pagination footer spinner should be visible. */
  showFooterSpinner: boolean;
  /** Whether a non-blocking error banner should be visible. */
  showErrorBanner: boolean;
};

export type ComputePhaseInput = {
  /** Whether the owning screen is inactive. */
  isInactive?: boolean;
  /** Whether persisted data is hydrating. */
  isRestoring: boolean;
  /** Whether collection sync is ready. */
  isSyncReady: boolean;
  /** Whether a query request is in flight. */
  isFetching: boolean;
  /** Whether any data is available. */
  hasData: boolean;
  /** Whether a refresh is in flight. */
  isRefreshing: boolean;
  /** Whether a next-page request is in flight. */
  isFetchingNextPage: boolean;
  /** Whether the query is in an error state. */
  isError: boolean;
  /** Whether network data has been fetched at least once. */
  hasFetchedData: boolean;
};

/** React Query result plus the derived loading-state machine. */
export type BaseQueryResult<TData> = UseQueryResult<TData, Error> & { loadingState: LoadingState };

/**
 * Infinite query result with pagination and refresh helpers.
 *
 * Mirrors `BaseQueryResult`/TanStack's `UseQueryResult` surface (`data`, `refetch`) so single-request
 * and infinite hooks read the same way; `loadMore` is the domain-named pagination trigger. There is no
 * separate `items`/`refresh`/`fetchNextPage` alias set - `data`/`refetch`/`loadMore` are the only names,
 * and `fetchNextPage` was never actually lower-level than `loadMore` (same throttled function).
 */
export type InfiniteQueryResult<TNode> = {
  /** Accumulated reactive nodes. */
  data: TNode[];
  /** Derived UI loading-state machine. */
  loadingState: LoadingState;
  /** Whether another page is available. */
  hasNextPage: boolean;
  /** Whether a next-page request is in flight. */
  isFetchingNextPage: boolean;
  /** Whether a background refresh is in flight. */
  isBackgroundFetching: boolean;
  /** Re-run the query from the first page. */
  refetch: () => Promise<void>;
  /** Load the next page when available. */
  loadMore: () => void;
};

type DbMutationSharedConfig<TData, TInput, TContext> = {
  /** GraphQL mutation document. */
  mutation: DbGraphQLDocument<Record<string, TData>, { input: unknown }>;
  /** Response data field that contains the mutation result. */
  resultField: string;
  /** Transform caller input into `variables.input`. */
  mapInput?: (input: TInput) => unknown;
  /** Key factory used for React Query and single-flight dedupe. */
  key?: () => readonly unknown[];
  /** Log tag for mutation lifecycle messages. */
  logPrefix?: string;
  /** Side-load spec resolved through the mutation extract seam. */
  extract?: DbExtractSpec;
  /** Server write-through that runs inside the transaction after the response. */
  onCommit?: (data: TData | null, input: TInput, context: TContext) => void;
  /** Post-commit invalidation hook. */
  invalidate?: (data: TData | null, input: TInput) => void;
  /** Failure hook called before rollback rethrows. */
  onError?: (error: Error, input: TInput, context: TContext) => void;
  /** Declarative analytics-agnostic mutation tracking. */
  track?: {
    /** Event emitted before the optimistic/onMutate phase. */
    start?: (input: TInput) => DbTrackEvent | null | undefined;
    /** Event emitted after extract, preset commit, and manual onCommit. */
    success?: (data: TData | null, input: TInput, context: TContext) => DbTrackEvent | null | undefined;
    /** Event emitted in the error path after onError and before rethrow. */
    error?: (error: Error, input: TInput) => DbTrackEvent | null | undefined;
  };
};

export type DbOptimisticMutationContext<TStored = unknown> = {
  /** Optimistic row id generated by the preset, or an existing retry temp id. */
  tempId: string | null;
  /** Stored optimistic row inserted by the preset or read from an existing retry temp id. */
  optimisticRow: TStored | null;
};

type DbMutationContextWithOptimistic<TContext, TStored> = [TContext] extends [void] ? DbOptimisticMutationContext<TStored> : TContext & DbOptimisticMutationContext<TStored>;

export type DbMutationPreserveOnCommitConfig<TStored, TServerNode> =
  | ((serverNode: TServerNode, context: DbOptimisticMutationContext<TStored>) => TServerNode)
  | {
      fields: Array<keyof (TStored & TServerNode)>;
      mergers?: Partial<Record<keyof (TStored & TServerNode), (optimisticValue: unknown, serverValue: unknown) => unknown>>;
    };

export type DbMutationOptimisticConfig<TData, TInput, TStored, TServerNode = unknown> = {
  /** Model receiving the optimistic row and the committed server node. */
  model: {
    get: (id: string | undefined | null) => TStored | undefined;
    insertStored: (item: TStored) => void;
    replaceRaw: (oldId: string, item: TServerNode) => boolean;
    applyServerData: (items: TServerNode[], contract: SyncContract) => unknown;
  };
  /** Prefix passed to `generateTempId`; omit for the default `temp-*` ids. */
  tempIdPrefix?: string;
  /** Select an already-created optimistic id for retry/upload flows; defaults to `input.tempId`. */
  selectTempId?: (input: TInput) => string | null | undefined;
  /** Build the stored optimistic row. Return null to skip insertion and commit via `applyServerData`. */
  buildStored: (params: { input: TInput; tempId: string }) => TStored | null | undefined;
  /** Select the server node that replaces or merges the optimistic row. */
  selectServerNode: (data: TData | null, input: TInput) => TServerNode | null | undefined;
  /** Preserve optimistic snapshot fields before server commit writes the selected node. */
  preserveOnCommit?: DbMutationPreserveOnCommitConfig<TStored, TServerNode>;
};

type DestroyModelAdapter = {
  /** Delete a row by id. */
  destroy: (id: string) => boolean;
};

type PatchModelAdapter<TData = unknown> = {
  /** Snapshot read by id before building an optimistic patch. */
  get: (id: string) => TData | undefined;
  /** Shallow-update a row by id. */
  patch: (id: string, updates: Record<string, unknown>) => boolean;
};

type DbMutationDefaultConfig<TData, TInput, TContext> = DbMutationSharedConfig<TData, TInput, TContext> & {
  /** Custom optimistic variant; leave undefined. */
  method?: undefined;
  optimistic?: never;
  /** Optimistic write; returns context passed to commit/error hooks. */
  onMutate?: (input: TInput) => TContext;
  model?: never;
  selectId?: never;
  selectPatch?: never;
};

type DbMutationOptimisticDefaultConfig<TData, TInput, TContext, TStored, TServerNode> = DbMutationSharedConfig<TData, TInput, DbMutationContextWithOptimistic<TContext, TStored>> & {
  /** Custom optimistic variant; leave undefined. */
  method?: undefined;
  /** Declarative optimistic row preset. */
  optimistic: DbMutationOptimisticConfig<TData, TInput, TStored, TServerNode>;
  /** Optional extra optimistic side effects; object returns are merged into the commit context. */
  onMutate?: (input: TInput) => TContext | void;
  model?: never;
  selectId?: never;
  selectPatch?: never;
};

type DbMutationDestroyConfig<TData, TInput, TContext> = DbMutationSharedConfig<TData, TInput, TContext> & {
  /** Declarative optimistic delete variant. */
  method: 'destroy';
  /** Model to delete from. */
  model: DestroyModelAdapter;
  /** Select the row id to delete from caller input. */
  selectId: (input: TInput) => string | null | undefined;
  optimistic?: never;
  onMutate?: never;
  selectPatch?: never;
};

type DbMutationPatchConfig<TData, TInput, TContext, TStored> = DbMutationSharedConfig<TData, TInput, TContext> & {
  /** Declarative optimistic patch variant. */
  method: 'patch';
  /** Model to patch. */
  model: PatchModelAdapter<TStored>;
  /** Select the row id to patch from caller input. */
  selectId: (input: TInput) => string | null | undefined;
  /** Build the optimistic patch from input and the current row. */
  selectPatch: (input: TInput, current?: TStored) => Record<string, unknown> | null | undefined;
  optimistic?: never;
  onMutate?: never;
};

/** Transactional GraphQL mutation config with custom, patch, or destroy optimistic variants. */
export type DbMutationConfig<TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown> =
  | DbMutationDefaultConfig<TData, TInput, TContext>
  | DbMutationOptimisticDefaultConfig<TData, TInput, TContext, TStored, TServerNode>
  | DbMutationDestroyConfig<TData, TInput, TContext>
  | DbMutationPatchConfig<TData, TInput, TContext, TStored>;

export type BaseMutationContext<TStored = unknown> = {
  /** Previous row snapshot captured for rollback. */
  previous?: TStored;
};

export type DbCommandConfig<TData, TInput> = {
  /** Command key factory used for React Query and single-flight dedupe. */
  key?: () => readonly unknown[];
  /** Log tag for command lifecycle messages. */
  logPrefix?: string;
  /** Execute the command with caller input. */
  mutationFn: (input: TInput) => Promise<TData>;
  /** Optional projection used as the single-flight key. */
  singleFlightInput?: (input: TInput) => unknown;
  /** Success callback. */
  onSuccess?: (data: TData, input: TInput) => void;
  /** Error callback. */
  onError?: (error: unknown, input: TInput) => void;
  /** Settled callback. */
  onSettled?: () => void;
};

type DbCommandMutationBase = {
  /** Command key factory used for React Query and single-flight dedupe. */
  key?: () => readonly unknown[];
  /** Log tag for command lifecycle messages. */
  logPrefix?: string;
};

type DbCommandStaticConfig<TInput, TData> = DbCommandMutationBase & {
  /** Static GraphQL mutation document. */
  mutation: DbGraphQLDocument<Record<string, TData>, { input: unknown }>;
  /** Response data field returned by the command. */
  resultField: string;
  /** Transform caller input into `variables.input`. */
  mapInput?: (input: TInput) => unknown;
  resolve?: never;
};

type DbCommandResolvedConfig<TInput, TData> = DbCommandMutationBase & {
  mutation?: never;
  resultField?: never;
  mapInput?: never;
  /** Resolve the operation per input instead of using static fields. */
  resolve: (input: TInput) => {
    /** GraphQL mutation document for this input. */
    mutation: DbGraphQLDocument<Record<string, TData>, { input: unknown }>;
    /** Response data field returned by this operation. */
    resultField: string;
    /** Optional already-mapped input for `variables.input`. */
    input?: unknown;
  };
};

/** Fire-and-forget GraphQL command config, either static or resolved per input. */
export type DbCommandMutationConfig<TInput, TData = unknown> = DbCommandStaticConfig<TInput, TData> | DbCommandResolvedConfig<TInput, TData>;

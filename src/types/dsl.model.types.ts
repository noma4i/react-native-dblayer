import type { DbGraphQLDocument, DbReadOptions, DbWhere, ModelFieldSpecs } from './db.types';
import type { RelationDecl } from './core.relations.types';
import type { KeepPreviousOption } from './read.scopeRetention.types';
import type { defineQuery } from '../dsl/defineQuery';
import type { ConnectionLike, EnsuredRowQueryHandle, ScopeQueryHandle } from './dsl.query.types';
import type { ModelReadBuilder, RequiredFields } from './dsl.readBuilder.types';
import type { ScopeSpec } from './dsl.scope.types';
import type { InferBuildInput, InferStoredFields } from './schema.infer.types';
import type { ModelStatusPoller } from './utils.modelStatusPoller.types';
import type { WritePolicy, WriteCtx, WriteOrigin } from './core.writePolicies.types';
import type { ModelContext } from './dsl.modelContext.types';
import type { WriteOp } from './core.apply.journal.types';
import type { Dependency } from './core.apply.commitBus.types';
import type { ApplyTarget } from './core.apply.transaction.types';
import type { ClientSort, ReadOrder } from './dsl.ordering.types';

/** Row shape every model read path narrows to before projection. */
export type StoredRowShape = { id: string } & Record<string, unknown>;

export type ModelApplyTargetResult = {
  applyTarget: ApplyTarget;
  applySnapshot(ops: WriteOp[]): void;
  applyEvent(ops: WriteOp[]): void;
};

export type ModelNormalization<TStored extends Record<string, unknown>> = {
  applyWriteGate(previous: TStored, incoming: TStored, ctx: WriteCtx): TStored;
  isPlanRow(value: unknown): boolean;
  normalize(input: unknown, complete?: boolean): TStored;
};

export type ModelReadAccess<TStored extends { id: string } & Record<string, unknown>> = {
  rowDep(id: string, fields?: ReadonlyArray<string>): Dependency;
  modelDep: Dependency;
  useScopeAccess(scopeKey: string | null): void;
  scopeSortedRows(scopeName: string, scopeValue: unknown): TStored[];
  whereRead(where: DbWhere<TStored> | null): ModelReadBuilder<TStored>;
};

export type ModelWriteResult = { id: string; changedFields: string[] | null };
export type ModelMembership = { id: string; scopeKey: string; orderKey: string };

export type ModelWrites<TStored extends { id: string } & Record<string, unknown>> = {
  prepareRow(
    row: unknown,
    previous: TStored | undefined,
    origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>,
    mergeBase?: TStored,
    operationId?: string,
    baseRevision?: number
  ): import('./core.apply.transaction.types').PreparedRowWrite | null;
  preparePatch(
    id: string,
    patch: Record<string, unknown>,
    previous: TStored | undefined,
    operationId?: string,
    remove?: readonly string[],
    baseRevision?: number
  ): import('./core.apply.transaction.types').PreparedRowWrite | null;
  putRows(rows: TStored[]): ModelWriteResult[];
  planRows(rows: unknown[], planOptions?: { origin?: 'event' }): WriteOp[];
  splitCorrelatedRows(accepted: unknown[]): { plain: unknown[]; replaceOps: WriteOp[] };
  planReplace(oldId: string, next: unknown): WriteOp[];
  planRestore(next: unknown, memberships: ModelMembership[]): WriteOp[];
};

/** Declarative sort for a scope: by field, or by a consumer comparator with the fields it reads. */
export type ScopeSortSpec<TRow> = ClientSort<TRow>;

export type ScopeValueOf<TScope> = TScope extends object ? Record<string, unknown> : never;

/** Result of ScopeHandle.useWindow: locally-windowed scope rows plus paging/resolution flags. */
export type ScopeWindowResult<T> = {
  /** Current-key rows, or retained previous-key rows while `isPreviousData` is true. */
  rows: T[];
  /** Total count for the snapshot represented by `rows`. */
  totalCount: number;
  /** Whether more locally-synced rows exist beyond the current window. */
  hasMore: boolean;
  /** Grow the local window by one page without fetching from the network. */
  fetchNextPage: () => void;
  /** True only while rows belong to the previous scope key and the current key is unresolved. */
  isPreviousData: boolean;
  /** True once this scope has been reconciled at least once (its membership generation > 0). Use this (or a query's `loadingState`) - never raw `rows.length` - to tell an ingest-only scope's "waiting for first sync" from "synced and genuinely empty". */
  resolved: boolean;
};

export type ModelQueryConfig<TResponse, TVars, TScope, TStored> = Omit<Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0], 'key' | 'into'> & {
  key?: string;
  into?: Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0]['into'];
};

export type ModelDefinitions<TStored extends { id: string; updatedAt?: string | null }, TInput> = Pick<ModelCore<TStored, TInput>, 'query' | 'poller'>;

export type ModelDefinitionsOptions<TStored extends { id: string; updatedAt?: string | null }, _TInput> = {
  modelId: string;
  context: ModelContext<TStored>;
};

export type ModelSchemaRegistrationOptions<TStored extends { id: string } & Record<string, unknown>> = {
  modelId: string;
  modelName: string;
  fields: ModelFieldSpecs;
  scopes: Record<string, ScopeSpec<TStored>> | undefined;
  context: ModelContext<TStored>;
};

export type ModelRuntimeRegistrationOptions<TStored extends { id: string; updatedAt?: string | null } & Record<string, unknown>, _TInput> = {
  modelId: string;
  modelName: string;
  context: ModelContext<TStored>;
  maintenance?: {
    dropTempRowsAfterMs?: number;
    protectTempRows?: () => ReadonlySet<string> | readonly string[];
    maxRowsPerScope?: Array<{
      scopeField: Extract<keyof TStored, string>;
      limit: number;
      compare: (left: TStored, right: TStored) => number;
      protect?: () => (row: TStored) => boolean;
    }>;
  };
  normalize(input: unknown): TStored;
  applySnapshot(ops: WriteOp[]): void;
  planRows(rows: unknown[]): WriteOp[];
  planReplace(oldId: string, next: unknown): WriteOp[];
  captureMembership(id: string): Array<{ id: string; scopeKey: string; orderKey: string }>;
  planRestore(next: unknown, memberships: Array<{ id: string; scopeKey: string; orderKey: string }>): WriteOp[];
};

export type ModelDirectAccess<TStored extends { id: string; updatedAt?: string | null }, TInput> = Pick<
  ModelCore<TStored, TInput>,
  'find' | 'where' | 'all' | 'update' | 'destroy' | 'destroyMany' | 'updateAll' | 'destroyAll' | 'insert' | 'insertMany' | 'seed' | 'replace' | 'build' | 'normalize' | 'invalidate'
>;

export type ModelDirectAccessOptions<TStored extends { id: string; updatedAt?: string | null } & Record<string, unknown>, _TInput> = {
  modelId: string;
  context: ModelContext<TStored>;
  defaultOrder?: DbReadOptions<TStored>['orderBy'];
  matchesCriteria(row: TStored, where: DbWhere<TStored>): boolean;
  applyEvent(ops: WriteOp[]): void;
  planRows(rows: unknown[]): WriteOp[];
  planReplace(oldId: string, next: unknown): WriteOp[];
  normalize(input: unknown, build?: boolean): TStored;
};

/**
 * Reactive access to one named scope of a model (`model.scopes.<name>`), backed by the scope's
 * membership index. `scopeValue` selects the concrete scope instance (e.g. `{ groupId }`); `null`/`undefined`
 * reads as empty without subscribing.
 */
export type ScopeHandle<TStored extends { id: string }, TScope, TInput = TStored> = {
  modelId: string;
  /**
   * Reactive scope rows. `keepPrevious` opt-in retains the prior non-empty key until this key resolves.
   * `require` is a render-completeness contract: a row transiently missing one of those fields (mid
   * sideload/partial write) is held back until the field lands, then reappears through this same read.
   */
  use<TProjection extends Record<string, unknown>>(
    scopeValue: TScope | null | undefined,
    opts: { select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly (keyof TStored & string)[] } & KeepPreviousOption
  ): TProjection[];
  use(
    scopeValue: TScope | null | undefined,
    opts?: { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require?: readonly (keyof TStored & string)[] } & KeepPreviousOption
  ): TStored[];
  /**
   * Reactive first row of the scope; `undefined` when empty or when `scopeValue` is nullish (nullish
   * reads stay unsubscribed). Sugar for single-row scopes (e.g. byUuid lookups) over `use(...)[0]`;
   * re-renders follow the scope's row set.
   */
  useFirst(scopeValue: TScope | null | undefined, opts?: { renderKeys?: readonly (keyof TStored & string)[] } & KeepPreviousOption): TStored | undefined;
  /**
   * Reactive, render-windowed read of the scope: renders only the first `pageSize` (default from
   * `configureDb`'s `defaults.pageSize`, else 20) rows locally, growing the window on demand via the
   * returned `fetchNextPage`. This is LOCAL window growth over rows already synced into the model - a
   * different concept from `QueryResult.fetchNextPage` (`defineQuery`'s network pagination, which fetches
   * another page from the server), even though both surfaces share the `fetchNextPage` name. A list
   * typically wires both: `QueryResult.hasNextPage` / `QueryResult.fetchNextPage()` to fetch more rows
   * from the network, and `useWindow(...).hasMore` / `useWindow(...).fetchNextPage()` to reveal more of
   * what is already local. The window resets to `pageSize` whenever `scopeValue`'s key changes.
   */
  useWindow(
    scopeValue: TScope | null | undefined,
    opts?: { pageSize?: number; select?: never; renderKeys?: readonly (keyof TStored & string)[]; require?: readonly (keyof TStored & string)[] } & KeepPreviousOption
  ): ScopeWindowResult<TStored>;
  useWindow<TProjection extends Record<string, unknown>>(
    scopeValue: TScope | null | undefined,
    opts: { pageSize?: number; select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly (keyof TStored & string)[] } & KeepPreviousOption
  ): ScopeWindowResult<TProjection>;
  /** Reactive count of rows currently in the scope. */
  useCount(scopeValue: TScope | null | undefined): number;
  /** Clear this scope's fetch-state and invalidate its derived React Query key(s). */
  invalidate(scopeValue?: TScope): void;
  /** Synchronous snapshot read of the scope's rows, in sort order; safe to call outside React. */
  read(scopeValue: TScope): TStored[];
  /**
   * Issue the next numeric value at this scope's new edge. The result is `max(0, maxFieldValue,
   * maxIssuedThisSession) + 1`, where `maxFieldValue` is the largest numeric field value in the
   * current scope snapshot and `maxIssuedThisSession` is the largest value previously issued for
   * this model, scope key, and field in this runtime session. `resetRuntime` clears issued values;
   * `scopeValue` must be non-nullish.
   *
   * @param scopeValue Concrete scope instance receiving the optimistic row.
   * @param field Stored numeric field used for the scope ordering floor.
   * @returns The next strictly monotonic optimistic sequence value.
   */
  issueSequence(scopeValue: TScope, field: keyof TStored & string): number;
  /**
   * Seed dev/test rows and replace this scope's explicit membership in the provided order.
   * Rows still normalize and upsert through the journalled apply pipeline, including automatic
   * membership. Production data flows should use queries, mutations, or ingest instead.
   *
   * @param scopeValue Explicit scope key receiving the seeded membership.
   * @param rows Raw model inputs to normalize and seed.
   * @returns Nothing.
   */
  seed(scopeValue: TScope, rows: TInput[]): void;
};

export type ModelCore<TStored extends { id: string; updatedAt?: string | null }, TInput = TStored> = {
  modelId: string;
  /** Define a model-owned scope query; `data` is the scope's row array, point materialization is unavailable for scope destinations. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow> & { into: ScopeHandle<TRow, TScope> }
  ): ScopeQueryHandle<TRow, TScope>;
  /** Define a paginated model-destination query; `data` is the landed row array. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow> &
      ({ page: (data: TResponse) => ConnectionLike } | { connection: (data: TResponse) => ConnectionLike | null | undefined })
  ): EnsuredRowQueryHandle<TRow, TScope, TRow[]>;
  /** Define a model-owned query with a conventional `<modelId>:<name>` key and this model as the default destination; without `page`, `data` is the single landed row (an array-landing `select` needs `page` for list reads). */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow>
  ): EnsuredRowQueryHandle<TRow, TScope, TRow | undefined>;
  /** Internal refcounted status poller compiled by a model action. */
  poller<TData>(
    name: string,
    config: {
      document: DbGraphQLDocument<TData, { id: string }>;
      vars?: (id: string) => Record<string, unknown>;
      apply: (id: string, data: TData) => void;
      classify?: (data: TData) => 'ready' | 'failed' | null;
      intervalMs: number;
      maxAttempts: number;
      onSessionStop?: (id: string, reason: 'terminal-payload' | 'budget-exhausted' | 'stopped') => void;
    }
  ): ModelStatusPoller;
  find(id: string | null | undefined): TStored | undefined;
  where(where: DbWhere<TStored>, opts?: DbReadOptions<TStored>): TStored[];
  /** Full snapshot - library/maintenance channel; app code stays on scoped reads. */
  all(): TStored[];
  update(id: string, patch: Partial<TStored>): void;
  destroy(id: string): void;
  destroyMany(ids: string[]): void;
  /**
   * Patch every row matching `where` in ONE journal plan: single transaction, single commit publish,
   * one render per mounted reader. Snapshot semantics - the match set is computed once against
   * current rows before applying; rows that start matching because of the patch itself are not
   * re-visited.
   *
   * @param where Local `DbWhere` predicate (equality leaves, `DbWhereOp` operators, and/or/not).
   * @param patch Partial stored-field update applied to every matched row.
   * @returns Number of rows matched and patched.
   */
  updateAll(where: DbWhere<TStored>, patch: Partial<TStored>): number;
  /**
   * Destroy every row matching `where` in ONE journal plan: single transaction, single commit
   * publish. Snapshot semantics as in `updateAll`.
   *
   * @param where Local `DbWhere` predicate selecting the rows to destroy.
   * @returns Number of rows destroyed.
   */
  destroyAll(where: DbWhere<TStored>): number;
  insert(row: TStored): void;
  /**
   * Insert several rows as ONE plan: one journal record, one apply transaction, one commit publish -
   * unlike calling `insert` in a loop, which would journal/publish once per row. Each row still
   * goes through the same per-row normalize, `guard`, and event-origin tombstone gate as `insert`;
   * relation side effects (`touch`, `counterCache`, declarative scope membership) are expanded once over
   * the whole batch, so a `belongsTo` `counterCache` increments by the batch's full count in one step
   * rather than one increment per row.
   */
  insertMany(rows: TStored[]): void;
  replace(oldId: string, next: unknown): void;
  build(input: unknown): TStored;
  normalize(input: unknown): Partial<TStored> & { id: string };
  invalidate(scope?: unknown): void;
  use: {
    /**
     * Return whether one row id belongs to an open optimistic operation.
     *
     * Nullish ids return false without subscribing. Boot replay rolls hydrated pending operations
     * back before completing, so reconciled orphan temp rows are absent and report false.
     *
     * @param id Row id to inspect, or a nullish value for an unsubscribed false result.
     * @returns True only while that exact model row id belongs to an open operation.
     */
    pending(id: string | null | undefined): boolean;
    /** Return whether one row id belongs to a retained failed optimistic operation. */
    failed(id: string | null | undefined): boolean;
    /**
     * Reactive partial of stored fields currently owned by still-pending optimistic patch operations
     * on this row - the local changes not yet confirmed by the server. `undefined` when none are
     * pending (and for nullish ids, without subscribing). When several pending patches touch the
     * same field, the later operation wins. Identity stays stable while the unsynced values remain
     * shallow-equal.
     */
    unsyncedChanges(id: string | null | undefined): Partial<TStored> | undefined;
    /** Read one field from one row. */
    field<K extends keyof TStored>(id: string | null | undefined, field: K): TStored[K] | undefined;
    /** Read one row or a shallow-gated projection; selector identity may change without becoming a dependency. */
    find<TProjection extends Record<string, unknown>>(
      id: string | null | undefined,
      opts: { select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly (keyof TStored & string)[] }
    ): TProjection | undefined;
    find(
      id: string | null | undefined,
      opts?: { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require?: readonly (keyof TStored & string)[] }
    ): TStored | undefined;
    /** Read the first matching row or a shallow-gated projection after ordering and required-field filtering. */
    first<TProjection extends Record<string, unknown>>(
      where: DbWhere<TStored> | null | undefined,
      opts: DbReadOptions<TStored> & { select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly (keyof TStored & string)[] }
    ): TProjection | undefined;
    first(
      where?: DbWhere<TStored> | null,
      opts?: DbReadOptions<TStored> & { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require?: readonly (keyof TStored & string)[] }
    ): TStored | undefined;
    where(where: DbWhere<TStored> | null): ModelReadBuilder<TStored>;
    /**
     * Read only found rows in input-id order with stable projections and a map keyed by each found
     * row's actual stored id. Missing ids are omitted from both `rows` and `byId`; nullish ids return
     * an unsubscribed empty result.
     */
    byIds<TProjection extends Record<string, unknown>>(
      ids: readonly string[] | null | undefined,
      opts: { select: (row: TStored) => TProjection; renderKeys?: never }
    ): { rows: TProjection[]; byId: ReadonlyMap<string, TProjection> };
    byIds(
      ids: readonly string[] | null | undefined,
      opts?: { select?: never; renderKeys?: readonly (keyof TStored & string)[] }
    ): { rows: TStored[]; byId: ReadonlyMap<string, TStored> };
    count(where?: DbWhere<TStored> | null): number;
    /**
     * Read a declared relation reactively. `hasMany` returns the target model's rows (projection
     * options apply); `belongsTo`/`hasOne` return one target row or `undefined` (projection
     * options are ignored). Rows belong to the TARGET model, so the select callback receives a
     * generic record - narrow it to the target stored type at the call site.
     */
    related<TProjection extends Record<string, unknown>>(
      id: string | null | undefined,
      relation: string,
      opts: { select: (row: Record<string, unknown>) => TProjection; renderKeys?: never }
    ): TProjection[];
    related(id: string | null | undefined, relation: string, opts?: { select?: never; renderKeys?: readonly string[] }): unknown;
  };
  /**
   * Seed dev/test rows through one normal journalled apply transaction with automatic membership.
   * Production data flows should use queries, mutations, or ingest instead.
   *
   * @param rows Raw model inputs to normalize and seed.
   * @returns Nothing.
   */
  seed(rows: TInput[]): void;
  scopes: Record<string, ScopeHandle<TStored, Record<string, unknown>, TInput>>;
};

export type RequiredReadUse<TStored extends { id: string; updatedAt?: string | null }, TKey extends keyof TStored & string> = Omit<ModelCore<TStored>['use'], 'find' | 'first'> & {
  find<TProjection extends Record<string, unknown>>(
    id: string | null | undefined,
    opts: { select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly TKey[] }
  ): TProjection | undefined;
  find<K extends TKey>(
    id: string | null | undefined,
    opts: { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require: readonly K[] }
  ): RequiredFields<TStored, K> | undefined;
  find(id: string | null | undefined, opts?: { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require?: never }): TStored | undefined;
  first<TProjection extends Record<string, unknown>>(
    where: DbWhere<TStored> | null | undefined,
    opts: DbReadOptions<TStored> & { select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly TKey[] }
  ): TProjection | undefined;
  first<K extends TKey>(
    where: DbWhere<TStored> | null | undefined,
    opts: DbReadOptions<TStored> & { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require: readonly K[] }
  ): RequiredFields<TStored, K> | undefined;
  first(
    where?: DbWhere<TStored> | null,
    opts?: DbReadOptions<TStored> & { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require?: never }
  ): TStored | undefined;
};

export type QueryScopeSpec<TStored extends { id: string }> = {
  /** Reusable local predicate fragment for this named read. */
  where: DbWhere<TStored>;
  /** Optional explicit order; without it the read falls back to the model defaultOrder like any builder. */
  orderBy?: ReadOrder<TStored>;
  /** Optional leading-rows limit. */
  limit?: number;
};

export type QueryScopeReads<TStored extends { id: string }, TQueryScopeNames extends string> = {
  [K in TQueryScopeNames]: (extra?: DbWhere<TStored>) => ModelReadBuilder<TStored>;
};

export type ModelConfig<
  TFields extends ModelFieldSpecs,
  TScopeNames extends string,
  TExt extends Record<string, unknown>,
  TQueryScopeNames extends string = never
> = {
  /** Unique model id. Namespaces storage keys, dependency tracking, and cross-model relation targets. */
  id: string;
  /** Human-readable model name; prefixes normalize/apply error and log messages. */
  name: string;
  /** Field spec map (built with `f.*`) that drives normalize/build reads for every stored field. */
  fields: TFields;
  /**
   * Named reusable predicate reads: each entry appears as `model.use.<name>(extra?)` returning the
   * standard read builder with the fragment's `where` (composed with `extra` via `and`), optional
   * `orderBy`, and optional `limit` pre-applied. A name colliding with a built-in `use` key throws
   * at define time. Distinct from membership `scopes`: queryScopes are local predicates, not
   * server-order membership indexes.
   */
  queryScopes?: { [K in TQueryScopeNames]: QueryScopeSpec<InferStoredFields<TFields>> };
  /**
   * Implicit ordering for reads that declare no explicit order: `where` without `opts.orderBy`,
   * `use.first` without `opts.orderBy`, and `use.where(...)` builders without `.orderBy(...)`.
   * An explicit order fully replaces it. Without `defaultOrder`, unordered reads keep natural
   * storage order. Ties break by the implicit locale-independent id key as usual.
   */
  defaultOrder?: ReadOrder<InferStoredFields<TFields>>;
  /**
   * Derive the row id from raw input. Defaults to `input.id`. The ID field codec converts supported
   * transport scalar representations to a stored string; unreadable values make `normalize` throw
   * `${name} requires id` for that input, which
   * plan-building paths (writes, apply) catch and log as a rejected row, and direct `build`/
   * `normalize` calls propagate to the caller.
   */
  rowId?: (input: unknown) => unknown;
  /**
   * Row-level filter run before id resolution. Return `false` to reject the input; `normalize` then
   * throws `${name} rejected input`, handled the same way as an unresolved `rowId` (see above).
   */
  guard?: (input: unknown) => boolean;
  /**
   * Lazily-evaluated relation declarations built with `belongsTo`/`hasMany`/`hasOne`/`references`.
   * Evaluated once on first access and cached, so relation targets that reference other models defined
   * later in the same module do not need to exist yet at `defineModel` call time.
   */
  relations?: () => Record<string, RelationDecl>;
  /**
   * Named `ScopeSpec` definitions (plain object literals). Each entry becomes a `model.scopes.<name>`
   * handle exposing scoped `use`/`useWindow`/`useCount`/`invalidate`/`read` and, for scopes with `by`,
   * automatic membership tracking as rows are written.
   */
  scopes?: { [K in TScopeNames]: ScopeSpec<InferStoredFields<TFields>> };
  /** Boot maintenance declarations. Temp-row cleanup at boot is handled by the replay orphan sweep and needs no maintenance entry. */
  maintenance?: {
    /** Opt-in age limit for unresolved temp-id rows. Pending operations remain protected. */
    dropTempRowsAfterMs?: number;
    /** Runtime source of temp ids protected from unresolved-row cleanup. */
    protectTempRows?: () => ReadonlySet<string> | readonly string[];
    maxRowsPerScope?: Array<{
      scopeField: keyof InferStoredFields<TFields> & string;
      limit: number;
      compare: (left: InferStoredFields<TFields>, right: InferStoredFields<TFields>) => number;
      /** Evaluated at run time - may read OTHER models. */ protect?: () => (row: InferStoredFields<TFields>) => boolean;
    }>;
  };
  write?: {
    /**
     * Closed field-group policies. Fields outside groups use server values. `monotonic` defaults to
     * snapshot/event only, and replace remains authoritative.
     */
    groups?: Array<{
      fields: readonly (keyof InferStoredFields<TFields> & string)[];
      policy: WritePolicy | readonly WritePolicy[];
    }>;
  };
  /**
   * Build extra static members merged onto the returned model (e.g. singleton statics, custom finders).
   * Receives the base `ModelCore` so statics can call back into `find`/`update`/`use`/etc. Throws at
   * `defineModel` time if any returned key collides with a base model key.
   */
  statics?: (model: ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>) => TExt;
};

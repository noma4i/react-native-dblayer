import type { DbGraphQLDocument, DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import type { RelationDecl } from '../core/relations';
import type { ProjectionOptions } from '../read/projectionGate';
import type { KeepPreviousOption } from '../read/scopeRetention';
import type { defineMutation, MutationConfig } from '../dsl/defineMutation';
import type { DetachedOperationConfig, DetachedOperationHandle } from '../dsl/defineDetachedOperation';
import type { EnsuredRowQueryHandle, QueryHandle } from '../dsl/defineQuery';
import type { defineQuery } from '../dsl/defineQuery';
import type { defineFetch } from '../dsl/defineFetch';
import type { ViewConfig, ViewHandle } from '../dsl/defineView';
import type { ModelIngestEntry } from '../dsl/defineIngest';
import type { DbSubscriptionEntry } from '../core/subscriptionRuntime';
import type { ModelReadBuilder, RequiredFields } from '../dsl/readBuilder';
import type { ScopeSpec } from '../dsl/scope';
import type { InferBuildInput, InferStoredFields } from '../schema/infer';
import type { ModelStatusPoller } from '../utils/modelStatusPoller';
import type { WritePolicy } from '../core/writePolicies';
import type { ModelContext } from '../dsl/modelContext';
import type { JournalOp } from '../core/apply/journal';

/** Row shape every model read path narrows to before projection. */
export type StoredRowShape = { id: string } & Record<string, unknown>;

/** Declarative sort for a scope: by field, or by a consumer comparator with the fields it reads. */
export type ScopeSortSpec<TRow> = { field: keyof TRow & string; dir: 'asc' | 'desc' } | { comparator: (a: TRow, b: TRow) => number; orderFields?: ReadonlyArray<keyof TRow & string> };

export type ScopeValueOf<TScope> = TScope extends ScopeSpec<infer _TStored> ? Record<string, unknown> : never;

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

/** Manual injection surface for a query's colocated live entries. */
export type LiveQueryHandle = {
  /** Inject a payload into the same guarded pipeline transport events use for this query's live entries. */
  apply(event: string, payload: unknown): void;
};

export type ModelQueryConfig<TResponse, TVars, TScope, TStored> = Omit<Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0], 'key' | 'into'> & {
  key?: string;
  into?: Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0]['into'];
  /** Colocated live subscription entries, delivered through the model ingest pipeline while readers are mounted. */
  live?: Record<string, ModelIngestEntry>;
};
export type ModelMutationConfig<TData, TInput, TStored extends { id: string }, TNode> = Omit<MutationConfig<TData, TInput, TStored, TNode>, 'dedupe'> & {
  dedupe?: false | MutationConfig<TData, TInput, TStored, TNode>['dedupe'];
};
export type ModelFetchConfig<TData, TInput, TSelected> = Omit<Parameters<typeof defineFetch<TData, TInput, TSelected>>[0], 'key'> & { key?: string };

export type ModelDefinitions<TStored extends { id: string; updatedAt?: string | null }, TInput> = Pick<
  ModelCore<TStored, TInput>,
  'query' | 'mutation' | 'detached' | 'fetch' | 'view' | 'poller' | 'ingest'
>;

export type ModelDefinitionsOptions<TStored extends { id: string; updatedAt?: string | null }, TInput> = {
  modelId: string;
  context: ModelContext<TStored>;
};

export type ModelSchemaRegistrationOptions<TStored extends { id: string } & Record<string, unknown>> = {
  modelId: string;
  modelName: string;
  fields: ModelFieldSpecs;
  scopes: Record<string, ScopeSpec<TStored>> | undefined;
  gc: 'exempt' | undefined;
  dropIdleScopesAfterMs: number | undefined;
  context: ModelContext<TStored>;
};

export type ModelRuntimeRegistrationOptions<TStored extends { id: string; updatedAt?: string | null } & Record<string, unknown>, TInput> = {
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
  applySnapshot(ops: JournalOp[]): void;
  planRows(rows: unknown[]): JournalOp[];
  planReplace(oldId: string, next: unknown): JournalOp[];
  captureMembership(id: string): Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>;
  planRestore(next: unknown, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[];
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
  /** Define a model-owned scope query with colocated live subscription entries; point materialization is unavailable for scope destinations. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow> & { into: ScopeHandle<TRow, TScope>; live: Record<string, ModelIngestEntry> }
  ): QueryHandle<TRow, TScope> & { live: LiveQueryHandle };
  /** Define a model-owned scope query; point materialization is unavailable for scope destinations. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow> & { into: ScopeHandle<TRow, TScope> }
  ): QueryHandle<TRow, TScope>;
  /** Define a model-owned query with colocated live subscription entries; the returned handle adds `live.apply`. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow> & { live: Record<string, ModelIngestEntry> }
  ): EnsuredRowQueryHandle<TRow, TScope> & { live: LiveQueryHandle };
  /** Define a model-owned query with a conventional `<modelId>:<name>` key and this model as the default destination. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(name: string, config: ModelQueryConfig<TResponse, TVars, TScope, TRow>): EnsuredRowQueryHandle<TRow, TScope>;
  /** Define a model-owned mutation with a conventional input-sensitive in-flight guard; pass `dedupe: false` to opt out or `once: true` to retain committed keys. */
  mutation<TData, TInput, TRow extends { id: string }, TNode>(
    name: string,
    config: ModelMutationConfig<TData, TInput, TRow, TNode>
  ): ReturnType<typeof defineMutation<TData, TInput, TRow, TNode>>;
  /** Define a durable operation whose consumer-owned executor resumes through the core boot lifecycle. */
  detached<TInput>(kind: string, config: DetachedOperationConfig<TInput, TStored>): DetachedOperationHandle<TInput, TStored>;
  /** Define a reactive joined projection over one declared scope and its current related rows. */
  view<TItem = TStored & Record<string, unknown>, TIncluded extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    config: ViewConfig<TStored, TIncluded, TItem>
  ): ViewHandle<TItem, Record<string, unknown>>;
  /** Define an ephemeral model-namespaced fetch with a conventional `<modelId>:<name>` key. */
  fetch<TData, TInput = void, TSelected = TData>(name: string, config: ModelFetchConfig<TData, TInput, TSelected>): ReturnType<typeof defineFetch<TData, TInput, TSelected>>;
  /** Define a refcounted status poller owned by this model; failures log with `<modelId>:<name>`. */
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
  /** Define model-owned subscription entries that apply rows, guards, effects, and custom handlers together. */
  ingest(entries: Record<string, ModelIngestEntry>): { entries: DbSubscriptionEntry[]; apply(key: string, payload: unknown): void };
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
  registerReset(fn: () => void): void;
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
  orderBy?: { field: keyof TStored & string; direction: 'asc' | 'desc' };
  /** Optional leading-rows limit. */
  limit?: number;
};

export type QueryScopeReads<TStored extends { id: string }, TQueryScopes> = {
  [K in keyof TQueryScopes]: (extra?: DbWhere<TStored>) => ModelReadBuilder<TStored>;
};

export type ModelConfig<
  TFields extends ModelFieldSpecs,
  TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>>,
  TExt extends Record<string, unknown>,
  TQueryScopes extends Record<string, QueryScopeSpec<InferStoredFields<TFields>>> = {}
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
  queryScopes?: TQueryScopes;
  /**
   * Implicit ordering for reads that declare no explicit order: `where` without `opts.orderBy`,
   * `use.first` without `opts.orderBy`, and `use.where(...)` builders without `.orderBy(...)`.
   * An explicit order fully replaces it. Without `defaultOrder`, unordered reads keep natural
   * storage order. Ties break by the implicit locale-independent id key as usual.
   */
  defaultOrder?: { field: keyof InferStoredFields<TFields> & string; direction: 'asc' | 'desc' };
  /**
   * Derive the row id from raw input. Defaults to `input.id`. Must return a non-empty string;
   * returning anything else makes `normalize` throw `${name} requires id` for that input, which
   * plan-building paths (writes, apply) catch and log as a rejected row, and direct `build`/
   * `normalize` calls propagate to the caller.
   */
  rowId?: (input: unknown) => string;
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
   * Named `ScopeSpec` definitions (built with `scope(...)`). Each entry becomes a `model.scopes.<name>`
   * handle exposing scoped `use`/`useWindow`/`useCount`/`invalidate`/`read` and, for scopes with `by`,
   * automatic membership tracking as rows are written.
   */
  scopes?: TScopes;
  /** Set to `'exempt'` to keep this model's rows out of garbage-collection sweeps even when unreferenced. */
  gc?: 'exempt';
  /** Boot maintenance declarations. Temp-row cleanup at boot is handled by the replay orphan sweep and needs no maintenance entry. */
  maintenance?: {
    /** Opt-in idle scope collection: unread scopes are removed at the next GC sweep after this duration, then their rows follow normal reachability. */
    dropIdleScopesAfterMs?: number;
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

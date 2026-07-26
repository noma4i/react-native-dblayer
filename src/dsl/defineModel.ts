import type { DbGraphQLDocument, DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import { buildScopeKey, isWhereOperatorValue, matchesDbWhere } from '../core/compileDbWhere';
import { compositeKey } from '../core/serialize';
import type { Dependency } from '../core/apply/commitBus';
import { registerApplyTarget } from '../core/apply/transaction';
import { registerSchemaDeclaration } from '../core/schemaManifest';
import { coldResetModel, CorruptionError } from '../core/recovery';
import { useScopeLiveRows, useScopeLiveWindowRows } from '../core/tanstack/liveScopeReads';
import type { StoredRowShape } from '../core/tanstack/facade';
import { seedCollections } from '../core/tanstack/mirror';
import type { JournalOp } from '../core/apply/journal';
import { registerGcHost } from '../core/gc';
import { createEntityState, type EntityState } from '../core/planes/entityState';
import { createScopeIndex, type ScopeIndex, type ScopeIndexValue } from '../core/planes/scopeIndex';
import { invalidateModel } from '../core/invalidationRegistry';
import { getDbLogger } from '../core/logger';
import { noteReplaceRejected } from '../core/diagnostics';
import { registerRelationHost, type MembershipDelta, type RelationDecl } from '../core/relations';
import { registerReset } from '../core/reset';
import { fieldSpecSparseRead, type FieldSpec } from '../schema/fieldSpec';
import { useLiveRead, arraysShallowEqual, rowsShallowEqual } from '../read/useLiveRead';
import { createProjectionGate, useProjectedLiveRow, useProjectedLiveRows, validateProjectionOptions, type ProjectionOptions } from '../read/projectionGate';
import type { KeepPreviousOption } from '../read/scopeRetention';
import { createModelReadEngine, incrementalSignature, limitRows, sortModelReadRows, useIncrementalRead } from '../read/incrementalReadEngine';
import { getApplyRuntime, getCommitBus, getDbRuntimeConfig, getOperationState, getStoragePrefix, hasReplayedJournal } from './configure';
import { defineFetch } from './defineFetch';
import { clearFailedOptimisticMutation, defineMutation, type MutationConfig } from './defineMutation';
import { defineQuery, type EnsuredRowQueryHandle, type QueryHandle } from './defineQuery';
import { defineModelIngest, registerIngestModel, type ModelIngestEntry } from './defineIngest';
import type { DbSubscriptionEntry } from '../core/subscriptionRuntime';
import { createReadBuilder, type ModelReadBuilder, type ReadOrder } from './readBuilder';
import { hasRequiredFields } from '../read/requireFields';
import type { RequiredFields } from './readBuilder';
import type { ScopeCoverage, ScopeSpec } from './scope';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isRecord, stringifyNullish } from '../utils/normalizeHelpers';
import type { InferBuildInput, InferStoredFields } from '../schema/infer';
import { getDbTransport } from '../core/transport';
import { createModelStatusPoller, type ModelStatusPoller } from '../utils/modelStatusPoller';
import { trimRowsPerScope } from '../utils/runtimePrimitives';
import { registerModelMaintenance, type MaintenanceReport } from './maintenanceRegistry';
import { createDbSubscriptionRuntime } from '../core/subscriptionRuntime';
import { registerInternalModelHandle, registerInternalScopeHandle } from '../core/internalHandles';

const issuedScopeSequenceByKey = new Map<string, number>();

registerReset(() => {
  issuedScopeSequenceByKey.clear();
});

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

type ModelQueryConfig<TResponse, TVars, TScope, TStored> = Omit<Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0], 'key' | 'into'> & {
  key?: string;
  into?: Parameters<typeof defineQuery<TResponse, TVars, TScope, TStored>>[0]['into'];
  /** Colocated live subscription entries, delivered through the model ingest pipeline while readers are mounted. */
  live?: Record<string, ModelIngestEntry>;
};
type ModelMutationConfig<TData, TInput, TStored extends { id: string }, TNode> = Omit<MutationConfig<TData, TInput, TStored, TNode>, 'dedupe'> & {
  dedupe?: false | MutationConfig<TData, TInput, TStored, TNode>['dedupe'];
};
type ModelFetchConfig<TData, TInput, TSelected> = Omit<Parameters<typeof defineFetch<TData, TInput, TSelected>>[0], 'key'> & { key?: string };

/**
 * Reactive access to one named scope of a model (`model.scopes.<name>`), backed by the scope's
 * membership index. `scopeValue` selects the concrete scope instance (e.g. `{ chatId }`); `null`/`undefined`
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

type RequiredReadUse<TStored extends { id: string; updatedAt?: string | null }, TKey extends keyof TStored & string> = Omit<ModelCore<TStored>['use'], 'find' | 'first'> & {
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

type QueryScopeSpec<TStored extends { id: string }> = {
  /** Reusable local predicate fragment for this named read. */
  where: DbWhere<TStored>;
  /** Optional explicit order; without it the read falls back to the model defaultOrder like any builder. */
  orderBy?: { field: keyof TStored & string; direction: 'asc' | 'desc' };
  /** Optional leading-rows limit. */
  limit?: number;
};

type QueryScopeReads<TStored extends { id: string }, TQueryScopes> = {
  [K in keyof TQueryScopes]: (extra?: DbWhere<TStored>) => ModelReadBuilder<TStored>;
};

/** Origin of a write reaching entity apply. */
export type WriteOrigin = 'snapshot' | 'event' | 'replace' | 'patch';

/** Context supplied to model-owned write declarations. `operationId` identifies an internal optimistic method-patch or rollback, which bypasses pending-field overlay; foreign writes omit it and preserve pending owned fields. */
export type WriteCtx = { origin: WriteOrigin; operationId?: string };

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
    maxRowsPerScope?: Array<{
      scopeField: keyof InferStoredFields<TFields> & string;
      limit: number;
      compare: (left: InferStoredFields<TFields>, right: InferStoredFields<TFields>) => number;
      /** Evaluated at run time - may read OTHER models. */ protect?: () => (row: InferStoredFields<TFields>) => boolean;
    }>;
  };
  write?: {
    /**
     * Row-level acceptance when a row with the same id already exists. Return `false` to keep the
     * existing row and drop the incoming write entirely. NOT invoked for origin `'replace'` - identity
     * transition must always happen; field protection on replace comes from groups.
     */
    accept?: (existing: InferStoredFields<TFields>, incoming: InferStoredFields<TFields>, ctx: WriteCtx) => boolean;
    /**
     * Field-group write policies applied to an accepted existing-row write while computing the effective
     * row. A field belongs to at most one group; fields outside groups use the `'server'` default, where
     * incoming values win including explicit null. `'continuity'` keeps current for incoming nullish
     * values but accepts empty strings. `{ monotonic }` keeps every group field when any changed present
     * field fails its predicate. `{ merge }` resolves each present field and keeps current when it returns
     * undefined. Patch groups see only keys present in the sparse patch. New rows bypass write rules.
     */
    groups?: Array<{
      fields: readonly (keyof InferStoredFields<TFields> & string)[];
      policy:
        | 'server'
        | 'continuity'
        | { monotonic: (incoming: Readonly<Partial<InferStoredFields<TFields>>>, current: Readonly<InferStoredFields<TFields>>, ctx: WriteCtx) => boolean }
        | { merge: (current: unknown, incoming: unknown, ctx: WriteCtx) => unknown };
    }>;
  };
  /**
   * Build extra static members merged onto the returned model (e.g. singleton statics, custom finders).
   * Receives the base `ModelCore` so statics can call back into `find`/`update`/`use`/etc. Throws at
   * `defineModel` time if any returned key collides with a base model key.
   */
  statics?: (model: ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>) => TExt;
};

const EMPTY_ROWS: never[] = [];

type SparseModelField = ModelFieldSpecs[string] & { [fieldSpecSparseRead]: (value: unknown, fieldKey: string) => unknown };

const readField = (field: ModelFieldSpecs[string], input: unknown, key: string, complete: boolean): unknown => {
  const value = complete ? field.read(input, key) : (field as SparseModelField)[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

type ScopeSortSpec<TRow> = { field: keyof TRow & string; dir: 'asc' | 'desc' } | { comparator: (a: TRow, b: TRow) => number; orderFields?: ReadonlyArray<keyof TRow & string> };

const sortRowsBySpec = <TRow extends { id: string }>(rows: TRow[], sort: ScopeSortSpec<TRow>): TRow[] =>
  'comparator' in sort ? [...rows].sort(sort.comparator) : sortModelReadRows(rows, [{ field: String(sort.field), direction: sort.dir }]);

const matchesMemberPredicate = <TRow,>(spec: { member?: (row: TRow) => boolean } | undefined, row: TRow): boolean => spec?.member?.(row) ?? true;

/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export const defineModel = <
  const TFields extends ModelFieldSpecs,
  TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>> = {},
  TExt extends Record<string, unknown> = {},
  TQueryScopes extends Record<string, QueryScopeSpec<InferStoredFields<TFields>>> = {}
>(
  config: ModelConfig<TFields, TScopes, TExt, TQueryScopes>
): Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, 'use' | 'scopes'> & {
  use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
  scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>> };
} & TExt => {
  type Stored = InferStoredFields<TFields> & Record<string, unknown>;
  type Input = InferBuildInput<TFields>;
  type ModelPlanes = { entityState: EntityState<Stored>; scopeIndex: ScopeIndex };
  const applyWriteGate = (() => {
    if (!config.write) return undefined;
    const groups = config.write?.groups;
    if (groups && groups.length === 0) throw new Error(`${config.name} write groups must not be empty`);
    const declaredFields = new Set(Object.keys(config.fields));
    const groupedFields = new Set<string>();
    for (const group of groups ?? []) {
      if (group.fields.length === 0) throw new Error(`${config.name} write groups must not be empty`);
      for (const field of group.fields) {
        if (!declaredFields.has(field)) throw new Error(`${config.name} write field ${field} is not declared`);
        if (groupedFields.has(field)) throw new Error(`${config.name} write field ${field} appears in more than one group`);
        groupedFields.add(field);
      }
    }
    return (previous: Stored, incoming: Stored, ctx: WriteCtx): Stored | null => {
      if (ctx.origin !== 'replace' && config.write?.accept && !config.write.accept(previous, incoming, ctx)) return null;
      let effective: Stored = { ...previous, ...incoming };
      for (const group of groups ?? []) {
        if (group.policy === 'server') continue;
        if (group.policy === 'continuity') {
          for (const field of group.fields) if (field in incoming && (incoming[field] === undefined || incoming[field] === null)) effective[field] = previous[field];
          continue;
        }
        if ('monotonic' in group.policy) {
          const changed = group.fields.some(field => field in incoming && !Object.is(incoming[field], previous[field]));
          if (changed && !group.policy.monotonic(incoming, previous, ctx)) {
            for (const field of group.fields) effective[field] = previous[field];
          }
          continue;
        }
        for (const field of group.fields) {
          if (!(field in incoming)) continue;
          const value = group.policy.merge(previous[field], incoming[field], ctx);
          if (value === undefined) (effective as Record<string, unknown>)[field] = previous[field];
          else (effective as Record<string, unknown>)[field] = value;
        }
      }
      return effective;
    };
  })();
  let planesRef: ModelPlanes | null = null;
  let revision = 0;
  /** Planes are created and hydrated on first touch, so models can be defined before configureDb. */
  const planes = (): ModelPlanes => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const entityState = createEntityState<Stored>({
      modelId: config.id,
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: getStoragePrefix,
      applyWriteGate,
      ownedFields: (rowId, operationId) => getOperationState().ownedFields(config.id, rowId, operationId)
    });
    const scopeIndex = createScopeIndex({ modelId: config.id, scopeNames: Object.keys(config.scopes ?? {}), storage: runtime.storage, prefix: getStoragePrefix });
    try {
      entityState.hydrate();
      scopeIndex.hydrate();
    } catch (error) {
      if (!(error instanceof CorruptionError)) throw error;
      coldResetModel(runtime.storage, getStoragePrefix(), config.id);
      getDbLogger().error('cold-model recovery', { model: config.id, keyClass: error.keyClass, key: error.storageKey });
      entityState.hydrate();
      scopeIndex.hydrate();
    }
    planesRef = { entityState, scopeIndex };
    return planesRef;
  };

  const normalize = (input: unknown, complete = false): Stored => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = stringifyNullish(config.rowId?.(input) ?? (isRecord(input) ? input.id : undefined));
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${config.name} requires id`);
    const output: Record<string, unknown> = { id };
    for (const [key, field] of Object.entries(config.fields)) {
      const value = readField(field, input, key, complete);
      if (value !== undefined) output[key] = value;
    }
    return output as Stored;
  };

  /** Plan-build validation: raw rows stay in the op (normalize is shape-sensitive); invalid rows drop here. */
  const isPlanRow = (value: unknown): boolean => {
    try {
      normalize(value);
      return true;
    } catch (error) {
      getDbLogger().error(`[${config.name}] plan row rejected`, { error });
      return false;
    }
  };

  let relationCache: Record<string, RelationDecl> | null = null;
  const resolvedRelations = (): Record<string, RelationDecl> => (relationCache ??= config.relations?.() ?? {});

  const membershipScopes = Object.entries(config.scopes ?? {}).flatMap(([name, spec]) => (spec.by ? [[name, { ...spec, by: spec.by }] as const] : []));

  const scopeValueFromRow = (by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null => {
    const value: Record<string, unknown> = {};
    for (const [scopeField, rowField] of Object.entries(by)) {
      const fieldSpec = config.fields[rowField];
      const fieldValue = fieldSpec?.derived === true && row[rowField] !== undefined ? row[rowField] : fieldSpec ? readField(fieldSpec, row, rowField, false) : row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const scopeByFieldMap = new Map(membershipScopes.map(([name, spec]) => [name, spec.by] as const));
  const coerceScopeValueForKey = (scopeName: string, scopeValue: unknown): unknown => {
    if (!isRecord(scopeValue)) return scopeValue;
    const by = scopeByFieldMap.get(scopeName);
    if (!by) return scopeValue;
    const out: Record<string, unknown> = {};
    for (const [scopeField, raw] of Object.entries(scopeValue)) {
      const rowField = by[scopeField];
      const fieldSpec = rowField ? config.fields[rowField] : undefined;
      out[scopeField] = fieldSpec && !fieldSpec.derived && raw !== undefined && raw !== null ? fieldSpec.readValue(raw) : raw;
    }
    return out;
  };
  const keyForScope = (scopeName: string, scopeValue: unknown): string => {
    const by = scopeByFieldMap.get(scopeName);
    if (by && scopeValue !== null) {
      for (const field of Object.keys(by)) {
        if (!isRecord(scopeValue) || scopeValue[field] === undefined) throw new Error(`${config.name}.${scopeName}: scope value must provide ${field}`);
      }
    }
    return `${scopeName}:${buildScopeKey(coerceScopeValueForKey(scopeName, scopeValue))}`;
  };
  const criteriaCache = new WeakMap<object, DbWhere<Stored>>();
  const normalizeCriteria = (where: DbWhere<Stored>): DbWhere<Stored> => {
    if (typeof where !== 'object' || where === null || Array.isArray(where)) return where;
    const record = where as Record<string, unknown>;
    if ('and' in record) return { and: (record.and as Array<DbWhere<Stored>>).map(normalizeCriteria) } as DbWhere<Stored>;
    if ('or' in record) return { or: (record.or as Array<DbWhere<Stored>>).map(normalizeCriteria) } as DbWhere<Stored>;
    if ('not' in record) return { not: normalizeCriteria(record.not as DbWhere<Stored>) } as DbWhere<Stored>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const fieldSpec = config.fields[key];
      const normalizeOperand = (operand: unknown): unknown => {
        if (operand === undefined || operand === null) return operand;
        if (key === 'id') return stringifyNullish(operand);
        const normalized = fieldSpec ? fieldSpec.readValue(operand) : undefined;
        return normalized === undefined || normalized === null ? operand : normalized;
      };
      if (isWhereOperatorValue(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([operator, operand]) => [operator, Array.isArray(operand) ? operand.map(normalizeOperand) : normalizeOperand(operand)])
        );
        continue;
      }
      out[key] = normalizeOperand(value);
    }
    return out as DbWhere<Stored>;
  };
  const matchesCriteria = (row: Stored, where: DbWhere<Stored>): boolean => {
    if (typeof where !== 'object' || where === null) return matchesDbWhere(row, where);
    let normalized = criteriaCache.get(where);
    if (!normalized) {
      normalized = normalizeCriteria(where);
      criteriaCache.set(where, normalized);
    }
    return matchesDbWhere(row, normalized);
  };

  const isScopeMember = (scopeKey: string, id: string): boolean => planes().scopeIndex.has(scopeKey, id);

  /** Declarative membership: an event row joins/leaves its `by` scopes inside the SAME plan. */
  const membershipForUpsert = (before: Stored | undefined, after: Record<string, unknown>): MembershipDelta[] => {
    const id = String(after.id);
    const deltas: MembershipDelta[] = [];
    for (const [scopeName, spec] of membershipScopes) {
      const beforeValue = before && matchesMemberPredicate<Stored>(spec, before) ? scopeValueFromRow(spec.by, before) : null;
      const afterValue = matchesMemberPredicate<Stored>(spec, after as Stored) ? scopeValueFromRow(spec.by, after) : null;
      const beforeKey = beforeValue ? keyForScope(scopeName, beforeValue) : null;
      const afterKey = afterValue ? keyForScope(scopeName, afterValue) : null;
      if (beforeKey && beforeKey !== afterKey && isScopeMember(beforeKey, id)) deltas.push({ scopeKey: beforeKey, detach: [id] });
      if (afterKey && !isScopeMember(afterKey, id)) deltas.push({ scopeKey: afterKey, append: [id] });
    }
    return deltas;
  };

  const detachForDestroy = (id: string): MembershipDelta[] =>
    planes()
      .scopeIndex.keysOf(id)
      .map(scopeKey => ({ scopeKey, detach: [id] }));

  registerRelationHost(config.id, {
    relations: resolvedRelations,
    has: id => planes().entityState.read(id) !== undefined,
    read: id => planes().entityState.read(id),
    normalize: input => {
      try {
        return normalize(input);
      } catch {
        return null;
      }
    },
    membershipForUpsert,
    detachForDestroy
  });

  const writeRows = (rows: unknown[], origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: Stored, operationId?: string): Array<{ id: string; changedFields: string[] | null }> => {
    const changes: Array<{ id: string; changedFields: string[] | null }> = [];
    for (const value of rows) {
      let incoming: Stored;
      try {
        incoming = normalize(value);
      } catch (error) {
        getDbLogger().error(`[${config.name}] apply row rejected`, { error });
        continue;
      }
      if (origin === undefined && planes().entityState.isTombstoned(incoming.id)) continue;
      const current = planes().entityState.read(incoming.id);
      let gatedIncoming: Stored = config.write ? incoming : { ...current, ...incoming };
      const result = planes().entityState.upsert(gatedIncoming, { mergeBase: origin === 'replace' ? mergeBase : undefined, ctx: { origin: origin ?? 'snapshot', operationId } });
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({ id: incoming.id, changedFields: result.changedFields });
    }
    if (changes.length > 0) revision += 1;
    return changes;
  };

  const applyTarget = {
    readRow: (id: string): Record<string, unknown> | undefined => planes().entityState.read(id),
    readAllRows: (): Array<Record<string, unknown>> => planes().entityState.values(),
    readScopeOrder: (scopeKey: string): string[] => {
      const separator = scopeKey.indexOf(`:`);
      const scopeName = separator < 0 ? scopeKey : scopeKey.slice(0, separator);
      const rawValue = separator < 0 ? `{}` : scopeKey.slice(separator + 1);
      try {
        return scopeSortedRows(scopeName, JSON.parse(rawValue)).map(row => String(row.id));
      } catch {
        return planes()
          .scopeIndex.read(scopeKey)
          .entries.map(entry => entry.id);
      }
    },
    readScopeEntries: (scopeKey: string): Array<{ id: string; order: number }> => planes().scopeIndex.read(scopeKey).entries,
    readScopeOrderRevision: (scopeKey: string): number => planes().scopeIndex.orderRevision(scopeKey),
    scopeOrderAffected: (scopeKey: string, id: string, fields: string[] | null): boolean => {
      if (fields === null || !planes().scopeIndex.has(scopeKey, id)) return true;
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`:`));
      const spec = (config.scopes as Record<string, ScopeSpec<Stored>> | undefined)?.[scopeName];
      if (!spec) return false;
      const relevant = new Set<string>(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== 'server-order' && 'field' in spec.sort) relevant.add(String(spec.sort.field));
      if (spec.sort && spec.sort !== 'server-order' && 'comparator' in spec.sort) {
        if (spec.sort.orderFields === undefined) return true;
        for (const field of spec.sort.orderFields) relevant.add(field);
      }
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: (scopeKey: string) => {
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`:`));
      const sort = (config.scopes as Record<string, ScopeSpec<Stored>> | undefined)?.[scopeName]?.sort;
      if (!sort || sort === 'server-order') return { kind: 'server-order' as const };
      if ('comparator' in sort) return { kind: 'comparator' as const };
      return { kind: 'field' as const, field: String(sort.field), dir: sort.dir };
    },
    readAllScopeKeys: (): string[] => planes().scopeIndex.keys(),
    upsert: writeRows,
    patch: (id: string, patch: Record<string, unknown>, operationId?: string): { id: string; changedFields: string[] | null } | null => {
      const key = String(id);
      const current = planes().entityState.read(key);
      if (!current) return null;
      const row = (config.write ? { ...patch, id: key } : { ...current, ...patch, id: key }) as Stored;
      const result = planes().entityState.upsert(row, { ctx: { origin: 'patch', operationId } });
      if (result.changedFields !== null && result.changedFields.length === 0) return null;
      revision += 1;
      return { id: key, changedFields: result.changedFields };
    },
    destroy: (ids: string[], tombstone?: boolean): string[] => {
      const removed: string[] = [];
      for (const id of ids) {
        const key = String(id);
        const existed = planes().entityState.read(key) !== undefined;
        planes().entityState.destroy(key, { tombstone });
        if (existed) removed.push(key);
      }
      if (removed.length > 0) revision += 1;
      return removed;
    },
    counter: (id: string, field: string, delta: number, next?: number): boolean => {
      const key = String(id);
      const row = planes().entityState.read(key);
      if (!row) return false;
      const result = planes().entityState.upsert({ ...row, id: key, [field]: next ?? ((row[field] as number | undefined) ?? 0) + delta });
      if (result.changedFields !== null && result.changedFields.length === 0) return false;
      revision += 1;
      return true;
    },
    counterValue: (id: string, field: string): number | null => {
      const value = planes().entityState.read(id)?.[field];
      return typeof value === 'number' ? value : value == null ? null : Number(value);
    },
    scope: (scopeKey: string, next: unknown): void => {
      planes().scopeIndex.write(scopeKey, next as ScopeIndexValue);
    },
    scopeDelta: (scopeKey: string, delta: { append: Array<{ id: string; edge?: Record<string, unknown>; order?: number }>; detach: string[] }): void => {
      if (delta.detach.length > 0) planes().scopeIndex.detach(scopeKey, delta.detach);
      if (delta.append.length > 0) planes().scopeIndex.reconcile(scopeKey, 'delta', delta.append);
    },
    reactiveScopes: (ids: string[]) => planes().scopeIndex.touchMembers(ids),
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()],
    ackPersist: () => {
      planes().entityState.ackPersist();
      planes().scopeIndex.ackPersist();
    }
  };
  registerApplyTarget(config.id, applyTarget);
  registerSchemaDeclaration({
    id: config.id,
    name: config.name,
    fields: Object.fromEntries(Object.entries(config.fields).map(([name, field]) => [name, { kind: field.kind, mode: field.mode, hasDefault: field.hasDefault }])),
    scopes: Object.fromEntries(
      Object.entries(config.scopes ?? {}).map(([name, spec]) => {
        const by = spec.by ? Object.fromEntries(Object.entries(spec.by).map(([scopeField, rowField]) => [scopeField, String(rowField)])) : null;
        const sort = spec.member ? 'member' : !spec.sort || spec.sort === 'server-order' ? 'server-order' : 'field' in spec.sort ? `field:${String(spec.sort.field)}:${spec.sort.dir}` : 'comparator';
        return [name, { by, sort }];
      })
    )
  });
  if (hasReplayedJournal()) seedCollections([config.id]);
  registerGcHost(config.id, {
    modelId: config.id,
    exempt: config.gc === 'exempt',
    rowIds: () =>
      planes()
        .entityState.values()
        .map(row => String(row.id)),
    hasRow: id => planes().entityState.read(id) !== undefined,
    scopeKeys: () => planes().scopeIndex.keys(),
    scopeEntryIds: key =>
      planes()
        .scopeIndex.read(key)
        .entries.map(entry => entry.id),
    detachScopeEntries: (key, ids) => {
      planes().scopeIndex.detach(key, ids);
    },
    scopeEntryCount: key => planes().scopeIndex.read(key).entries.length,
    removeScope: key => {
      planes().scopeIndex.remove(key);
    },
    idleScopeAfterMs: () => config.maintenance?.dropIdleScopesAfterMs,
    scopeLastAccess: key => planes().scopeIndex.lastAccess(key),
    evict: id => planes().entityState.evict(id),
    referencesOf: id => {
      const row = planes().entityState.read(id);
      if (!row) return [];
      const out: Array<{ model: string; id: string }> = [];
      for (const relation of Object.values(resolvedRelations())) {
        if (relation.kind === 'belongsTo') {
          const value = row[relation.foreignKey];
          if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
        }
        if (relation.kind === 'references') {
          const raw = relation.ids(row);
          const list = Array.isArray(raw) ? raw : [raw];
          for (const value of list) {
            if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
          }
        }
      }
      return out;
    }
  });

  /** Snapshot writes (query pages / entity refreshes) apply verbatim - server state is derived already. */
  const applySnapshot = (ops: JournalOp[]): void => {
    getApplyRuntime().apply(ops);
  };

  /** Imperative/domain writes are events; relation effects derive from rows accepted by apply. */
  const applyEvent = (ops: JournalOp[]): void => {
    getApplyRuntime().apply(ops.map(op => (op.kind === 'upsert' && op.origin === undefined ? { kind: 'upsert' as const, model: op.model, rows: op.rows, origin: 'event' as const } : op)));
  };

  const scopeSortedRows = (scopeName: string, scopeValue: unknown): Stored[] => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<Stored>>)[scopeName];
    const value = planes().scopeIndex.read(keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter((row): row is Stored => row !== undefined);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    return sortRowsBySpec(rows, spec.sort);
  };

  const rowDep = (id: string, fields?: ReadonlyArray<string>): Dependency => ({ kind: 'row', model: config.id, id, ...(fields ? { fields } : {}) });
  const modelDep: Dependency = { kind: 'model', model: config.id };
  const scopeDep = (scopeKey: string): Dependency => ({ kind: 'scope', model: config.id, scopeKey });
  const memberDeps = (scopeKey: string): Dependency[] => [scopeDep(scopeKey)];
  const useScopeAccess = (scopeKey: string | null): void => {
    useEffect(() => {
      if (scopeKey != null) planes().scopeIndex.noteAccess(scopeKey);
    }, [scopeKey]);
  };

  function whereRead(where: DbWhere<Stored> | null): ModelReadBuilder<Stored> {
    const defaultOrders: ReadonlyArray<ReadOrder<Stored>> = config.defaultOrder ? [config.defaultOrder] : [];
    return createReadBuilder(where, {
      rows: <TOutput extends Record<string, unknown>>(
        criteria: DbWhere<Stored> | null,
        orders: readonly ReadOrder<Stored>[],
        limit: number | undefined,
        required: readonly string[],
        projection: ProjectionOptions<Stored, TOutput>
      ): TOutput[] => {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        validateProjectionOptions(projection, `${config.id}.use.where`);
        const projectionRef = useRef(projection);
        const gateRef = useRef(createProjectionGate<Stored, TOutput>());
        projectionRef.current = projection;
        const signature = incrementalSignature('where-builder', config.id, buildScopeKey({ criteria, orders: effectiveOrders, limit, required }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine({
              signature,
              model: config.id,
              where: row => criteria != null && matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              options: { orderBy: effectiveOrders as ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => gateRef.current.projectRows(rows, projectionRef.current),
              isEqual: arraysShallowEqual
            })
        });
      },
      pluck: (criteria, orders, limit, required, projection, field) => {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        const projectionRef = useRef(projection);
        projectionRef.current = projection;
        const signature = incrementalSignature('where-pluck', config.id, buildScopeKey({ criteria, orders: effectiveOrders, limit, required, field }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine<Stored, unknown[]>({
              signature,
              model: config.id,
              where: row => criteria != null && matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              options: { orderBy: effectiveOrders as ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => {
                const selector = projectionRef.current.select;
                const projected: readonly object[] = selector ? rows.map(row => selector(row)) : rows;
                return projected.map(row => Reflect.get(row, field));
              },
              isEqual: arraysShallowEqual
            })
        });
      },
      exists: (criteria, required) => {
        const signature = incrementalSignature('where-exists', config.id, buildScopeKey({ criteria, required }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine<Stored, boolean>({
              signature,
              model: config.id,
              where: row => criteria != null && matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: (_rows, count) => count > 0,
              countOnly: true
            })
        });
      }
    });
  }

  const makeScopeHandle = (scopeName: string): ScopeHandle<Stored, Record<string, unknown>, Input> => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<Stored>>)[scopeName];
    const planScope = (
      scopeKey: string,
      liveRows: Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      opts?: { resetOrder?: boolean }
    ): JournalOp => {
      let { next } = planes().scopeIndex.reconcileNext(
        scopeKey,
        coverage,
        liveRows.map(({ row, edge }) => ({ id: String(row.id), edge })),
        opts
      );
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (opts?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        if (spec.sort && spec.sort !== 'server-order') {
          const scopeSort = spec.sort;
          const incomingById = new Map(
            liveRows.flatMap(({ row }) => {
              try {
                const stored = normalize(row);
                return [[String(stored.id), stored] as const];
              } catch {
                return [];
              }
            })
          );
          const rowsById = new Map(
            next.entries.flatMap(entry => {
              const row = incomingById.get(entry.id) ?? planes().entityState.read(entry.id);
              return row ? [[entry.id, row] as const] : [];
            })
          );
          const ordered = sortRowsBySpec([...rowsById.values()], scopeSort);
          const positions = new Map(ordered.map((row, index) => [String(row.id), index]));
          next = {
            ...next,
            entries: [...next.entries].sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER))
          };
        }
        next = planes().scopeIndex.trimValue(next, maxRows).next;
      }
      return { kind: 'scope', model: config.id, scopeKey, next };
    };
    const planApply = (
      scopeValue: unknown,
      rows: Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      opts?: { resetOrder?: boolean }
    ): JournalOp[] => {
      const liveRows = rows.filter(({ row }) => isPlanRow(row)).filter(({ row }) => !planes().entityState.isTombstoned(String(row.id)));
      const requestedScopeKey = keyForScope(scopeName, scopeValue);
      const upsert: JournalOp = { kind: 'upsert', model: config.id, rows: liveRows.map(({ row }) => row) };
      if (!spec?.by) return [upsert, planScope(requestedScopeKey, liveRows, coverage, opts)];

      const rowsByScope = new Map<string, Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>>();
      for (const entry of liveRows) {
        if (!matchesMemberPredicate<Stored>(spec, entry.row as Stored)) continue;
        const derivedValue = scopeValueFromRow(spec.by, entry.row);
        if (!derivedValue) continue;
        const derivedKey = keyForScope(scopeName, derivedValue);
        const group = rowsByScope.get(derivedKey) ?? [];
        group.push(entry);
        rowsByScope.set(derivedKey, group);
      }
      const requestedRows = rowsByScope.get(requestedScopeKey) ?? [];
      rowsByScope.delete(requestedScopeKey);
      return [upsert, planScope(requestedScopeKey, requestedRows, coverage, opts), ...[...rowsByScope].map(([scopeKey, scopeRows]) => planScope(scopeKey, scopeRows, 'delta'))];
    };
    const readScopeRows = (scopeValue: unknown, options: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
      const scopeKey = scopeValue === null ? null : keyForScope(scopeName, scopeValue);
      useScopeAccess(scopeKey);
      return useScopeLiveRows(
        config.id,
        scopeKey,
        applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`),
        () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0,
        options
      );
    };
    const scopeHandle = {
      modelId: config.id,
      use: readScopeRows,
      useFirst: (scopeValue: unknown, options: { renderKeys?: readonly string[] } & KeepPreviousOption = {}) =>
        readScopeRows(scopeValue, options as ProjectionOptions<StoredRowShape, Record<string, unknown>>)[0],
      useWindow: (scopeValue: unknown, options: { pageSize?: number; keepPrevious?: boolean } & ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
        const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue === null ? null : keyForScope(scopeName, scopeValue);
        const windowStateRef = useRef({ scopeKey, size: pageSize });
        const [, setWindowRevision] = useState(0);
        if (windowStateRef.current.scopeKey !== scopeKey) windowStateRef.current = { scopeKey, size: pageSize };
        const windowSize = windowStateRef.current.size;
        useScopeAccess(scopeKey);
        const window = useScopeLiveWindowRows(
          config.id,
          scopeKey,
          applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`),
          windowSize,
          () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0,
          options
        );
        return {
          rows: window.rows,
          totalCount: window.totalCount,
          hasMore: window.totalCount > windowSize,
          isPreviousData: window.isPreviousData,
          resolved: window.resolved,
          fetchNextPage: () => {
            windowStateRef.current =
              windowStateRef.current.scopeKey === scopeKey ? { ...windowStateRef.current, size: windowStateRef.current.size + pageSize } : { scopeKey, size: pageSize + pageSize };
            setWindowRevision(current => current + 1);
          }
        };
      },
      useCount: (scopeValue: unknown) => {
        const scopeKey = scopeValue === null ? null : keyForScope(scopeName, scopeValue);
        useScopeAccess(scopeKey);
        return useLiveRead(
          () => (scopeValue === null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length),
          scopeKey == null ? [] : [scopeDep(scopeKey)]
        );
      },
      invalidate: (scopeValue?: unknown) => {
        invalidateModel(config.id, scopeValue);
      },
      read: (scopeValue: unknown) => {
        const scopeKey = keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        return scopeSortedRows(scopeName, scopeValue);
      },
      issueSequence: (scopeValue: unknown, field: keyof Stored & string) => {
        if (scopeValue === null) throw new Error(`${config.name}.${scopeName}.issueSequence requires a scope value`);
        const scopeKey = keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        const maxFieldValue = scopeSortedRows(scopeName, scopeValue).reduce((maximum, row) => {
          const value = row[field];
          return typeof value === 'number' && value > maximum ? value : maximum;
        }, 0);
        const issuedKey = compositeKey(config.id, scopeKey, field);
        const maxIssuedThisSession = issuedScopeSequenceByKey.get(issuedKey) ?? 0;
        const next = Math.max(maxFieldValue, maxIssuedThisSession) + 1;
        issuedScopeSequenceByKey.set(issuedKey, next);
        return next;
      },
      seed: (scopeValue: unknown, rows: Input[]) => {
        const liveRows = rows
          .filter(isPlanRow)
          .filter(row => !planes().entityState.isTombstoned(String(row.id)))
          .map(row => ({ row: row as Record<string, unknown> }));
        applyEvent([
          { kind: 'upsert', model: config.id, rows: liveRows.map(entry => entry.row) },
          planScope(keyForScope(scopeName, scopeValue), liveRows, 'complete', { resetOrder: true })
        ]);
      }
    } as ScopeHandle<Stored, Record<string, unknown>, Input>;
    registerInternalScopeHandle(scopeHandle, {
      apply: (scopeValue, rows, coverage, options) => {
        applySnapshot(
          planApply(
            scopeValue,
            rows.map(row => ({ row: row as Record<string, unknown> })),
            coverage,
            options
          )
        );
      },
      planApply,
      key: scopeValue => keyForScope(scopeName, scopeValue),
      isServerOrder: () => !spec?.sort || spec.sort === 'server-order',
      planPlacement: (scopeValue, id, position) => {
        const scopeKey = keyForScope(scopeName, scopeValue);
        const entries = planes().scopeIndex.read(scopeKey).entries;
        const order = position === 'prepend' ? Math.min(0, ...entries.map(entry => entry.order)) - 1 : Math.max(-1, ...entries.map(entry => entry.order)) + 1;
        return [{ kind: 'scope-delta', model: config.id, scopeKey, append: [{ id, order }], detach: [] }];
      },
      readRows: scopeValue => scopeSortedRows(scopeName, scopeValue),
      isResolved: scopeValue => planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).generation > 0,
      noteAccess: scopeValue => {
        planes().scopeIndex.noteAccess(keyForScope(scopeName, scopeValue));
      }
    });
    return scopeHandle;
  };

  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)])) as {
    [K in keyof TScopes]: ScopeHandle<Stored, ScopeValueOf<TScopes[K]>, Input>;
  };

  const planRows = (rows: unknown[], options?: { origin?: 'event' }): JournalOp[] => {
    const accepted = rows.filter(isPlanRow);
    return [{ kind: 'upsert', model: config.id, rows: accepted, ...(options?.origin ? { origin: options.origin } : {}) }];
  };

  const captureMembership = (id: string): Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }> =>
    planes()
      .scopeIndex.keysOf(id)
      .flatMap(scopeKey => {
        const entry = planes()
          .scopeIndex.read(scopeKey)
          .entries.find(candidate => candidate.id === id);
        return entry ? [{ id, scopeKey, order: entry.order, edge: entry.edge }] : [];
      });

  const restoreMembership = (nextId: string, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[] =>
    memberships.map(membership => ({
      kind: 'scope-delta' as const,
      model: config.id,
      scopeKey: membership.scopeKey,
      append: [{ id: nextId, order: membership.order, edge: membership.edge }],
      detach: [membership.id]
    }));

  const replacementId = (next: unknown): string | null => {
    try {
      return normalize(next).id;
    } catch {
      return null;
    }
  };

  const planReplace = (oldId: string, next: unknown): JournalOp[] => {
    let normalized: Stored;
    try {
      normalized = normalize(next);
    } catch (error) {
      getDbLogger().error('replace rejected', { model: config.id, oldId, error });
      noteReplaceRejected();
      return [];
    }
    // Reconciliation and mutation commit share this replacement seam, so both clear retained failure state.
    clearFailedOptimisticMutation(config.id, oldId);
    const mergeBase = planes().entityState.read(oldId);
    const memberships = captureMembership(oldId);
    const nextId = normalized.id;
    return [
      { kind: 'destroy', model: config.id, ids: [oldId] },
      { kind: 'upsert', model: config.id, rows: [next], origin: 'replace', mergeBase },
      ...(nextId == null ? [] : restoreMembership(nextId, memberships))
    ];
  };

  const planRestore = (next: unknown, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[] => {
    const nextId = replacementId(next);
    return [{ kind: 'upsert', model: config.id, rows: [next], origin: 'replace' }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
  };

  const model: ModelCore<Stored, Input> & { scopes: typeof scopeHandles } = {
    modelId: config.id,
    // The runtime branch adds `live` exactly when the overload's live config is present.
    query: ((name, queryConfig) => {
      const { live, ...queryOptions } = queryConfig;
      const handle = defineQuery({
        ...queryOptions,
        key: queryConfig.key ?? `${config.id}:${name}`,
        into: queryConfig.into ?? (model as NonNullable<typeof queryConfig.into>)
      });
      if (!live) return handle;
      const compiled = defineModelIngest(model, live);
      let runtime: ReturnType<typeof createDbSubscriptionRuntime> | null = null;
      let readers = 0;
      const sync = () => {
        if (readers === 0) return;
        runtime ??= createDbSubscriptionRuntime(compiled.entries);
        runtime.setActive(true);
      };
      model.registerReset(() => {
        runtime?.setActive(false);
        runtime = null;
        sync();
      });
      return {
        ...handle,
        use: (scope: unknown, options?: { enabled?: boolean }) => {
          const result = handle.use(scope as never, options);
          useEffect(() => {
            readers += 1;
            sync();
            return () => {
              readers -= 1;
              if (readers === 0) runtime?.setActive(false);
            };
          }, []);
          return result;
        },
        live: { apply: compiled.apply }
      };
    }) as ModelCore<Stored, Input>['query'],
    mutation: (name, mutationConfig) => {
      /** Mutation dedupe keys are idempotency identities, not scope bucket keys; scope validation belongs to scope handles and queries. */
      const dedupe = mutationConfig.dedupe === false ? false : (mutationConfig.dedupe ?? { key: input => `${config.id}:${name}:${buildScopeKey(input)}` });
      return defineMutation({ ...mutationConfig, dedupe });
    },
    fetch: <TData, TFetchInput, TSelected>(name: string, fetchConfig: ModelFetchConfig<TData, TFetchInput, TSelected>) =>
      defineFetch<TData, TFetchInput, TSelected>({ ...fetchConfig, key: fetchConfig.key ?? `${config.id}:${name}` } as Parameters<
        typeof defineFetch<TData, TFetchInput, TSelected>
      >[0]),
    poller: (name, pollerConfig) =>
      createModelStatusPoller({
        ...pollerConfig,
        fetch: async id => {
          try {
            return (await getDbTransport().query({ query: pollerConfig.document, variables: pollerConfig.vars?.(id) ?? { id } })).data;
          } catch (error) {
            getDbLogger().error('Model.poller', 'fetch failed', { key: `${config.id}:${name}`, id, error });
            throw error;
          }
        }
      }),
    ingest: entries => defineModelIngest(model, entries),
    find: id => (id == null ? undefined : planes().entityState.read(String(id))),
    where: (where, options) => {
      const rows = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where));
      const order = options?.orderBy ?? config.defaultOrder;
      if (!order) return limitRows(rows, options?.limit);
      return sortModelReadRows(rows, [{ field: String(order.field), direction: order.direction }], options?.limit);
    },
    all: () => planes().entityState.values(),
    update: (id, patch) => applyEvent([{ kind: 'patch', model: config.id, id: String(id), patch: patch as Record<string, unknown> }]),
    destroy: id => applyEvent([{ kind: 'destroy', model: config.id, ids: [String(id)] }]),
    destroyMany: ids => applyEvent([{ kind: 'destroy', model: config.id, ids: ids.map(id => String(id)) }]),
    updateAll: (where, patch) => {
      const rows = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where));
      if (rows.length === 0) return 0;
      applyEvent(rows.map(row => ({ kind: 'patch', model: config.id, id: String(row.id), patch: patch as Record<string, unknown> })));
      return rows.length;
    },
    destroyAll: where => {
      const ids = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where))
        .map(row => String(row.id));
      if (ids.length === 0) return 0;
      applyEvent([{ kind: 'destroy', model: config.id, ids }]);
      return ids.length;
    },
    insert: row => applyEvent([{ kind: 'upsert', model: config.id, rows: [row] }]),
    insertMany: rows => applyEvent([{ kind: 'upsert', model: config.id, rows }]),
    seed: rows => applyEvent(planRows(rows)),
    replace: (oldId, next) => applyEvent(planReplace(String(oldId), next)),
    build: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      invalidateModel(config.id, scope);
    },
    use: {
      pending: id => {
        const key = id == null ? null : String(id);
        const readPending = useCallback(() => key != null && getOperationState().pendingForRow(config.id, key).length > 0, [key]);
        const subscribePending = useCallback(
          (listener: () => void) => {
            if (key == null) return () => {};
            const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model: config.id, id: key }]);
            return () => subscription.unsubscribe();
          },
          [key]
        );
        return useSyncExternalStore(subscribePending, readPending, readPending);
      },
      failed: id => {
        const key = id == null ? null : String(id);
        const readFailed = useCallback(() => key != null && getOperationState().failedFor(config.id, key) !== undefined, [key]);
        const subscribeFailed = useCallback(
          (listener: () => void) => {
            if (key == null) return () => {};
            const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model: config.id, id: key }]);
            return () => subscription.unsubscribe();
          },
          [key]
        );
        return useSyncExternalStore(subscribeFailed, readFailed, readFailed);
      },
      unsyncedChanges: (id: string | null | undefined) => {
        const key = id == null ? null : String(id);
        const cacheRef = useRef<Partial<Stored> | undefined>(undefined);
        const readChanges = useCallback(() => {
          if (key == null) return undefined;
          let merged: Record<string, unknown> | undefined;
          for (const operation of getOperationState().pendingForRow(config.id, key)) {
            if (operation.intent !== 'patch') continue;
            if (!operation.patchedValues) continue;
            merged = { ...(merged ?? {}), ...operation.patchedValues };
          }
          const next = merged as Partial<Stored> | undefined;
          const previous = cacheRef.current;
          if (previous && next && rowsShallowEqual(previous, next)) return previous;
          cacheRef.current = next;
          return next;
        }, [key]);
        const subscribeChanges = useCallback(
          (listener: () => void) => {
            if (key == null) return () => {};
            const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model: config.id, id: key }]);
            return () => subscription.unsubscribe();
          },
          [key]
        );
        return useSyncExternalStore(subscribeChanges, readChanges, readChanges);
      },
      find: ((id: string | null | undefined, options: { require?: readonly string[] } & ProjectionOptions<Stored, Record<string, unknown>> = {}) => {
        const required = options?.require ?? [];
        const key = id == null ? undefined : String(id);
        return useProjectedLiveRow(
          () => {
            const row = key == null ? undefined : planes().entityState.read(key);
            return hasRequiredFields(row, required) ? row : undefined;
          },
          key == null ? [] : [rowDep(key, required.length > 0 ? required : undefined)],
          options,
          `${config.id}.use.find`
        );
      }) as ModelCore<Stored, Input>['use']['find'],
      field: (id, field) => {
        const key = id == null ? undefined : String(id);
        return useLiveRead(() => (key == null ? undefined : planes().entityState.read(key)?.[field]), key == null ? [] : [rowDep(key, [String(field)])]);
      },
      first: ((
        where: DbWhere<Stored> | null | undefined,
        options: DbReadOptions<Stored> & { require?: readonly string[] } & ProjectionOptions<Stored, Record<string, unknown>> = {}
      ) => {
        validateProjectionOptions(options, `${config.id}.use.first`);
        const optionsRef = useRef(options);
        const gateRef = useRef(createProjectionGate<Stored, Record<string, unknown>>());
        optionsRef.current = options;
        const order = options.orderBy ?? config.defaultOrder;
        const signature = incrementalSignature('first', config.id, where, order, options.limit, options.require);
        return useIncrementalRead({
          signature,
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature,
              model: config.id,
              where: row => (where == null || matchesCriteria(row, where)) && hasRequiredFields(row, optionsRef.current.require ?? []),
              options: order ? { orderBy: [{ field: String(order.field), direction: order.direction }], limit: options.limit } : { limit: options.limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => (rows[0] ? gateRef.current.project(rows[0], optionsRef.current) : undefined),
              isEqual: Object.is
            })
        });
      }) as ModelCore<Stored, Input>['use']['first'],
      where: whereRead,
      byIds: ((ids: readonly string[] | null | undefined, options: ProjectionOptions<Stored, Record<string, unknown>> = {}) => {
        const resolvedIds = (ids ?? []).map(id => String(id));
        validateProjectionOptions(options, `${config.id}.use.byIds`);
        const optionsRef = useRef(options);
        const gateRef = useRef(createProjectionGate<Stored, Record<string, unknown>>());
        const resultRef = useRef<{ rows: Record<string, unknown>[]; byId: ReadonlyMap<string, Record<string, unknown>> } | null>(null);
        optionsRef.current = options;
        return useLiveRead(
          () => {
            const sources: Stored[] = [];
            for (const id of resolvedIds) {
              const source = planes().entityState.read(id);
              if (source !== undefined) sources.push(source);
            }
            const rows = gateRef.current.projectRows(sources, optionsRef.current);
            if (resultRef.current?.rows === rows) return resultRef.current;
            resultRef.current = {
              rows,
              byId: new Map(sources.map(source => [source.id, gateRef.current.project(source, optionsRef.current)]))
            };
            return resultRef.current;
          },
          resolvedIds.map(id => rowDep(id)),
          Object.is
        );
      }) as ModelCore<Stored, Input>['use']['byIds'],
      count: where =>
        useIncrementalRead({
          signature: incrementalSignature('count', config.id, where),
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature: incrementalSignature('count', config.id, where),
              model: config.id,
              where: row => where == null || matchesCriteria(row, where),
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: (_rows, count) => count,
              countOnly: true
            })
        }),
      related: ((id: string | null | undefined, relationName: string, options: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}): unknown => {
        const relation = resolvedRelations()[relationName];
        if (!relation) throw new Error(`${config.name} has no relation ${relationName}`);
        if (relation.kind === 'hasMany') {
          return useProjectedLiveRows(
            () => (id == null ? EMPTY_ROWS : (relation.model.where({ [relation.foreignKey]: id }) as StoredRowShape[])),
            id == null ? [] : [rowDep(id), { kind: 'model', model: relation.model.modelId }],
            options,
            `${config.id}.use.related`
          );
        }
        let compute: () => unknown;
        let deps: Dependency[];
        let isEqual: (a: unknown, b: unknown) => boolean = Object.is;
        if (relation.kind === 'belongsTo') {
          const parentIdOf = (): string | null => {
            const child = id == null ? undefined : planes().entityState.read(id);
            const value = child?.[relation.foreignKey];
            return typeof value === 'string' && value.length > 0 ? value : null;
          };
          compute = () => {
            const parentId = parentIdOf();
            return parentId ? relation.model.find(parentId) : undefined;
          };
          const parentId = parentIdOf();
          deps = id == null ? [] : [rowDep(id, [relation.foreignKey]), ...(parentId ? [{ kind: 'row' as const, model: relation.model.modelId, id: parentId }] : [])];
        } else if (relation.kind === 'hasOne') {
          const comparator = relation.comparator;
          compute = () => {
            if (id == null) return undefined;
            const rows = relation.model.where({ [relation.foreignKey]: id });
            if (rows.length === 0) return undefined;
            return comparator ? rows.reduce((best, row) => (comparator(row, best) < 0 ? row : best)) : rows[0];
          };
          deps = id == null ? [] : [rowDep(id), { kind: 'model', model: relation.model.modelId }];
        } else {
          compute = () => undefined;
          deps = [];
        }
        return useLiveRead(compute, deps, isEqual);
      }) as ModelCore<Stored, Input>['use']['related']
    },
    scopes: scopeHandles,
    registerReset: fn => {
      registerReset(fn);
    }
  };
  registerInternalModelHandle(model, {
    readRow: id => planes().entityState.read(id),
    applyRows: rows => applySnapshot(planRows(rows)),
    applyPatch: (id, patch, operationId) => getApplyRuntime().apply([{ kind: 'patch', model: config.id, id: String(id), patch, operationId }]),
    planRows,
    planReplace,
    captureMembership,
    planRestore,
    relations: resolvedRelations,
    revision: () => revision
  });
  registerIngestModel(config.name, model);
  if (config.maintenance) {
    registerModelMaintenance(config.id, () => {
      const reports: MaintenanceReport[] = [];
      for (const task of config.maintenance?.maxRowsPerScope ?? []) {
        reports.push({ model: config.id, task: 'maxRowsPerScope', affected: trimRowsPerScope(model, task.scopeField, task.limit, task.compare, task.protect?.()) });
      }
      return reports;
    });
  }

  registerReset(() => {
    revision += 1;
    planesRef?.entityState.reset();
    planesRef?.scopeIndex.reset();
    planesRef = null;
    // The apply target stays registered: a model must keep working after the kill-switch.
  });

  for (const [scopeName, spec] of Object.entries(config.queryScopes ?? {})) {
    if (scopeName in model.use) throw new Error(`${config.name} queryScope '${scopeName}' collides with a built-in use key`);
    (model.use as Record<string, unknown>)[scopeName] = (extra?: DbWhere<Stored>) => {
      const criteria = extra ? ({ and: [spec.where, extra] } as DbWhere<Stored>) : spec.where;
      let builder = whereRead(criteria);
      if (spec.orderBy) builder = builder.orderBy(spec.orderBy.field, spec.orderBy.direction);
      if (spec.limit !== undefined) builder = builder.limit(spec.limit);
      return builder;
    };
  }

  const statics = config.statics?.(model);
  if (statics) {
    for (const key of Object.keys(statics)) {
      if (key in model) throw new Error(`${config.name} statics collide with base model key ${key}`);
    }
  }
  return Object.assign(model, statics) as Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, 'use' | 'scopes'> & {
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
    scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>> };
  } & TExt;
};

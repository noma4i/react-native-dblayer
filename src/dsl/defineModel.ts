import type { DbGraphQLDocument, DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import { buildScopeKey, matchesDbWhere } from '../core/compileDbWhere';
import type { Dependency } from '../core/apply/commitBus';
import { registerApplyTarget } from '../core/apply/transaction';
import { useScopeLiveRows, useScopeLiveWindowRows } from '../core/tanstack/liveScopeReads';
import type { StoredRowShape } from '../core/tanstack/facade';
import { seedCollections } from '../core/tanstack/mirror';
import type { JournalOp } from '../core/apply/journal';
import { registerGcHost } from '../core/gc';
import { createEntityClock, createEntityState, type EntityState } from '../core/planes/entityState';
import { createScopeIndex, type ScopeIndex, type ScopeIndexValue } from '../core/planes/scopeIndex';
import { invalidateModel } from '../core/invalidationRegistry';
import { getDbLogger } from '../core/logger';
import { expandPlan, registerRelationHost, type MembershipDelta, type RelationDecl } from '../core/relations';
import { registerReset } from '../core/reset';
import { fieldSpecSparseRead, type FieldSpec } from '../schema/fieldSpec';
import { useLiveRead, arraysShallowEqual } from '../read/useLiveRead';
import { createProjectionGate, useProjectedLiveRow, useProjectedLiveRows, validateProjectionOptions, type ProjectionOptions } from '../read/projectionGate';
import type { KeepPreviousOption } from '../read/scopeRetention';
import { createModelReadEngine, createScopeReadEngine, incrementalSignature, limitRows, sortModelReadRows, useIncrementalRead } from '../read/incrementalReadEngine';
import { getApplyRuntime, getCommitBus, getDbRuntimeConfig, getOperationState, getStoragePrefix, hasReplayedJournal } from './configure';
import { defineFetch } from './defineFetch';
import { defineMutation, type MutationConfig } from './defineMutation';
import { defineQuery } from './defineQuery';
import { defineView, type ViewConfig, type ViewHandle } from './defineView';
import { defineModelIngest, registerIngestModel, type ModelIngestEntry } from './defineIngest';
import type { DbSubscriptionEntry } from '../core/subscriptionRuntime';
import { createReadBuilder, type ModelReadBuilder, type ReadOrder } from './readBuilder';
import { hasRequiredFields } from '../read/requireFields';
import type { RequiredFields } from './readBuilder';
import type { ScopeCoverage, ScopeSpec } from './scope';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isRecord } from '../utils/normalizeHelpers';
import type { InferBuildStoredInput, InferStoredFields } from '../schema/infer';
import { getDbTransport } from '../core/transport';
import { createModelStatusPoller, type ModelStatusPoller } from '../utils/modelStatusPoller';
import { trimRowsPerScope } from '../utils/runtimePrimitives';
import { registerModelMaintenance, type MaintenanceReport } from './maintenanceRegistry';
import { omit } from 'es-toolkit';
import { createDbSubscriptionRuntime } from '../core/subscriptionRuntime';
import { registerInternalModelHandle, registerInternalScopeHandle } from '../core/internalHandles';

export type ScopeValueOf<TScope> = TScope extends ScopeSpec<infer _TStored> ? Record<string, unknown> : never;

type ScopeWindowResult<T> = {
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
type CrudSection = Record<string, unknown>;
type CrudQueryHandle = ReturnType<typeof defineQuery<unknown, unknown, unknown, { id: string }>>;
type CrudCreateHandle = ReturnType<typeof defineMutation<unknown, unknown, { id: string }, unknown>>;
type CrudIdMutationHandle = ReturnType<typeof defineMutation<unknown, { id: string } & Record<string, unknown>, { id: string }, unknown>>;
type CrudHandle<K extends keyof CrudSections> = K extends 'list' | 'get' ? CrudQueryHandle : K extends 'update' | 'destroy' ? CrudIdMutationHandle : CrudCreateHandle;
export type CrudSections = {
  /** List query configuration. `into` is required and must be a scope handle. */
  list?: CrudSection & { into: ScopeHandle<{ id: string }, unknown> };
  /** Get query configuration; destination defaults to this model. */
  get?: CrudSection;
  /** Create mutation configuration; provide `respond` or `build` with `selectServerNode`. */
  create?: CrudSection;
  /** Update mutation configuration; default optimistic patch reads `input.id`. */
  update?: CrudSection;
  /** Destroy mutation configuration; default optimistic destroy reads `input.id`. */
  destroy?: CrudSection;
};

/**
 * Reactive access to one named scope of a model (`model.scopes.<name>`), backed by the scope's
 * membership index. `scopeValue` selects the concrete scope instance (e.g. `{ chatId }`); `null`/`undefined`
 * reads as empty without subscribing.
 */
export type ScopeHandle<TStored extends { id: string }, TScope, TInput = TStored> = {
  modelId: string;
  /** Reactive scope rows. `keepPrevious` opt-in retains the prior non-empty key until this key resolves. */
  use<TProjection extends Record<string, unknown>>(
    scopeValue: TScope | null | undefined,
    opts: { select: (row: TStored) => TProjection; renderKeys?: never } & KeepPreviousOption
  ): TProjection[];
  use(scopeValue: TScope | null | undefined, opts?: { select?: never; renderKeys?: readonly (keyof TStored & string)[] } & KeepPreviousOption): TStored[];
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
    opts?: { pageSize?: number; select?: never; renderKeys?: readonly (keyof TStored & string)[] } & KeepPreviousOption
  ): ScopeWindowResult<TStored>;
  useWindow<TProjection extends Record<string, unknown>>(
    scopeValue: TScope | null | undefined,
    opts: { pageSize?: number; select: (row: TStored) => TProjection; renderKeys?: never } & KeepPreviousOption
  ): ScopeWindowResult<TProjection>;
  /** Reactive count of rows currently in the scope. */
  useCount(scopeValue: TScope | null | undefined): number;
  /** Clear this scope's fetch-state and invalidate its derived React Query key(s). */
  invalidate(scopeValue?: TScope): void;
  /** Synchronous snapshot read of the scope's rows, in sort order; safe to call outside React. */
  read(scopeValue: TScope): TStored[];
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
  /** Define a model-owned query with colocated live subscription entries; the returned handle adds `live.apply`. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow> & { live: Record<string, ModelIngestEntry> }
  ): ReturnType<typeof defineQuery<TResponse, TVars, TScope, TRow>> & { live: LiveQueryHandle };
  /** Define a model-owned query with a conventional `<modelId>:<name>` key and this model as the default destination. */
  query<TResponse, TVars, TScope, TRow extends { id: string }>(
    name: string,
    config: ModelQueryConfig<TResponse, TVars, TScope, TRow>
  ): ReturnType<typeof defineQuery<TResponse, TVars, TScope, TRow>>;
  /** Define a model-owned mutation with a conventional input-sensitive in-flight guard; pass `dedupe: false` to opt out or `once: true` to retain committed keys. */
  mutation<TData, TInput, TRow extends { id: string }, TNode>(
    name: string,
    config: ModelMutationConfig<TData, TInput, TRow, TNode>
  ): ReturnType<typeof defineMutation<TData, TInput, TRow, TNode>>;
  /** Compose conventional resource handles.
   * @param sections Present resource sections and their builder-derived configuration.
   * @returns Exactly the handles for the present section keys.
   */
  crud<TSections extends CrudSections>(sections: TSections): { [K in keyof TSections & keyof CrudSections]: CrudHandle<K> };
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
  /** Define a reactive joined projection over one declared scope and its current related rows. */
  view<TItem = TStored & Record<string, unknown>>(name: string, config: ViewConfig<TItem>): ViewHandle<TItem, Record<string, unknown>>;
  /** Define model-owned subscription entries that apply rows, guards, effects, and custom handlers together. */
  ingest(entries: Record<string, ModelIngestEntry>): { entries: DbSubscriptionEntry[]; apply(key: string, payload: unknown): void };
  get(id: string | null | undefined): TStored | undefined;
  getWhere(where: DbWhere<TStored>, opts?: DbReadOptions<TStored>): TStored[];
  /** Full snapshot - library/maintenance channel; app code stays on scoped reads. */
  getAll(): TStored[];
  patch(id: string, patch: Partial<TStored>): void;
  destroy(id: string): void;
  destroyMany(ids: string[]): void;
  insertStored(row: TStored): void;
  /**
   * Insert several rows as ONE plan: one journal record, one apply transaction, one commit publish -
   * unlike calling `insertStored` in a loop, which would journal/publish once per row. Each row still
   * goes through the same per-row normalize, `guard`, and event-origin tombstone gate as `insertStored`;
   * relation side effects (`touch`, `counterCache`, declarative scope membership) are expanded once over
   * the whole batch, so a `belongsTo` `counterCache` increments by the batch's full count in one step
   * rather than one increment per row.
   */
  insertStoredMany(rows: TStored[]): void;
  replaceRaw(oldId: string, next: unknown): void;
  buildStored(input: unknown): TStored;
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
    /** Read one field from one row. */
    field<K extends keyof TStored>(id: string | null | undefined, field: K): TStored[K] | undefined;
    /** Read one row or a shallow-gated projection; selector identity may change without becoming a dependency. */
    row<TProjection extends Record<string, unknown>>(
      id: string | null | undefined,
      opts: { select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly (keyof TStored & string)[] }
    ): TProjection | undefined;
    row(
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
    /** Read ids in input order with stable rows and an id-keyed map; nullish ids return an unsubscribed empty result. */
    byIds<TProjection extends Record<string, unknown>>(
      ids: readonly string[] | null | undefined,
      opts: { select: (row: TStored) => TProjection; renderKeys?: never }
    ): { rows: TProjection[]; byId: ReadonlyMap<string, TProjection> };
    byIds(
      ids: readonly string[] | null | undefined,
      opts?: { select?: never; renderKeys?: readonly (keyof TStored & string)[] }
    ): { rows: TStored[]; byId: ReadonlyMap<string, TStored> };
    count(where?: DbWhere<TStored> | null): number;
    /** Read a declared relation, optionally projecting row-valued relation results through the shared gate. */
    related<TProjection extends Record<string, unknown>>(
      id: string | null | undefined,
      relation: string,
      opts: { select: (row: TStored) => TProjection; renderKeys?: never }
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

type RequiredReadUse<TStored extends { id: string; updatedAt?: string | null }, TKey extends keyof TStored & string> = Omit<ModelCore<TStored>['use'], 'row' | 'first'> & {
  row<TProjection extends Record<string, unknown>>(
    id: string | null | undefined,
    opts: { select: (row: TStored) => TProjection; renderKeys?: never; require?: readonly TKey[] }
  ): TProjection | undefined;
  row<K extends TKey>(
    id: string | null | undefined,
    opts: { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require: readonly K[] }
  ): RequiredFields<TStored, K> | undefined;
  row(id: string | null | undefined, opts?: { select?: never; renderKeys?: readonly (keyof TStored & string)[]; require?: never }): TStored | undefined;
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

type ModelConfig<TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>>, TExt extends Record<string, unknown>> = {
  /** Unique model id. Namespaces storage keys, dependency tracking, and cross-model relation targets. */
  id: string;
  /** Human-readable model name; prefixes normalize/apply error and log messages. */
  name: string;
  /** Field spec map (built with `f.*`) that drives normalize/build reads for every stored field. */
  fields: TFields;
  /**
   * Derive the row id from raw input. Defaults to `input.id`. Must return a non-empty string;
   * returning anything else makes `normalize` throw `${name} requires id` for that input, which
   * plan-building paths (writes, apply) catch and log as a rejected row, and direct `buildStored`/
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
  merge?: {
    /**
     * Acceptance gate for an incoming write when a row with the same id already exists. Return `false`
     * to keep the existing row and drop the incoming one (e.g. an out-of-order or stale server echo).
     * Omit to always accept incoming writes.
     */
    shouldOverwrite?: (existing: unknown, incoming: unknown) => boolean;
  };
  /**
   * Build extra static members merged onto the returned model (e.g. singleton statics, custom finders).
   * Receives the base `ModelCore` so statics can call back into `get`/`patch`/`use`/etc. Throws at
   * `defineModel` time if any returned key collides with a base model key.
   */
  statics?: (model: ModelCore<InferStoredFields<TFields>, InferBuildStoredInput<TFields>>) => TExt;
};

const keyForScope = (scopeName: string, scopeValue: unknown): string => `${scopeName}:${buildScopeKey(scopeValue)}`;

const EMPTY_ROWS: never[] = [];

type SparseModelField = ModelFieldSpecs[string] & { [fieldSpecSparseRead]: (value: unknown, fieldKey: string) => unknown };

const readField = (field: ModelFieldSpecs[string], input: unknown, key: string, complete: boolean): unknown => {
  const value = complete ? field.read(input, key) : (field as SparseModelField)[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/merge policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `patch`/`destroy`/`insertStored`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export const defineModel = <
  const TFields extends ModelFieldSpecs,
  TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>> = {},
  TExt extends Record<string, unknown> = {}
>(
  config: ModelConfig<TFields, TScopes, TExt>
): Omit<ModelCore<InferStoredFields<TFields>, InferBuildStoredInput<TFields>>, 'use' | 'scopes'> & {
  use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'>;
  scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildStoredInput<TFields>> };
} & TExt => {
  type Stored = InferStoredFields<TFields> & Record<string, unknown>;
  type Input = InferBuildStoredInput<TFields>;
  type ModelPlanes = { entityState: EntityState<Stored>; scopeIndex: ScopeIndex };
  let planesRef: ModelPlanes | null = null;
  let revision = 0;
  /** Planes are created and hydrated on first touch, so models can be defined before configureDb. */
  const planes = (): ModelPlanes => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const entityState = createEntityState<Stored>({ modelId: config.id, clock: createEntityClock(), now: () => Date.now(), storage: runtime.storage, prefix: getStoragePrefix });
    const scopeIndex = createScopeIndex({ modelId: config.id, scopeNames: Object.keys(config.scopes ?? {}), storage: runtime.storage, prefix: getStoragePrefix });
    entityState.hydrate();
    scopeIndex.hydrate();
    planesRef = { entityState, scopeIndex };
    return planesRef;
  };

  const normalize = (input: unknown, complete = false): Stored => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = config.rowId?.(input) ?? (isRecord(input) ? input.id : undefined);
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
      const fieldValue = row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };

  const isScopeMember = (scopeKey: string, id: string): boolean => planes().scopeIndex.has(scopeKey, id);

  /** Declarative membership: an event row joins/leaves its `by` scopes inside the SAME plan. */
  const membershipForUpsert = (row: Record<string, unknown>): MembershipDelta[] => {
    const id = String(row.id);
    const before = planes().entityState.read(id);
    const merged = { ...before, ...row, id };
    const deltas: MembershipDelta[] = [];
    for (const [scopeName, spec] of membershipScopes) {
      const beforeValue = before ? scopeValueFromRow(spec.by, before) : null;
      const afterValue = scopeValueFromRow(spec.by, merged);
      const beforeKey = beforeValue ? keyForScope(scopeName, beforeValue) : null;
      const afterKey = afterValue ? keyForScope(scopeName, afterValue) : null;
      if (beforeKey && beforeKey !== afterKey && isScopeMember(beforeKey, id)) deltas.push({ scopeKey: beforeKey, detach: [id] });
      if (afterKey && !isScopeMember(afterKey, id)) deltas.push({ scopeKey: afterKey, append: [id] });
    }
    return deltas;
  };

  const membershipForPatch = (id: string, patch: Record<string, unknown>): MembershipDelta[] => {
    const current = planes().entityState.read(id);
    if (!current) return [];
    return membershipForUpsert({ ...patch, id });
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
    membershipForPatch,
    detachForDestroy
  });

  const writeRows = (rows: unknown[], origin?: 'event' | 'replace'): Array<{ id: string; changedFields: string[] | null }> => {
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
      if (current && config.merge?.shouldOverwrite && !config.merge.shouldOverwrite(current, incoming)) continue;
      const result = planes().entityState.upsert({ ...current, ...incoming });
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
      if (spec.sort && spec.sort !== `server-order` && `comparator` in spec.sort) return true;
      const relevant = new Set<string>(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== `server-order` && `field` in spec.sort) relevant.add(String(spec.sort.field));
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: (scopeKey: string) => {
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`:`));
      const sort = (config.scopes as Record<string, ScopeSpec<Stored>> | undefined)?.[scopeName]?.sort;
      if (!sort || sort === `server-order`) return { kind: `server-order` as const };
      if (`comparator` in sort) return { kind: `comparator` as const };
      return { kind: `field` as const, field: String(sort.field), dir: sort.dir };
    },
    readAllScopeKeys: (): string[] => planes().scopeIndex.keys(),
    upsert: writeRows,
    patch: (id: string, patch: Record<string, unknown>): { id: string; changedFields: string[] | null } | null => {
      const current = planes().entityState.read(id);
      if (!current) return null;
      const result = planes().entityState.upsert({ ...current, ...patch, id });
      if (result.changedFields !== null && result.changedFields.length === 0) return null;
      revision += 1;
      return { id, changedFields: result.changedFields };
    },
    destroy: (ids: string[], tombstone?: boolean): string[] => {
      const removed: string[] = [];
      for (const id of ids) {
        const existed = planes().entityState.read(id) !== undefined;
        planes().entityState.destroy(id, { tombstone });
        if (existed) removed.push(id);
      }
      if (removed.length > 0) revision += 1;
      return removed;
    },
    counter: (id: string, field: string, delta: number, next?: number): boolean => {
      const row = planes().entityState.read(id);
      if (!row) return false;
      planes().entityState.upsert({ ...row, [field]: next ?? ((row[field] as number | undefined) ?? 0) + delta });
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
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()]
  };
  registerApplyTarget(config.id, applyTarget);
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

  /** Imperative/domain writes are events: expand declared relation side effects into the same plan. */
  const applyEvent = (ops: JournalOp[]): void => {
    getApplyRuntime().apply(expandPlan(ops.map(op => (op.kind === 'upsert' && op.origin === undefined ? { ...op, origin: 'event' as const } : op))));
  };

  const scopeSortedRows = (scopeName: string, scopeValue: unknown): Stored[] => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<Stored>>)[scopeName];
    const value = planes().scopeIndex.read(keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter((row): row is Stored => row !== undefined);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    if ('comparator' in spec.sort) return [...rows].sort(spec.sort.comparator);
    const { field, dir } = spec.sort;
    return sortModelReadRows(rows, [{ field, direction: dir }]);
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
    return createReadBuilder(where, {
      rows: <TOutput extends Record<string, unknown>>(
        criteria: DbWhere<Stored> | null,
        orders: readonly ReadOrder<Stored>[],
        limit: number | undefined,
        required: readonly string[],
        projection: ProjectionOptions<Stored, TOutput>
      ): TOutput[] => {
        validateProjectionOptions(projection, `${config.id}.use.where`);
        const projectionRef = useRef(projection);
        const gateRef = useRef(createProjectionGate<Stored, TOutput>());
        projectionRef.current = projection;
        const signature = incrementalSignature('where-builder', config.id, buildScopeKey({ criteria, orders, limit, required }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine({
              signature,
              model: config.id,
              where: row => criteria != null && matchesDbWhere(row, criteria) && hasRequiredFields(row, required),
              options: { orderBy: orders as ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => gateRef.current.projectRows(rows, projectionRef.current),
              isEqual: arraysShallowEqual
            })
        });
      },
      read: <TOutput extends Record<string, unknown>>(
        criteria: DbWhere<Stored> | null,
        orders: readonly { field: keyof Stored & string; direction: 'asc' | 'desc' }[],
        limit: number | undefined,
        required: readonly string[],
        projection: ProjectionOptions<Stored, TOutput>
      ): TOutput[] => {
        const rows = planes()
          .entityState.values()
          .filter(row => criteria != null && matchesDbWhere(row, criteria) && hasRequiredFields(row, required));
        const selected = orders.length > 0 ? sortModelReadRows(rows, orders, limit) : limitRows(rows, limit);
        return projection.select ? selected.map(projection.select) : (selected as TOutput[]);
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
        liveRows.map(({ row, edge }) => ({ id: row.id as string, edge })),
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
          if ('comparator' in scopeSort) {
            next = {
              ...next,
              entries: [...next.entries].sort((left, right) => {
                const leftRow = rowsById.get(left.id);
                const rightRow = rowsById.get(right.id);
                if (!leftRow) return rightRow ? 1 : 0;
                if (!rightRow) return -1;
                return scopeSort.comparator(leftRow, rightRow);
              })
            };
          } else {
            const ordered = sortModelReadRows([...rowsById.values()], [{ field: String(scopeSort.field), direction: scopeSort.dir }]);
            const positions = new Map(ordered.map((row, index) => [String(row.id), index]));
            next = {
              ...next,
              entries: [...next.entries].sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER))
            };
          }
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
    const scopeHandle = {
      modelId: config.id,
      use: (scopeValue: unknown, options: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        useScopeAccess(scopeKey);
        return useScopeLiveRows(
          config.id,
          scopeKey,
          applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`),
          () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0,
          options
        );
      },
      useWindow: (scopeValue: unknown, options: { pageSize?: number; keepPrevious?: boolean } & ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
        const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        const [windowState, setWindowState] = useState({ scopeKey, size: pageSize });
        const windowSize = windowState.scopeKey === scopeKey ? windowState.size : pageSize;
        if (windowState.scopeKey !== scopeKey) setWindowState({ scopeKey, size: pageSize });
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
          fetchNextPage: () => setWindowState(current => (current.scopeKey === scopeKey ? { ...current, size: current.size + pageSize } : { scopeKey, size: pageSize + pageSize }))
        };
      },
      useCount: (scopeValue: unknown) => {
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        useScopeAccess(scopeKey);
        return useLiveRead(
          () => (scopeValue == null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length),
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

  const planRows = (rows: unknown[], options?: { includeMembership?: boolean }): JournalOp[] => {
    const accepted = rows.filter(isPlanRow);
    const ops: JournalOp[] = [{ kind: 'upsert', model: config.id, rows: accepted }];
    if (!options?.includeMembership) return ops;
    for (const row of accepted) {
      let stored;
      try {
        stored = normalize(row);
      } catch {
        continue;
      }
      for (const delta of membershipForUpsert(stored)) {
        ops.push({
          kind: 'scope-delta',
          model: config.id,
          scopeKey: delta.scopeKey,
          append: (delta.append ?? []).map(id => ({ id })),
          detach: delta.detach ?? []
        });
      }
    }
    return ops;
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
    const memberships = captureMembership(oldId);
    const nextId = replacementId(next);
    return [
      { kind: 'destroy', model: config.id, ids: [oldId] },
      { kind: 'upsert', model: config.id, rows: [next], origin: 'replace' },
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
      const dedupe = mutationConfig.dedupe === false ? false : (mutationConfig.dedupe ?? { key: input => `${config.id}:${name}:${buildScopeKey(input)}` });
      return defineMutation({ ...mutationConfig, dedupe });
    },
    crud: sections => {
      const handles: Record<string, unknown> = {};
      if (sections.list) {
        if (!sections.list.into) throw new Error(`${config.id}: crud list requires an explicit into scope`);
        handles.list = model.query('list', sections.list as Parameters<typeof model.query>[1]);
      }
      if (sections.get) handles.get = model.query('get', { ...sections.get, into: sections.get.into ?? model } as Parameters<typeof model.query>[1]);
      if (sections.create) {
        const { respond, build, selectServerNode, prependTo, appendTo, optimistic, ...create } = sections.create;
        const hasOptimistic = Object.prototype.hasOwnProperty.call(sections.create, 'optimistic');
        if (!hasOptimistic && !respond && (!build || !selectServerNode)) throw new Error(`${config.id}: crud create requires respond or build with selectServerNode`);
        const createOptimistic = hasOptimistic
          ? optimistic === false
            ? undefined
            : optimistic
          : respond
            ? { model, respond, selectServerNode, prependTo, appendTo }
            : { model, build, selectServerNode, prependTo, appendTo };
        handles.create = model.mutation('create', { ...create, optimistic: createOptimistic } as Parameters<typeof model.mutation>[1]);
      }
      if (sections.update) {
        const { optimistic, ...update } = sections.update;
        handles.update = model.mutation('update', {
          ...update,
          optimistic:
            optimistic === false
              ? undefined
              : (optimistic ?? { method: 'patch', model, selectId: (input: { id: string }) => input.id, selectPatch: (input: { id: string }) => omit(input, ['id']) })
        } as Parameters<typeof model.mutation>[1]);
      }
      if (sections.destroy) {
        const { optimistic, ...destroy } = sections.destroy;
        handles.destroy = model.mutation('destroy', {
          ...destroy,
          optimistic: optimistic === false ? undefined : (optimistic ?? { method: 'destroy', model, selectId: (input: { id: string }) => input.id })
        } as Parameters<typeof model.mutation>[1]);
      }
      return handles as { [K in keyof typeof sections]: CrudHandle<K & keyof CrudSections> };
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
    view: (name, viewConfig) => defineView(model, name, viewConfig),
    ingest: entries => defineModelIngest(model, entries),
    get: id => (id == null ? undefined : planes().entityState.read(id)),
    getWhere: (where, options) => {
      const rows = planes()
        .entityState.values()
        .filter(row => matchesDbWhere(row, where));
      if (!options?.orderBy) return limitRows(rows, options?.limit);
      return sortModelReadRows(rows, [{ field: String(options.orderBy.field), direction: options.orderBy.direction }], options.limit);
    },
    getAll: () => planes().entityState.values(),
    patch: (id, patch) => applyEvent([{ kind: 'patch', model: config.id, id, patch: patch as Record<string, unknown> }]),
    destroy: id => applyEvent([{ kind: 'destroy', model: config.id, ids: [id] }]),
    destroyMany: ids => applyEvent([{ kind: 'destroy', model: config.id, ids }]),
    insertStored: row => applyEvent([{ kind: 'upsert', model: config.id, rows: [row] }]),
    insertStoredMany: rows => applyEvent([{ kind: 'upsert', model: config.id, rows }]),
    seed: rows => applyEvent(planRows(rows)),
    replaceRaw: (oldId, next) => applyEvent(planReplace(oldId, next)),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      invalidateModel(config.id, scope);
    },
    use: {
      pending: id => {
        const readPending = useCallback(
          () =>
            id != null &&
            getOperationState()
              .pending()
              .some(operation => operation.model === config.id && (operation.rowIds ?? operation.tempIds).includes(id)),
          [id]
        );
        const subscribePending = useCallback(
          (listener: () => void) => {
            if (id == null) return () => {};
            const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model: config.id, id }]);
            return () => subscription.unsubscribe();
          },
          [id]
        );
        return useSyncExternalStore(subscribePending, readPending, readPending);
      },
      row: ((id: string | null | undefined, options: { require?: readonly string[] } & ProjectionOptions<Stored, Record<string, unknown>> = {}) => {
        const required = options?.require ?? [];
        return useProjectedLiveRow(
          () => {
            const row = id == null ? undefined : planes().entityState.read(id);
            return hasRequiredFields(row, required) ? row : undefined;
          },
          id == null ? [] : [rowDep(id, required.length > 0 ? required : undefined)],
          options,
          `${config.id}.use.row`
        );
      }) as ModelCore<Stored, Input>['use']['row'],
      field: (id, field) => useLiveRead(() => (id == null ? undefined : planes().entityState.read(id)?.[field]), id == null ? [] : [rowDep(id, [String(field)])]),
      first: ((
        where: DbWhere<Stored> | null | undefined,
        options: DbReadOptions<Stored> & { require?: readonly string[] } & ProjectionOptions<Stored, Record<string, unknown>> = {}
      ) => {
        validateProjectionOptions(options, `${config.id}.use.first`);
        const optionsRef = useRef(options);
        const gateRef = useRef(createProjectionGate<Stored, Record<string, unknown>>());
        optionsRef.current = options;
        const signature = incrementalSignature('first', config.id, where, options.orderBy, options.limit, options.require);
        return useIncrementalRead({
          signature,
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature,
              model: config.id,
              where: row => (where == null || matchesDbWhere(row, where)) && hasRequiredFields(row, optionsRef.current.require ?? []),
              options: options.orderBy
                ? { orderBy: [{ field: String(options.orderBy.field), direction: options.orderBy.direction }], limit: options.limit }
                : { limit: options.limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => (rows[0] ? gateRef.current.project(rows[0], optionsRef.current) : undefined),
              isEqual: Object.is
            })
        });
      }) as ModelCore<Stored, Input>['use']['first'],
      where: whereRead,
      byIds: ((ids: readonly string[] | null | undefined, options: ProjectionOptions<Stored, Record<string, unknown>> = {}) => {
        const resolvedIds = ids ?? [];
        const rows = useProjectedLiveRows(
          () => resolvedIds.map(id => planes().entityState.read(id)).filter((row): row is Stored => row !== undefined),
          resolvedIds.map(id => rowDep(id)),
          options,
          `${config.id}.use.byIds`
        );
        const resultRef = useRef<{ rows: Record<string, unknown>[]; byId: ReadonlyMap<string, Record<string, unknown>> } | null>(null);
        if (resultRef.current?.rows !== rows) resultRef.current = { rows, byId: new Map(rows.map((row, index) => [resolvedIds[index]!, row])) };
        return resultRef.current!;
      }) as ModelCore<Stored, Input>['use']['byIds'],
      count: where =>
        useIncrementalRead({
          signature: incrementalSignature('count', config.id, where),
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature: incrementalSignature('count', config.id, where),
              model: config.id,
              where: row => where == null || matchesDbWhere(row, where),
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
            () => (id == null ? EMPTY_ROWS : (relation.model.getWhere({ [relation.foreignKey]: id }) as StoredRowShape[])),
            id == null ? [] : [{ kind: 'model', model: relation.model.modelId }],
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
            return parentId ? relation.model.get(parentId) : undefined;
          };
          const parentId = parentIdOf();
          deps = id == null ? [] : [rowDep(id, [relation.foreignKey]), ...(parentId ? [{ kind: 'row' as const, model: relation.model.modelId, id: parentId }] : [])];
        } else if (relation.kind === 'hasOne') {
          const comparator = relation.comparator;
          compute = () => {
            if (id == null) return undefined;
            const rows = relation.model.getWhere({ [relation.foreignKey]: id });
            if (rows.length === 0) return undefined;
            return comparator ? rows.reduce((best, row) => (comparator(row, best) < 0 ? row : best)) : rows[0];
          };
          deps = id == null ? [] : [{ kind: 'model', model: relation.model.modelId }];
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
    applyRows: rows => applySnapshot(planRows(rows)),
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
    // The apply target stays registered: a model must keep working after the kill-switch.
  });

  const statics = config.statics?.(model);
  if (statics) {
    for (const key of Object.keys(statics)) {
      if (key in model) throw new Error(`${config.name} statics collide with base model key ${key}`);
    }
  }
  return Object.assign(model, statics) as Omit<ModelCore<InferStoredFields<TFields>, InferBuildStoredInput<TFields>>, 'use' | 'scopes'> & {
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'>;
    scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildStoredInput<TFields>> };
  } & TExt;
};

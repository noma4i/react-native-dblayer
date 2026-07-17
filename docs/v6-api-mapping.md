# dblayer v6 API + File Mapping (implementation contract)

Companion to `v6-contract-spec.md`. This document is the LITERAL contract: public TypeScript signatures, file layout, storage formats, and per-app-query coverage decisions. Executor transcribes; internal helper types/naming inside files are executor freedom.

## 1. File layout (src/)

```
src/
  core/
    planes/storagePlane.ts      // StoragePlane interface + mmkvStoragePlane impl
    planes/entityState.ts       // rows + entityClock + tombstones
    planes/scopeIndex.ts        // membership ledger
    planes/operationState.ts    // optimistic ops + keyed sequences
    apply/capture.ts            // snapshot capture
    apply/plan.ts               // ApplyPlan types + planners (query/mutation/ingest/local)
    apply/transaction.ts        // atomic apply + durable commit (journal)
    apply/journal.ts            // journal read/write/replay
    apply/commitBus.ts          // semantic invalidation bus
    relations.ts                // taxonomy: belongsTo/hasMany/hasOne + dependent/touch/counterCache
    freshness.ts                // kept from v5 (freshnessStorage)
    reset.ts                    // resetRuntime kill-switch + registerReset
  dsl/
    configure.ts                // configureDb
    defineModel.ts
    scope.ts
    defineQuery.ts
    defineMutation.ts
    defineIngest.ts
  read/
    hooks.ts                    // Model.use.* + ScopeHandle hooks (constant topology)
    projection.ts               // useStableProjection + useJoinedEntities/useOrderedEntities (kept)
    loadingState.ts             // kept from v5
  schema/                       // kept as-is from v5 (f, defineShape, fieldSpec, shape)
  utils/                        // kept: mergeOptimisticSnapshot, singleFlight, batchBuffer,
                                //   tombstoneLedger->absorbed into entityState, generateTempId,
                                //   normalizeHelpers, typeBoundary, modelStatusPoller (fix refs=0), mmkvStorage
  index.ts                      // public barrel (section 6)
  __tests__/
    invariants/inv01-interleavings.property.test.ts ... inv10-loadmore-error.test.ts
    (rewritten v5 suites keep their scenario names)
```

## 2. Storage formats (mmkvStoragePlane; all keys under the static `dbl:` prefix)

Key prefix: static `dbl:`. The library has NO concept of users/accounts/partitions. Full invalidation = `resetRuntime()` kill-switch: deletes every `dbl:`-prefixed key and clears all in-memory planes in one call; the host app decides when (e.g. logout).

| Key | Value (JSON) |
|---|---|
| `meta` | `{ schemaVersion: number, lastEpoch: number }` |
| `rows:{modelId}` | v5 collection payload format (kept) |
| `clock:{modelId}` | `number` (monotonic per-model write seq) |
| `tombstones:{modelId}` | `{ [rowId]: { seq: number, at: number } }` (TTL 24h, cap 10k, never prune entries younger than 10min) |
| `scope:{modelId}:{scopeHash}` | `{ generation: number, coverage: 'complete'\|'page'\|'delta', entries: Array<{ id: string, order: number, seq: number, edge?: Record<string, unknown> }> }` |
| `ops` | `{ [operationId]: { model: string, tempIds: string[], intent: 'insert'\|'patch'\|'destroy', idempotencyKey?: string, status: 'pending'\|'committed'\|'rolledback', createdAt: number } }` |
| `seq:{modelId}:{key}` | `number` (keyed sequences, e.g. per-chat optimistic floor) |
| `journal:{epoch}` | `JournalRecord` (below); `journalIndex` = `{ pending: number[], last: number }`, cap 50 committed |

```ts
type JournalOp =
  | { kind: 'upsert'; model: string; rows: unknown[] }
  | { kind: 'patch'; model: string; id: string; patch: Record<string, unknown> }   // stored-format merge; no-op when row absent (no phantoms)
  | { kind: 'destroy'; model: string; ids: string[] }
  | { kind: 'scope'; model: string; scopeHash: string; next: ScopeIndexValue }
  | { kind: 'freshness'; key: string; value: unknown }
  | { kind: 'counter'; model: string; id: string; field: string; delta: number };
type JournalRecord = { epoch: number; planHash: string; status: 'pending' | 'committed'; ops: JournalOp[] };
```

Replay on startup: for each `pending` epoch re-apply ops idempotently (upsert by id, scope replace by value, counter guarded by planHash dedup), then mark committed. Torn write of the record itself (unparseable JSON) -> drop record, log corruption, continue (plan lost pre-durability = at-most-once acceptable; post-durability records are single-key atomic in MMKV).

## 3. Public TypeScript contracts

```ts
// ---------- configure ----------
export interface DbDefaults {
  staleTime?: number; emptyStaleTime?: number; gcTime?: number; pageSize?: number;
  merge?: { dedupeWindowMs?: number };
  onSyncError?: (error: Error, ctx: { source: string; model?: string; scope?: unknown }) => void;
}
export function configureDb(options: {
  transport: DbTransport;                    // kept from v5
  storage?: StoragePlane;
  queryClient?: QueryClient;
  logger?: DbLogger; track?: DbTrackSink;
  defaults?: DbDefaults;
}): void;

export function resetRuntime(): Promise<void>;

// ---------- storage plane ----------
export interface StoragePlane {
  get(key: string): string | undefined;
  set(entries: Array<{ key: string; value: string | null }>): void;  // single atomic-enough batch
  keys(prefix: string): string[];
}

// ---------- scopes ----------
export type ScopeKind = 'membership' | 'entity';
export type Coverage = 'complete' | 'page' | 'delta';
export interface ScopeSpec<TStored> {
  by?: Record<string, keyof TStored & string>;             // AUTO-MEMBERSHIP (M7): an event row (insert/patch/ingest/replace) joins/leaves the matching scope inside the SAME plan/epoch - same-tick visibility for optimistic and ingest rows; patch changing a by-field re-parents (detach old + append new); destroy detaches everywhere (incl. sweep of non-by ledgers); snapshot reconciles stay authoritative over auto-membership
  kind?: ScopeKind;                                        // default 'entity'
  sort?: { field: keyof TStored & string; dir: 'asc' | 'desc' }
       | { comparator: (a: TStored, b: TStored) => number }
       | 'server-order';
  retention?: { maxRows?: number };
  renderKeys?: ReadonlyArray<keyof TStored>;
}
export function scope<TStored>(spec: ScopeSpec<TStored>): ScopeSpec<TStored>;

export interface ScopeHandle<TStored, TScope> {
  use(scopeValue: TScope | null | undefined): TStored[];
  useWindow(scopeValue: TScope | null | undefined, opts?: { pageSize?: number }): {
    rows: TStored[]; totalCount: number; hasMore: boolean;
    loadMore: () => void; refresh: () => Promise<void>;
  };
  useCount(scopeValue: TScope | null | undefined): number;
  invalidate(scopeValue?: TScope): void;
  read(scopeValue: TScope): TStored[];                     // imperative snapshot
}

// ---------- relations taxonomy ----------
export function belongsTo<TChild, TParent>(model: ModelRef<TParent>, opts?: {
  foreignKey: keyof TChild & string;
  touch?: (child: TChild, parent: TParent) => Partial<TParent> | null;   // values from event data
  counterCache?: { field: keyof TParent & string; filter?: (child: TChild) => boolean };
}): RelationDecl;
export function hasMany<TParent, TChild>(model: ModelRef<TChild>, opts?: {
  foreignKey: keyof TChild & string; dependent?: 'destroy';
}): RelationDecl;
export function hasOne<TParent, TChild>(model: ModelRef<TChild>, opts?: {
  foreignKey: keyof TChild & string; comparator?: (a: TChild, b: TChild) => number;
}): RelationDecl;
// ModelRef is structural: { modelId, get, getWhere } - any defined model satisfies it; the
// relations() thunk resolves refs lazily so circular model imports work (Rails-style).
//
// EVENT vs SNAPSHOT plans (Rails-callbacks analog, MANDATORY):
// - relation side effects (touch/counterCache/dependent) expand ONLY event plans: imperative model
//   writes (insertStored/patch/destroy/destroyMany/replaceRaw), mutations, ingest;
// - snapshot plans (defineQuery pages, entity refreshes, scope __apply/__applyRows) apply VERBATIM:
//   server snapshots already carry derived state (a history page must not bump unreadCount);
// - a parent upserted by the same plan is authoritative: its accumulated touch is cancelled and
//   counter ops against it are filtered out (server row already includes the child's effect).
//
// touch semantics: emitted as 'patch' ops in STORED format (bypasses guard/normalize field mapping);
// several children of one parent in one plan FOLD through an accumulated parent view (each child's
// touch sees prior children's patches - max-style fields compose correctly); one touch flush per
// parent per plan; missing parent -> no-op (never creates phantoms); cascades upward (a touched
// parent may itself touch its parent) with per-parent termination guards.
// counterCache semantics: +1 only for child rows absent from EntityState before apply AND
// filter(child); -1 on explicit destroy of a counted row (plan-internal insert+destroy nets 0);
// counter op on a missing parent is silently skipped; patch never changes counters.
// dependent: 'destroy' cascades recursively through registered models with cycle guards.

// ---------- model ----------
export function defineModel<TFields, TScopes extends Record<string, ScopeSpec<any>>, TExt>(config: {
  id: string; name: string;
  fields: TFields;                                          // v5 schema DSL unchanged
  rowId?: (input: unknown) => string; guard?: (input: unknown) => boolean;
  relations?: () => Record<string, RelationDecl>;
  sideload?: SideloadSpec[];                                // v5 unchanged
  scopes?: TScopes;
  merge?: { shouldOverwrite?: MergeGate; dedupeWindowMs?: number };
  retention?: { orphanGc?: 'manual' | 'eager' | 'off'; keep?: (row: Stored<TFields>) => boolean };
  statics?: (model: ModelCore<TFields>) => TExt;
}): Model<TFields, TScopes> & TExt;

export interface Model<TFields, TScopes> {
  modelId: string;                                          // journal/plan identity; satisfies ModelRef
  // imperative snapshot API (compiled to single-op plans through apply pipeline):
  get(id: string | null | undefined): Stored<TFields> | undefined;
  getAll(): Stored<TFields>[];                              // library/maintenance channel (prune/trim/reconcile utils); app code stays on scoped reads (FULL-SCAN BAN is an app rule)
  getWhere(where: DbWhere<Stored<TFields>>, opts?: DbReadOptions): Stored<TFields>[];
  patch(id: string, patch: Partial<Stored<TFields>>): void;
  destroy(id: string): void; destroyMany(ids: string[]): void;
  insertStored(row: Stored<TFields>): void; replaceRaw(oldId: string, next: unknown): void;
  buildStored(input: unknown): Stored<TFields>; normalize(input: unknown): unknown;
  invalidate(scope?: unknown): void;
  gc(): number;                                             // orphan GC (manual mode)
  // reactive:
  use: {
    row(id: string | null | undefined, opts?: { select?: ReadonlyArray<keyof Stored<TFields>> }): Stored<TFields> | undefined;
    field<K extends keyof Stored<TFields>>(id: string | null | undefined, field: K): Stored<TFields>[K] | undefined;
    first(where?: DbWhere<Stored<TFields>> | null, opts?: DbReadOptions): Stored<TFields> | undefined;
    where(where: DbWhere<Stored<TFields>> | null, opts?: DbReadOptions): Stored<TFields>[];
    byIds(ids: string[]): Stored<TFields>[];
    count(where?: DbWhere<Stored<TFields>> | null): number;
    related(id: string | null | undefined, relation: string): unknown;
    // belongsTo -> parent row | undefined (deps: child fk field + parent row - pinpoint);
    // hasOne -> best child by comparator (reduce, no full sort) | undefined;
    // hasMany -> children[] (stable ref via shallow equality; deps: child-model level - hot paths
    // should prefer touch projections onto the parent, Rails counter_cache/touch style).
  };
  scopes: { [K in keyof TScopes]: ScopeHandle<Stored<TFields>, ScopeValueOf<TScopes[K]>> };
  registerReset(fn: () => void): void;
}

// ---------- query ----------
export type ExtractSink = { into: ModelLike; rows: unknown[] };  // ModelLike = anything with modelId + __planRows
export function defineQuery<TResponse, TVars, TScope, TStored>(config: {
  document: DbGraphQLDocument<TResponse, TVars>;
  key?: string;                                             // cache-key namespace; DEFAULT = operation name from the document (throws when both absent)
  vars?: (scope: TScope) => TVars;
  page?: (data: TResponse) => ConnectionLike;               // infinite; XOR with select
  select?: (data: TResponse) => unknown;
  into: ScopeHandle<TStored, TScope> | Model<any, any>;
  coverage?: Coverage;                                      // default: page for `page`, complete otherwise
  edge?: (edgeSource: unknown) => Record<string, unknown> | undefined;  // scope-entry edge payload; receives the connection edge object (node for plain lists)
  extract?: (ctx: { data: TResponse; nodes: unknown[] }) => ExtractSink[];  // sideloads applied in the SAME transaction (one epoch) as main rows - closes class A1
  map?: (selected: unknown) => unknown;
  enabled?: (scope: TScope) => boolean;
  staleTime?: number; emptyStaleTime?: number; gcTime?: number; maxPages?: number;
  refetchOnMount?: boolean; direction?: 'forward' | 'backward';
  cursorVar?: string;                                       // default 'after' ('before' when backward)
  getCursor?: (page: ConnectionLike) => string | null;      // default pageInfo.endCursor/startCursor
}): {
  use(scope: TScope): QueryResult<TStored>;                 // page => useInfiniteQuery path, else useQuery path (branch fixed at define time - constant hook topology)
  fetch(scope: TScope): Promise<void>;                      // imperative initial fetch + apply (prefetch); paging lives in the hook
  invalidate(scope?: TScope): void;                         // scoped = exact query, no scope = every scope of this query only
};
// RQ cache stores PageMeta { endCursor, hasNextPage, count } only - rows live in the DB planes.
// emptyStaleTime: staleTime resolves per query state - empty results use the shorter TTL.
// loadMore rejections land in result.error/loadingState, never unhandled (closes class A10).
// causal tokens (versionOf/operationId vs optimistic ops) arrive with the ingest module (M5);
// patchNode is subsumed by defineIngest + Model.patch.
export interface QueryResult<T> {
  data: T[] | T | undefined;                                // stable projection when into=scope
  loadingState: LoadingState;                               // v5 machine kept
  error: Error | null;
  hasNextPage: boolean; isFetchingNextPage: boolean;
  loadMore: () => void;                                     // rejections -> error/loadingState, never unhandled
  refetch: () => Promise<void>;
}

// ---------- mutation ----------
export function defineMutation<TData, TInput, TStored, TNode>(config: {
  document: DbGraphQLDocument<TData, any>;
  result: string;                                           // response field owning the payload; null payload => throw + rollback
  mapInput?: (input: TInput) => Record<string, unknown>;    // variables always sent as { input: mapInput(input) ?? input }
  optimistic?:
    | { model: Model<any, any>; tempIdPrefix?: string;
        build: (input: TInput, ctx: OptimisticCtx) => TStored;
        selectServerNode: (data: TData) => TNode | null | undefined;
        preserveOnCommit?: ReadonlyArray<keyof TStored & string> }  // client-only fields carried onto the committed server row
    | { method: 'patch'; model: Model<any, any>; selectId: (input: TInput) => string;
        selectPatch: (input: TInput) => Partial<TStored> }
    | { method: 'destroy'; model: Model<any, any>; selectId: (input: TInput) => string };
  extract?: (ctx: { data: TData }) => ExtractSink[];        // sideloads in the SAME transaction as the commit replace
  dedupe?: { key: (input: TInput) => string };              // committed key => skip (returns null); pending key => double-tap block
  onMutate?: (input: TInput, ctx: OptimisticCtx) => void;   // before transport
  onCommit?: (data: TData, ctx: OptimisticCtx & { input: TInput }) => void;
  onError?: (error: Error, ctx: OptimisticCtx & { input: TInput }) => void;
  invalidate?: (ctx: { input: TInput; data: TData }) => void;  // after commit - call query.invalidate(...) here
  track?: (ctx: { input: TInput; data: TData }) => void;
}): {
  use(): { mutate: (input: TInput) => void; mutateAsync: (input: TInput) => Promise<TData | null>;
           isPending: boolean; error: Error | null };
  run(input: TInput): Promise<TData | null>;                // identical lifecycle incl. rollback
};
// Commit phase is ONE transaction: __planReplace(tempId, serverNode) + preserveOnCommit 'patch' op
// + extract sinks apply through expandPlan in a single epoch. Rollback: insert => destroy(temp),
// patch => patch back previous row, destroy => insertStored(previous). Operations ledger
// (getOperationState in configure) records begin/committed/rolledback when optimistic or dedupe
// is configured; resetRuntime clears it; configureDb re-creates it.
// Model additionally exposes internal __planReplace(oldId, next) - replaceRaw compiles through it.

// ---------- ingest ----------
export type IngestDecl = {
  upsert?: unknown | unknown[]; destroy?: string | string[]; invalidate?: boolean;
  operationId?: string | null;      // echo guard: a locally committed operation id skips the event
  extract?: ExtractSink[];          // cross-model sideloads in the SAME transaction
};
export function defineIngest(model: Model<any, any>,
  handlers: Record<string, (payload: unknown) => IngestDecl | null>): IngestHandle;
// One event = ONE event plan: rows + destroys + extract sinks apply through expandPlan (relation
// effects: touch/counterCache/dependent) in a single epoch. Re-delivered rows are idempotent:
// absent-from-EntityState counterCache never re-increments, unchanged rows emit no notifications.
// causal.versionOf from the old spec = model merge.shouldOverwrite (single arbitration gate, no
// duplicate); causal.operationId = IngestDecl.operationId. Cross-model derivations (message ->
// chat preview/unread) come from the relations taxonomy, not hand-written multi-model ingest.
// subscription runtime (createDbSubscriptionRuntime/defineDbSubscriptionEntry/effects) kept from v5;
// entries now return IngestDecl-compiling calls instead of raw applyServerData.
```

## 4. Kept verbatim from v5 (do not redesign)

`f`/`defineShape`/fieldSpec/shape readers; `mergeOptimisticSnapshot` + mergers; `createThrottledSingleFlight` (adds mandatory error forward to `onSyncError`); `createKeyedBatchBuffer`; `createModelStatusPoller` (fix: standalone refresh removes refs=0 session); freshness storage; loading-state machine; transport seam types; `useJoinedEntities`/`useOrderedEntities`; `pickEqual`; mmkv low-level adapter; `generateTempId`/`isTempId`; `compositeId`; `DbWhere` compiler + signature dependency (`buildScopeKey`/`ROOT_SCOPE_KEY` = the ONE canonical scope-key normalizer - defineModel/defineQuery key through it).
REWRITTEN in 6c (v5 CollectionModel contract purge): `rowWaiters` (patchWhenPresent/waitForRow now subscribe the commit bus); `singletonStatics` (useCurrent via model.use.row); maintenance utils (prune/trim/reconcile) consume v6 Model.getAll. REMOVED: sideload runtime (superseded by extract sinks), modelDetailRequest, queryClient wrapper, deriveDbKey, createTombstoneLedger (absorbed into EntityState), v5 request helpers in shared.ts (useCollectionRead/createCollectionBinding/useWindowedLoadMore etc).
`useStableProjection(source, config)` = rename of `useStableItems` (same `StableProjectionConfig`: `buildEntry`, `entriesEqual`, `getKey?`, `renderKeys?`); keep `useStableEntity`, `useStableSorted`.

## 5. App-query coverage mapping (part B; verify each against the actual GraphQL document - rule: connection with pageInfo/cursor => 'page'; full array response scoped to an entity => 'complete')

| App query | into | coverage |
|---|---|---|
| chat list (per statusFilter) | ChatModel.scopes.list (membership) | page |
| chat thread / media buckets | MessageModel.scopes.thread / media | page |
| my moments / user moments | MomentModel.scopes.byUser | page |
| feed | FeedModel-successor scope (membership, 'server-order', edge {sequenceNumber}) | page |
| compass my-moments | CompassModel scope | page |
| compass relations for moment | relations scope keyed {momentId} (membership) | complete (full nested result per moment) |
| users by flag (isBlocked/isFriend) | UserModel membership scopes flag lists | complete (full list endpoints) - REGRESSION GUARD: detach only, never destroy User |
| visitors | MomentVisitorModel scope | page |
| wallet transactions | WalletTransactionModel.scopes | page |
| vibes catalog | VibeModel (entity) | complete (authoritative catalog; explicit-empty clears) |
| countries/pricing/skus/campaigns/custom screens | plain RQ single reads (into model, entity kind) | page/ignore-missing |
| search | NOT a scope - ephemeral RQ result (phase 0 shape kept) | n/a |
| profile / current user / chat details | modelDetailRequest-successor: defineQuery select into Model | entity (ignore missing) |

FeedModel/CompassRelationModel decision: PRIMARY = migrate both onto ScopeIndex ('server-order' + edge payload: feed {sequenceNumber}; compass relations edge {id,status,unread} with read-side comparator for unread/createdAt dynamic sort). FALLBACK (allowed with DEVIATION): keep the join model but read it through ScopeHandle API. MomentVisitorModel migrates the same way as compass relations.

## 6. Public barrel (index.ts) - complete export list

configureDb, resetRuntime, getDbTransport, setDbTransport, getDbQueryClient, StoragePlane (type), mmkvStoragePlane,
defineModel, scope, belongsTo, hasMany, hasOne, compositeId, f, defineShape, readShape, readShapeOrThrow, projectShape, readFieldsPatch,
defineQuery, defineMutation, defineIngest, createDbSubscriptionRuntime, defineDbSubscriptionEntry, createDbSubscriptionEffects,
useStableProjection, useStableEntity, useStableSorted, useJoinedEntities, useOrderedEntities, createUniqueIds, EMPTY_IDS, pickEqual,
computeLoadingState, LoadingState (type), generateTempId, isTempId, castNode, castNodes, toStr, pickDefined, pickPresent,
mergeOptimisticSnapshot, mergeOptimisticMedia, createModelStatusPoller, createThrottledSingleFlight, createKeyedBatchBuffer,
createKeyedArrayPatcher, createNestedObjectPatcher, singletonStatics, patchWhenPresent, waitForRow,
type exports: ModelStored, ModelInput, DbWhere, ScopeSpec, Coverage, ScopeHandle, QueryResult, IngestDecl, DbDefaults, DbTransport.
Everything else internal. Removed vs v5: all items in spec section 2.3.

## 5.1 REFERENCE APP ACCEPTANCE (owner directive, MANDATORY)

The yupi_v2 app is the REFERENCE: every usage pattern it contains is the baseline the library must support reactively out of the box - stable refs, pinpoint emissions, no manual glue, no unstable-ref workarounds, no mystery recomputation. If part B migration forces app-side scaffolding (manual dependency wiring, extra memo layers to stop churn, ref-stabilization hacks), that is a LIBRARY DEFECT: extend the library (respecting the taxonomy; no app domain names in core), do not patch the app. Baseline pattern checklist (each must be expressible in v6 API with stable refs + pinpoint emissions):
1. Chat list row: join of chat -> users (id array) + lastMessage (second model) + derived opponent (userIds x currentUserId) with per-row render-keys equality.
2. Thread row meta: ids collected from 4 nested sources per row (author, reactions[].userId, replyTo.user, attachedMoment.user) + custom entriesEqual (value pickEqual + deep meta).
3. Pending feed: derived item (opponentId -> user) with nested equality on selected user fields.
4. Feed: membership scope with edge payload {sequenceNumber}, server-order + locally preserved order on patch.
5. Compass relations: grouped-by-moment membership with edge {id,status,unread} + dynamic read-side sort (unread/createdAt).
6. Singleton current user: 43 call-sites reading id/flags - field-level subscriptions, zero re-render on unrelated profile patches.
7. Windowed pager over network pagination (local window + totalCount + hasMore).
8. Media buckets scope {chatId, mediaBucket}; counters (unreadCount with domain filter); pinned/system merge-back reads; ephemeral search (RQ-only).
9. A user's fullName/avatar patch updates chat rows, thread metas, pending items, visitors - only affected rows re-emit (spec invariant 11).

## 6.1 ANTI-LEGACY ENFORCEMENT (owner directive, MANDATORY)

Big bang means REPLACEMENT, not wrapping:
- FORBIDDEN: any identifier/file containing `legacy`, `shim`, `compat`, `bridge`, or a "new API delegates to old core" pattern. `defineModel` MUST NOT wrap v5 `createPersistentCollection`; EntityState plane owns rows/clock/tombstones itself (TanStack DB collection may be used as the REACTIVE host it always was, but every write goes through the apply pipeline - no direct collection writes, no v5 acceptors).
- DELETE from src during part A (with their old tests rewritten against the new core): `createPersistentCollection.ts` write-path internals, `createReplace.ts`, `createMerge.ts`, `rowVersionCore.ts` (superseded by EntityState/ScopeIndex), `requestRuntime.ts`, old `extract.ts` apply path, `useDbRequest.ts`/`useBaseInfiniteQuery.ts`/`useBaseQuery.ts` (superseded by defineQuery), `useDbMutation.ts`/`executeDbMutation.ts` (superseded by defineMutation), `deferredCollectionPersistence.ts` (superseded by StoragePlane+journal). Pure read utilities (compileDbWhere, signature deps) may be reused as functions - they are not write-path.
- GATE before any commit claiming part A done: `rg -in "legacy|shim|compat" src --glob '!**/yarn.lock'` = 0 hits (comments included); `rg -n "createReplace|createMerge|rowVersionCore|requestRuntime|executeDbMutation|deferredCollectionPersistence" src` = 0 outside git history.

## 6.15 CHECKPOINT PERSISTENCE (owner directive 2026-07-14, MANDATORY - M9)

Serialization must stay off the hot path: full-model JSON.stringify per plan is forbidden.
- Every plan persists ONLY its journal record (WAL, small). Model/scope snapshots flush through a
  checkpoint scheduler: debounce (default ~500ms) + max-pending-plans cap + explicit
  `flushPersistence()` (app calls it on background/logout) - one batch including
  `lastCheckpointEpoch`.
- Startup: hydrate snapshots, then idempotently replay journal records newer than the checkpoint.
  Torn checkpoint batches are safe via a per-model applied-epoch gate (each model snapshot carries
  the epoch of the last plan reflected in it; replay skips ops already covered) - this guards the
  one non-idempotent op (counter).
- Journal pruning is gated by the checkpoint (never prune records newer than lastCheckpointEpoch;
  cap applies on top).
- Perf specs: a plan at 10k rows writes no rows-keys (journal only); N plans -> one checkpoint
  flush; crash before flush -> replay restores every plan; persisted bytes per plan are O(plan),
  never O(model).

## 6.2 PERF SPEC (owner directive 2026-07-14, MANDATORY)

Performance is a spec'd contract, not a hope: "works" and "works efficiently" gate the beta
separately. Two spec classes live in `src/__tests__/perf/` and run in the main suite:

1. COUNTED invariants (deterministic, primary): measure WORK, not time -
   - 1 message insert with 1000 rows / 50 live row-subscribers => exactly 1 notify (its reader),
     0 notifies elsewhere, 1 scope-reader recompute, 1 re-render;
   - one plan => exactly 2 storage.set batches (WAL: pending journal record first, then data +
     committed record - torn-write recovery requires the write-ahead batch), 1 journal record,
     1 bus publish (a 20-row page never persists per-row);
   - idempotent upsert (same row) => 0 notifies, 0 persist entries, 0 re-renders;
   - single-field patch => re-renders only field-readers of that field; scope.use array keeps
     identical refs for every untouched row (ref stability is a measurable spec);
   - membership append => O(1) scope op, no full reconcile.
   Harness: counting StoragePlane + notify/recompute counters over the commit bus (coordinator-authored).
2. TIMED budgets (best-of-3, thresholds calibrated fact x5): apply of a 20-row plan at 10k rows;
   publish with 1000 disjoint-dep subscribers; scopeSortedRows at 1000 entries; hydrate at 10k rows;
   scenario bench "chat session" (25 chats / 1000 messages: send, incoming, page) with counted
   budgets per step.

A perf spec failure blocks release exactly like a functional one. The v5 lag class ("optimistic
message appears late") maps to counted specs: same-tick visibility + zero async hops on the write
path.

## 7. Release

After part A green: `git tag v6.0.0-beta.1 && git push origin v6 --tags && gh release create v6.0.0-beta.1 --prerelease --title "v6.0.0-beta.1" --target v6`. Part B pins `github:noma4i/react-native-dblayer#v6.0.0-beta.1`. Defects found during integration -> beta.N+1, never patch app around the package. Single stable release at the end of the round.

## 8. R1 full-pass round (beta.3) - contract changes

Methodology (owner directive 2026-07-15): the library is fixed in FULL passes - the whole source is
loaded and analyzed at once, every finding lands in ONE fix package and one release. No fix-drip betas.

Semantic contract after R1:

- **Lazy model planes.** `defineModel` no longer touches the runtime at module scope; planes are
  created and hydrated on first access. Models may be imported before `configureDb` (fixes the
  cold-start red box). Constraint: first data access must still happen after `configureDb`.
- **Tombstone gate.** `JournalOp.upsert` carries `origin: 'event' | 'snapshot'` (stamped by
  `expandPlan`; absent = snapshot). Snapshot upserts to a tombstoned id are DROPPED (stale pages
  cannot resurrect deletions); event upserts clear the tombstone (rollback/re-create works).
  `destroy` always tombstones, even for ids never seen locally; tombstones prune inside
  `persistEntries` (TTL 24h, cap 10k).
- **Operation ledger persists.** The checkpoint flush batch includes `dbl:ops`/`dbl:seq` (via the
  scheduler's `extraEntries` seam) and prunes closed operations (TTL 1h). Dedupe keys and the ingest
  echo guard survive restarts. `hasCommitted`/`hasPending` are O(1) set lookups.
- **`replayJournal()`.** Public barrel export; the host app MUST call it once at startup, after
  `configureDb` and after all model modules are imported. Without it WAL recovery never runs.
- **Model invalidation is live.** `defineQuery` registers its `invalidate` on the destination model
  (`invalidationRegistry`); `model.invalidate(scope?)`, `ScopeHandle.invalidate(scope?)` and
  `IngestDecl.invalidate: true` fan out to registered queries via the app QueryClient.
- **Plan row validation.** Snapshot plan builders (`__planRows`, `__planApply`) drop rows that fail
  `normalize` (guard reject / missing id) with `logger.error`; ops keep RAW rows (normalize is
  shape-sensitive - `.from`/`.fromKey` fields). `writeRows` also catches per-row normalize failures.
  A poisoned row can no longer abort a plan mid-apply.
- **First-page refetch order.** `runFetch(cursor == null)` passes `resetOrder` down to
  `ScopeIndex.reconcile('page')`: incoming rows become the new head order, previous members keep
  relative order after them, nothing is detached. Fixes fresh feed content landing at the bottom of
  'server-order' scopes after a background refetch.
- **Primitive scope keys.** `buildScopeKey(null | undefined)` -> root; any other non-record
  (string/number/boolean/array) serializes to its own key. Primitive query scopes no longer collide
  on the root RQ cache key.
- **Journal hot path (perf).** `JournalRecord` has NO `planHash`. Committed-epoch prune uses an
  in-memory index - the hot path never re-reads/re-parses the journal. Declarative membership emits
  `scope-delta` ops (append/detach id lists), batched per scope per plan and idempotent on replay;
  full `scope` set-ops remain only for query-page reconciles. Destroy of an unseen id tombstones
  silently without a row notification.
- **Mutation guards.** Optimistic destroy on a model with `hasMany(..., dependent: 'destroy')`
  throws before any state change (rollback cannot restore cascaded children). Failed optimistic
  patch rollback removes keys the patch added. `useWindow` no longer exposes a fake `refresh`
  (network refetch belongs to the composed query).
- **Dead v5 purge.** Removed: freshnessStorage/freshnessGate, createPatchCrud, modelMirror,
  writePropagation, modelDefaults, modelRegistry, extractPage, apply/plan, singleFlight,
  commandTracking, mutationConfig, tracking (and `configureDb({ track })`), dead compileDbWhere
  compile-path, `StorageAdapter.eventApi`, `@tanstack/db` dependency, `ScopeSpec.kind/retention/
  renderKeys`, `ModelConfig.retention`/`merge.dedupeWindowMs`, `model.gc()`. Retention enforcement
  returns only together with its implementation.

Accepted-risk notes (documented, not fixed in R1): torn checkpoint batch between a model snapshot
and its applied-marker can double-apply counter ops on replay (window is one storage batch);
query-page `planApply` still mutates ScopeIndex eagerly at plan build (snapshot applies are
immediate and synchronous); model-destination queries return `data: undefined` - read rows via
`model.use.*`, do not drive empty-states from such a query's `loadingState.hasData`.

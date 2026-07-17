# dblayer v6 Contract Spec (big bang redesign)

Status: approved input for implementation. Owner decisions: big bang, no legacy/compat, Rails/ActiveRecord DSL canon, storage = MMKV + ApplyPlan journal (S1, DuckDB rejected), TDD mandatory in this repo.

## 0. Diagnosis being fixed (v5 defect class)

Server data writes are spread across 4 unsynchronized channels; only the read channel carries the request-start snapshot (`snapshotSeq`). The extract channel merges BEFORE the protected replace, erases delete-marks (`noteWrite`), drops explicit-empty payloads; single-request `sync` is merge-only and skips empty responses; ingest applies its own contracts without snapshots. `createReplace` deletes any row missing from a scoped response - it cannot distinguish "left the scope window" from "destroy". Consequences in production app: resurrection of deleted chats, unfriend deleting canonical User rows referenced by chats/messages, replace-vs-merge-initial oscillation, silent sync errors, direct mutations without rollback, unbounded retention. v6 removes the class by construction: THERE IS NO UNSAFE WRITE PATH.

## 1. Architecture: three state planes + one apply pipeline

### 1.1 State planes (all behind a `StoragePlane` seam; default impl = MMKV + journal)

- **EntityState** - canonical rows per model + per-entity causality: `entityClock` (monotonic per-store write seq), tombstones with TTL+cap (pruning must never drop tombstones younger than the max in-flight request age).
- **ScopeIndex** - membership ledger per (model, scopeKey): ordered entries `{ rowId, orderIndex, edgePayload?, seq }`, plus per-scope `coverage` (`complete | page(cursorRange) | delta`) and `generation`. Replaces hand-built join models (FeedModel/CompassRelationModel class) WHERE the edge is pure membership+order+payload; models with domain edge behavior may keep join models - both read through the same scope read API.
- **OperationState** - optimistic operations: `{ operationId, tempIds, model, patch/insert/destroy intent, status(pending|committed|rolledback), idempotencyKey, createdAt }`. Owns temp->server reconciliation and retry idempotency. Keyed sequences (monotonic optimistic ordering floors keyed by a parent row) register here and reset with it.

### 1.2 Apply pipeline (the ONLY write path for server data)

`capture -> transport -> plan -> transaction -> durable commit -> post-commit`

1. **capture**: before transport, snapshot `entityClock` of every declared target collection + scope generation.
2. **transport**: network call WITHOUT any open transaction.
3. **plan**: pure function `(response, capture, declarations) -> ApplyPlan` - list of row upserts, scope reconciles, tombstone ops, freshness writes, counter ops. No side effects.
4. **transaction**: apply the whole plan atomically in memory (all models + scopes + freshness in one commit).
5. **durable commit**: journal record (idempotent, epoch-numbered) written before collection persistence flushes; startup replays incomplete epochs (torn-write recovery). Journal format: `{ epoch, planHash, ops[] }`, capped.
6. **post-commit**: external effects (subscription effects channel, tracking) - never inside the transaction.

Rules: query `into`-write and ALL `extract` sinks execute inside ONE plan/transaction with per-model captured snapshots. Custom sinks must declare their write-set (models they touch) or be marked `nonAtomic: true` explicitly. Mutations (`use` and `run`) share this exact lifecycle including rollback (rollback = inverse plan from OperationState, not ad-hoc). Ingest handlers return declarations (`{ upsert?, destroy?, invalidate? }`) that are compiled into plans on the same channel - ledger arbitration protects against subscription-during-initial-load races.

### 1.3 Reactivity: semantic commit bus

ApplyPlan accumulates changed (model, ids, scopeKeys, fields). After commit, ONE batched invalidation is published; identical queries dedupe; live queries re-run with generation/cancellation guard. Raw writes outside the apply channel do not exist (model.patch/destroy/insertStored compile to single-op plans through the same pipeline). Constant hook topology: every read hook unconditionally runs the same number of `useLiveQuery` calls with gating inside the query builder (no undefined<->read topology switches). `use.field`/`select` compile to query projections - notifications fire only when selected fields change.

## 2. Rails DSL canon

### 2.1 Relation taxonomy (5 kinds; retention/missing semantics derive from the KIND, not per-config knobs)

| Kind | Declaration | Semantics |
|---|---|---|
| Ownership | `hasMany(Child, { dependent: 'destroy' })` / `belongsTo(Parent)` | Cascade ONLY on explicit destroy (never from scope reconcile). |
| Query relation | `hasMany(Child)` / `hasOne` / `belongsTo` without dependent | Navigation/read only; no lifecycle authority. |
| Membership edge | `memberOf(scope)` / scope declared with `kind: 'membership'` | Server response with `coverage: 'complete'` detaches missing members (removes scope entry / clears flag fields); NEVER destroys the entity. `coverage: 'page'|'delta'` -> missing is ignored. |
| Projection/mirror | `touch: (row) => fields` on belongsTo; `counterCache: { field, filter?, distinctBy? }`; `mirror` | Derived writes carry ApplyContext provenance (never look like user/server writes); touch VALUES come from event data (e.g. message.createdAt), never wall clock; counterCache increments only for rows absent before apply (dedup by id), decrements on destroy. |
| Embedded snapshot | schema `f.object/f.array` shapes | No independent lifecycle; merged via optimistic snapshot mergers. |

### 2.2 Model + scopes

```ts
defineModel({
  id, name, fields: Schema.fields,          // schema DSL (f/defineShape) unchanged from v5
  relations: () => ({ ... }),               // taxonomy above
  sideload: [...],                          // unchanged
  scopes: {
    list: scope({ by: { statusFilter: 'status' }, kind: 'membership',
                  sort: { field: 'lastActivityAt', dir: 'desc' } | { comparator } | 'server-order',
                  retention: { maxRows? }, renderKeys? }),
  },
  merge: { shouldOverwrite?, dedupeWindowMs? },
  retention: { orphanGc: 'manual' | 'eager' | 'off', keep? },
})
```

Destroy authority: ONLY explicit `destroy` ops (mutation destroy intent, ingest destroy declaration, orphan GC under reachability rules). `onMissing:'auto'` heuristics are rejected (r3): missing under `page/delta` coverage = ignore; membership + `complete` coverage = detach; `entity/page` reads = ignore; ownedSnapshot destroy = explicit opt-in only.

### 2.3 Query / Mutation / Ingest

```ts
const chatList = defineQuery({
  document, vars: scope => vars,
  page: d => d.chats,                        // or select: for single
  into: ChatModel.scopes.list,               // destination = scope handle or model; key derived
  coverage: 'page',                          // 'complete' | 'page' | 'delta'
  extract: ctx => ({ users: ... }),          // same transaction; sink table is typed
  causal?: { versionOf?, orderOf?, operationId? },   // adapters mapping GraphQL fields to tokens
  enabled?, staleTime?, emptyStaleTime?, gcTime?, maxPages?, refetchOnMount?,
});  // -> { use(scope), fetch(scope, opts), invalidate(scope?) }

const sendMessage = defineMutation({
  document, result: 'sendMessage', mapInput?,
  optimistic?: { model, build, selectServerNode, preserveOnCommit? } | { method:'patch'|'destroy', ... },
  extract?, onMutate?, onCommit?, onError?, invalidate?, track?, dedupe?,
});  // -> { use(), run(input, ctx?) } - SAME lifecycle incl. rollback

defineIngest(Model, { messageCreated: payload => ({ upsert, destroy, invalidate }) })
```

Removed from public API: `resolveSyncContract`, `mergeInitialSyncContract`/`replaceInitialSyncContract`, manual `key`, `sync:{model,contract}` callbacks, `useDbMutation`/`runDbMutationDirect`, `useDbSingleRequest`/`useDbInfiniteRequest` (folded into defineQuery), `createOptimisticSequence`. Errors: loadMore/fetch rejections always land in `result.error`/loadingState; background sync errors flow to `configureDb.defaults.onSyncError` (throttled single-flight must forward, never swallow).

### 2.4 Reads

`Model.use.{row(id,{select}), field(id,k), first, where, byIds, count}`; `Model.scopes.X.{use, useWindow, useCount, invalidate}`. `useWindow` returns `{ rows, totalCount, hasMore, loadMore, refresh }` where `hasMore = localWindow < totalCount || network.hasNextPage` (closes v5 A12). Stability helpers survive: `useStableProjection` (renamed unified `useStableItems`/`useStableEntity`/`useStableSorted` family - graph joins like chat list/thread keep the projection-config pattern: collect-ids callback, multiple models, custom entriesEqual, derived key), `useJoinedEntities`/`useOrderedEntities` for 1:1 joins.

### 2.5 Config defaults (light DSL - nothing mandatory beyond transport/schema)

`configureDb({ transport, storage?, queryClient?, logger?, track?, defaults?: { staleTime=0, emptyStaleTime, gcTime=30min, pageSize=20, merge, onSyncError } })`. Resolution: call > scope/model > defaults > builtin. `maxPages` stays per-query (domain-specific windows, r2). Retention is THREE separate policies (never one knob): transportWindow (RQ pages), membershipRetention (scope maxRows trim after reconcile), entityGc (reachability: provenance in any live scope, retain edges from relations, `keep()` guards for temp/pending/active uploads).

## 3. Causality (current server truth + adapters)

Available today: per-chat monotonic `Message.sequence_number` (unique index), `updated_at` timestamp gate, real-time delete events (`messageDeleted`/`chatDeleted`), `SyncChats` gap-fill. NOT available: global entity revisions, offline-complete delete coverage (Message is hard-deleted), response coverage tokens, multi-device self-echo (server excludes sender from message broadcasts for all kinds except gift/moment_reaction/video_intro - verified 2026-07-14). Client therefore: timestamp gate stays the arbitration fallback; `causal` adapters are opt-in hooks so future server tokens (BE2) plug in without API change; optimistic message correlation stays local (clientId is an FE-only field; matching heuristic only ever runs for the 3 self-echo kinds). Do NOT re-introduce a client_id server column (owner decision 2026-07-14).

## 4. Runtime hygiene

- `resetRuntime()` resets EVERYTHING registered: planes, journal epoch, freshness, dedupe, poller sessions, keyed sequences (via `registerReset`), infinite patch states. Full invalidation is a KILL-SWITCH: `resetRuntime()` wipes the entire `dbl:` storage namespace (all planes, journal, freshness, sequences) and all in-memory state in one call. There is no per-model or per-namespace isolation concept - the host app decides when to pull the switch (e.g. on logout).
- Persistence schema `version` + migration hooks + corruption policy (kill-switch -> cold resync) + torn-write recovery via journal replay.
- Poller: standalone `refresh()` must not leak refs=0 sessions.
- Devtools (dev-only): why-kept/why-deleted/why-overwritten per row, scope graph dump, transaction trace, storage bytes per plane.

## 5. TDD invariants (write these tests FIRST; property-based where marked)

1. (P) Any interleaving of {initial query, page N, subscription upsert, subscription destroy, optimistic mutation, commit, rollback, re-delivery} never: resurrects a destroyed row; loses a row written after capture; double-counts a counterCache; leaves OperationState dangling after commit/rollback.
2. (P) Scope reconcile with coverage 'complete' detaches exactly the missing members; with 'page'/'delta' detaches nothing; entity destroy never originates from reconcile.
3. (P) Ownership cascade fires only on explicit destroy; query relations never cascade; canonical rows referenced by other live scopes survive any scope's reconcile (v5 A2 regression test).
4. (P) Journal: kill before/during/after durable commit -> replay converges to exactly-once application (plan idempotent); no partial visibility after restart.
5. Touch/counterCache writes carry ApplyContext and never trip the timestamp gate against later server rows (v5 A18 regression).
6. Commit bus: N-row plan produces exactly one invalidation batch; unrelated field changes do not notify `field/select` subscribers.
7. Kill-switch: `resetRuntime()` wipes storage + planes + keyed sequences; a fresh start after it sees zero residue.
8. Explicit-empty responses reconcile (clear membership) instead of being dropped (v5 A1/A6 regression).
9. Direct `run()` mutation failure rolls back identically to hook path (v5 A5 regression).
10. loadMore rejection lands in result.error (v5 A10 regression).
11. (P) Cross-model reactive propagation (owner directive 2026-07-14): patching a field on model A (e.g. `UserModel.fullName`) re-emits EXACTLY the subscribers whose declared dependencies include that (model, id, field) - joined projections (chat rows rendering that user), `use.field`/`use.row({select})` readers, relation accessors - and NOTHING else: rows joining other users receive zero emissions; subscribers of unrelated fields of the same row receive zero emissions. Verified by commitBus emission counters in tests.
Determinism: no Date.now()/Math.random() inside plan/transaction code paths - clocks injected.

## 5.0 DSL simplicity contract (owner directive 2026-07-14)

The public DSL is dead simple - "store data, render it, patch it, delete it, nothing simpler". TanStack (Query/DB) is an IMPLEMENTATION DETAIL, fully hidden: no RQ types, statuses, keys, or observers leak through the public API (QueryClient appears only as an optional `configureDb` injection; loading UI state is our `loadingState` machine). A newcomer reading only README examples must be able to: define a model in ~10 lines, read it reactively in one hook, write через `patch/destroy/defineMutation` without knowing what a query key or a collection is. Every public API addition is measured against this bar; anything requiring TanStack knowledge is a defect.

## 5.1 Full reactivity contract (ActiveRecord feel; owner directive)

The library recreates ActiveRecord + full reactivity: one write, visible everywhere, minimal re-renders.
- Every reactive read declares its dependency set `(model, ids|scope, fields?)` on subscription; commitBus matches plans against dependency sets - per-row, per-field granularity where declared (renderKeys/select/field), per-scope otherwise.
- Joined projections (`useJoinedEntities`, `useStableProjection` configs) register dependencies on BOTH the source rows and every joined entity's declared fields, so a joined entity's field change rebuilds only the rows that join it (stable refs for all others).
- Relation accessors: `Model.use.related(id, 'relationName')` - reactive read through a declared relation (belongsTo -> row | undefined, hasMany -> rows ordered per relation opts); constant hook topology; dependencies = the related rows' fields actually consumed (via optional `select`).
- Derived writes (touch/counterCache/mirror) flow through the same plans, so dependents of derived fields update in the same commit batch - one invalidation wave per apply, never cascading storms.

## 6. App migration order (after core green)

chat -> feed/compass -> users/misc; delete FeedModel/CompassRelationModel where ScopeIndex covers them; app fixes from phase 0 carry over unchanged (unread policy S1 becomes a `counterCache` filter, forward-picker predicate, compass invalidation, ephemeral search stay domain code). Device gates per domain per the approved plan.

## 7. Explicitly rejected (do not implement)

`onMissing:'auto'`, universal 'server-order' replacement for Feed/Compass/Search (Search = ephemeral RQ result with gcTime, never persistent), single retention knob, global maxPages default, `resolveEnabled` util, mechanical toStr unification, DuckDB storage plane (binding broken; core stays storage-agnostic behind StoragePlane).

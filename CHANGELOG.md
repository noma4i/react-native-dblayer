# Changelog

## 6.2.0-beta.1 - 2026-07-18

### Breaking changes and migration

- BREAKING: `resetRuntimeSync` is removed; `resetRuntime` is the single synchronous kill-switch - replace `resetRuntimeSync()` calls with `resetRuntime()`.
- BREAKING: `loadMore` is renamed to `fetchNextPage` on query results and `useWindow` handles - rename call sites.
- BREAKING: `patchWhenPresent` is renamed to `patchWhenRowExists`.
- BREAKING: dead exports are removed: `compositeId`, `createKeyedBatchBuffer`, `pruneExpiredRows`, `pruneOrphanedRows`, `readFieldsPatch`, `useJoinedEntities`, `useOrderedEntities`.

### Reliability

- Fix event-origin ingest being blocked by tombstones after a destroy - live events resurrect rows correctly while stale snapshots stay blocked.
- Fix `collectGarbage` evicting rows without notifying mounted `use.row` and scope readers - maintenance batches now publish precise change-sets.
- Persist operation-ledger entries synchronously and sweep orphaned temp rows during `replayJournal` - crash windows no longer resurrect phantom optimistic rows.
- Force a checkpoint flush after `replayJournal` so the WAL journal cannot grow unboundedly across repeated short sessions.
- Unify sync-error routing: `onSyncError` receives tagged errors from query, mutation, and ingest paths; ingest handlers are guarded.
- Fix a subscription race after `resetRuntime` - remounted readers receive fresh updates because incremental subscriptions route through the live engine.
- Report warm-cache fetches as refreshing: hydrated starts no longer flash a ready state; `loadingState` distinguishes the boot skeleton from background revalidation.
- Fix an extra `useWindow` render via window-aware slice versioning.

### DSL

- Add `defineFetch` for ephemeral network reads with the standard `loadingState` surface.
- Add `bootDb()` and `suspendDb()` lifecycle helpers.
- Add `insertStoredMany` for batch stored writes.
- Expose `operationId` in mutation optimistic, transport, and lifecycle contexts; it is the fallback idempotency key.

### Tests

- Library-agnostic acceptance specification: 10 bundles, 72 contracts covering model, query, mutation, sync lifecycle, errors, perf gates, the reactivity sweep, DSL additions, concurrency and anti-storm behavior, and loading/refresh status.

### Example

- Add a permanent buildable `example/` iOS showcase app: cross-referenced screens over a public GraphQL API demonstrating live relations, optimistic temp-to-server swap, cascade destroy, and reactive `use.count`.

### Docs

- Rewrite the reference docs against the current public surface and add IntelliSense-grade JSDoc across the core DSL.

## 6.1.1-beta.2 - 2026-07-17

### Package metadata

- Describe the v6 package as a persistent data-layer DSL without claiming the removed TanStack DB runtime dependency.


## 6.1.1-beta.1 - 2026-07-17

### Query runtime ownership

- Own `@tanstack/react-query` at `5.101.2` and export `QueryClient`, `QueryClientProvider`, `focusManager`, `useQuery`, and `useQueryClient` so consumers use one package-controlled runtime.
- Remove the unused `@tanstack/react-db` peer and development dependency from the v6 package.


## 6.1.0 - 2026-07-15

### Reactive read performance

- Update `use.where`, `use.count`, and `use.first` from affected commit deltas instead of rescanning every model row after each relevant write.
- Update field-sorted scope `use` and `useWindow` reads from one scope dependency, while retaining stable ordering for equal sort values.
- Keep reactive scope revisions in memory so persisted scope bytes remain unchanged by local read invalidation.

### Test coverage

- Add equivalence, stable-tie, descriptor, generation, scope-epoch, and maintenance rebuild coverage for incremental reads.
- Bound P4 and P5 20k-to-1k scaling checks and assert exactly one installed dependency for field-sorted scope reads.

### Known limitations

- Comparator-sorted scopes conservatively rebuild after a relevant commit because comparator dependencies cannot be inferred safely.

## 6.0.1 - 2026-07-15

### Persistence and journal safety

- Retain dirty row snapshots when a checkpoint storage batch throws; the next flush persists them instead of silently losing the rows.
- Counter journal operations record the absolute post-value and replay by setting it, so replays are idempotent under torn checkpoints.
- Idle checkpoints omit the unchanged sequences entry.

### Apply pipeline

- Compute relation effects against a plan-local overlay, so multi-operation plans touching one row produce consistent cascades.
- Make an identical upsert a true no-op: row identity, dirty state, and the commit bus stay untouched.

### Invalidation and hooks

- Partial-scope invalidation reaches every registered scope whose value is a superset of the partial; exact keys and no-argument full fan-out keep working.
- `useLiveRead` rechecks its snapshot after subscribing, closing the render-to-effect gap where a commit could be missed.
- Scope windows reset when the scope key changes.
- Mutation hooks always call the latest definition run; the stale first-render closure is gone.

### Known limitations

- Tombstones written for never-seen ids stay by design: they are the out-of-order delete guard (TTL-bounded), now documented at the write site.

## 6.0.0 - 2026-07-15

### Breaking changes and migration

- BREAKING: the v5 collection runtime is replaced by a three-plane store: EntityState (rows), ScopeIndex (scope memberships), and OperationState (mutation ledger). All writes flow through one journalled apply pipeline that expands relations, applies the planes, journals the operations, and publishes a single commit-bus batch.
- BREAKING: persistence moves from whole-collection snapshots to a write-ahead journal with per-row checkpoint entries and applied-epoch markers. v5 storage keys are not migrated; call `purgeForeignStorageKeys()` once at boot, after `replayJournal()`, to drop them from the MMKV instance.
- BREAKING: search is ephemeral. `useSearch` runs as a plain query with `gcTime: 0` and writes nothing into model planes, so repeated searches no longer accumulate persisted rows.
- Scope keys are namespaced by scope name. Two scopes of one model sharing a value shape no longer share membership, and empty-value scopes no longer collapse into one key.

### Apply pipeline and journal

- Journal every plan (ingest, replace, mutation) as row, scope, and counter operations before checkpoint flush; journal records prune only after a successful flush, and boot replay is idempotent.
- Split apply origins: event-origin ingest is tombstone-gated, so a stale websocket replay cannot resurrect a deleted row; only an explicit replace passes the gate.
- Persist dirty rows per-row at checkpoint instead of serializing entire collections on the JS thread.

### Lifecycle and reachability

- Fence the runtime generation across configure/reset: in-flight queries and mutations that resolve after a reset can no longer write previous-session rows into the next session.
- Reconcile hydrated pending operations at boot: they close as rolled back and their temp rows are removed - no immortal pending records, no permanently blocked dedupe keys.
- Add reachability GC: `collectGarbage()` evicts rows unreachable from live scopes, prunes dead-parent scope keys, and publishes evictions on the commit bus; scope retention bounds persisted membership.
- Add membership reverse indexes: scope membership checks and destroy detach use direct lookups instead of scanning every scope key.

### Query and mutation DSL

- `defineModel` / `defineQuery` / `defineMutation` are module-level definitions with model-owned statics; per-call data flows through scope and vars, not render closures.
- `defineQuery(...).use(scope, { enabled })` adds a per-call gate so UI enablement stays out of persisted scope keys.
- `DbReadOptions.limit` bounds sorted scope reads.
- Post-commit mutation callbacks are isolated; a callback throw no longer flips a committed operation to rolled back.

### Test coverage

- Contract suites pin the apply pipeline, tombstone gating, lifecycle fencing, and scope namespacing; invariant suites assert closed-form storage budgets, steady-state fixpoints, lifecycle pairing, and seeded property sequences. 52 suites, 325 tests at this tag.

### Known limitations

- The host app must schedule `collectGarbage()`; the library does not run it on its own.
- Reactive `use.where` / `use.first` / `use.count` and scope resorts recompute per relevant commit; index-backed reads are planned for 6.1.
- Boot hydration parses all retained rows and scopes; volume is bounded by GC retention, and lazy hydration is planned for 6.1.

## 6.0.0-beta.3 - 2026-07-15

- Full-pass round R1: lazy model planes, tombstone gate on ingest, persisted operation ledger, `replayJournal`, model invalidation registry, plan row validation, page refetch order, primitive scope keys, journal hot path (scope deltas, no plan hash), mutation guards, and removal of dead v5 code.

## 6.0.0-beta.2 - 2026-07-14

- Integration round: transport/queryClient accessors, `mapCursor`, mutate callbacks, `resetRuntimeSync`, checkpoint persistence, shape/type exports.

## 6.0.0-beta.1 - 2026-07-14

- v6 core: three-plane runtime, journalled apply pipeline, relations taxonomy, automatic scope membership, performance specs.

## 5.0.0 - 2026-07-14

### Breaking changes and migration

- BREAKING: `SyncContract.protectAfterSeq` is renamed to `snapshotSeq`. Replace and merge contracts created through the package resolvers receive the snapshot token automatically; contracts built only through resolvers are unaffected by the rename.

### Row version arbitration

- Add one row-version core for write and delete arbitration. Snapshot tokens and both-direction watermarks preserve concurrent writes and prevent resurrection of concurrent deletes without pruning either side of a concurrent update.
- Merge dedupe now keys batches by ordered `(id, updatedAt)` tuples instead of full-payload serialization.
- Add opt-in `merge.resurrectionTtlMs` for non-snapshot merges. It is disabled by default so legitimate same-id recreation remains allowed.

### Mutation and propagation lifecycle

- Split mutation execution into transport, apply, and persist phases. A transport failure rolls back optimistic state; a post-transport apply or persistence failure keeps server-confirmed truth and reports the failure without rollback.
- Make write propagation transitive with a visited-set cycle guard. Propagation is no longer globally suppressed after one hop.
- `runDbMutationDirect` patch and destroy continue to have no rollback. This documented asymmetry is unchanged.

### Persistence and query state

- Add deferred collection persistence: whole collections serialize once per flush window with a 300 ms debounce, 1000 ms maximum wait, and background flush. This replaces the string-level write-back buffer.
- Infinite query patch state is now keyed by query key.

### Known limitations

- Manual scoped replace through `applyServerData` outside query runtime, including extract paths, has no snapshot token.

## 4.2.0 - 2026-07-14

- Delete-tombstone watermark - rows destroyed during an in-flight request window are no longer resurrected by replace/merge inserts; merge contracts carry protectAfterSeq; comparator binding reads memoize sort output.

## 4.1.0 - 2026-07-14

- Replace write-seq watermark - concurrent writers during an in-flight request window are no longer pruned by initial replace. No consumer migration is required.

## 4.0.0 - 2026-07-14

- BREAKING: mutation and command transport dedupe is now opt-in through `dedupe.key(input)`; identical calls are independent by default, preventing legitimate repeated sends from being silently coalesced.
- Add `maxPages` to `useDbInfiniteRequest`, forwarding TanStack Query's bounded page-window option.

## 3.0.1 - 2026-07-13

- Fix `createDbSubscriptionEffects` generic constraint: effect tables declared as interfaces (no string index signature) are accepted via a self-referential `Record<keyof TEffects, ...>` constraint.

## 3.0.0 - 2026-07-13

- BREAKING: `createMutationExtractResolver` now throws on extract spec keys that are not declared in the preset table (config mistakes fail fast instead of being silently ignored).
- BREAKING: `ExtractSpecOf<TTable, TData>` selectors are now typed by the mutation result `TData` instead of the preset entry result, so consumers can derive their full typed extract spec from the preset table.
- BREAKING: remove `defineFields`; `defineShape<TInput>()(...).fields` is the single branding path for model field maps (`DefinedFields`/`InferFieldsInput` types remain exported).
- BREAKING: `readId` (and therefore `f.id()`) now rejects empty-string ids, matching the documented "empty values are skipped" contract.
- BREAKING: remove `toRequiredStr`; it stringified `null`/`undefined` into `"null"`/`"undefined"`. Use guaranteed-string values directly or `toStr` for nullish-preserving conversion.
- Add `createDbSubscriptionEffects`: an injectable effects channel for subscription entries with a stable wrapper table and `configure`/`reset` controls, replacing hand-rolled app-side noop/active indirection.
- Export `isIncomingNewer`, the canonical updatedAt comparator used by merge invariants.
- Internal: consolidate mutable runtime seams (logger/transport/storage/query client/model defaults/extract/tracking) onto one configured-slot helper, dedupe the base-query freshness gate, and unify mutation temp-id reading. No public API change.

## 2.5.1-beta.9 - 2026-07-12

- Keep relation model collection contracts read-only, so consumers can enable `strictFunctionTypes` without widening rows or using `any`.
- No runtime API or migration change: relation queries continue to use the model's concrete TanStack DB collection.

## 2.5.1-beta.8 - 2026-07-10

- Let `defineShape<TInput>()(...).fields` retain the raw input type when used as model fields.
- Keep the shape field brand type-only so runtime keys and stored/build types remain unchanged.

## 2.5.1-beta.7 - 2026-07-10

- Remove the experimental model extension composition API; `statics` is the single class-level model surface.
- Prevent `defineFields` input branding from leaking symbol keys into stored rows and `buildStored` inputs.
- Preserve relation-aware statics and side-effect-free `Model.normalize` for fields and custom-normalize models.

## 2.5.1-beta.6 - 2026-07-10

- Add type-only `defineFields<TInput>()` branding so fields models retain their raw normalization input contract.
- Expose side-effect-free `Model.normalize`, including opt-in complete-field validation for declarative fields models.

## 2.5.1-beta.5 - 2026-07-10

- Remove obsolete beta-only naming from the maintained release history; the public API remains unchanged from beta.4.

## 2.5.1-beta.4 - 2026-07-10

- Finalize the experimental beta.2-beta.3 composition API as `ModelExtension`, `defineModelExtension`, and `defineModel({ extensions })`; the beta-only old names are removed without aliases.
- Infer the final model surface from named extensions and `statics`, and export `FieldsModelBase` and `NormalizedModelBase` for separately defined extension modules.

## 2.5.1-beta.3 - 2026-07-10

- Preserve relation-aware row types inside experimental model composition and static factories, including lazy `row.related` access on normalized and fields-schema models.

## 2.5.1-beta.2 - 2026-07-10

- Add experimental named model composition with collision protection across the base model, composed capabilities, and statics.
- Add model-owned `Model.invalidate(scope?)` while retaining the free `invalidateModel(model, scope?)` helper for infrastructure compatibility.

## 2.5.1-beta.1 - 2026-07-10

- Narrow `pickPresent` output values to `NonNullable<T>` so the public type matches its existing runtime contract of dropping both null and undefined.

## 2.5.1-beta.0 - 2026-07-10

- Add `defineDbSubscriptionEntry` so typed GraphQL documents infer subscription root keys, variables, handler payloads, and debounce keys at the package boundary.
- Add `ModelStatusPoller.subscribe(id, listener)` for terminal snapshot observation without polling refs, including notifications on terminal stop, budget reset, and terminal session removal.
- Share mutation lifecycle execution between hook and direct paths. Direct mutations now run tracking start/error, `onError`, and post-success invalidation while retaining their documented non-transactional, no-insert, no-rollback behavior.
- Add own-property string-key `compositeId` overloads while preserving selector-based ids.
- Consolidate exact internal temp-id and non-array record readers without widening the public utility surface.

## 2.5.0 - 2026-07-09

Final stable release of the v2.5 consolidation line; merges 2.5.0-beta.1 through 2.5.0-beta.5 with no code changes on top of beta.5. The v2.5 round moves every generic data-layer mechanism into the package: typed reads and extract, relations with write propagation, a full subscription runtime with ingest primitives, model status polling, and command tracking. Verified end to end in the consuming application (full gate suite plus an on-device live subscription matrix) before this stable cut.

### Upgrade path

- From 2.5.0-beta.5: version bump only; no code or API changes.
- From 2.4.x or earlier: apply the rename table from the 2.5.0-beta.1 entry below, then read the migration notes here. All beta migration notes are consolidated in this entry.

### Breaking changes vs 2.4.0 (summary)

- Entry points and identity: `executeDbSingleRequest` -> `runDbQueryDirect`, `executeDbInfiniteRequest` -> `runDbInfiniteQueryDirect`, `getFirstWhere` -> `getFirst`, singleton `upsert` -> `upsertCurrent`, `_collection` -> `collection`, strict `readId`.
- `InfiniteQueryResult` canon: `items`/`refresh`/`fetchNextPage` -> `data`/`refetch`/`loadMore`.
- Gating canon: config `inactive` removed; single `enabled` knob. `enabled: false` means network-idle (phase `idle`, no fetching, `loadMore`/`refetch` guarded) while local collection reads stay live.
- Removed types: `FetchStatePageInfo`, `NormalizedPageInfo`, `DisplayState`, `DisplayStateInput`, `ServerSyncContract`, `ServerSyncMode`.
- 47 runtime exports pruned from the public barrel (full list in the 2.5.0-beta.1 entry).
- `useData(filter, disabled)` -> `useData(filter)`; the read-suppression channel was removed in beta.2.

### Intentional behavior changes

- `enabled: false` yields phase `idle` instead of an eternal `initial_loading` skeleton.
- Scope keys are canonicalized: `{}` equals the root scope, `undefined` fields are stripped, object key order is stable.
- Extract collisions for the same sink key merge into arrays instead of clobbering earlier values.
- Extract sinks dispatch in a model-first two-pass order.
- `runDbMutationDirect` applies optimistic destroy behavior (parity with the hook path).
- Single-request derived keys are salted with variables, so two configs of one model with different vars no longer share a cache entry.

### New API by area

- Schema: `fromKey`, `readFieldsPatch`.
- Typing: typed collection reads (`BaseQueryCollection` generic inferred from `read.model`), `ExtractSpecOf`, typed sideload `pluck`.
- Relations: `hasOne`, `belongsTo` write propagation (all child write paths including server writes), model `mirror`.
- Extract: `extractSource` on request/mutation/command configs, per-payload sink contracts, command-path extract.
- Subscriptions: `DbTransport.subscribe`, `createDbSubscriptionRuntime` (keyed trailing debounce, backoff resubscribe, dev inspection), `createKeyedBatchBuffer`, `createTombstoneLedger`, `patchWhenPresent`, `waitForRow`.
- Polling: `createModelStatusPoller` with refcounted attach, poll budget, `onSessionStop(id, reason)` and `isSessionTerminal(id)`.
- Commands: one execute choke point (`useCommand` routes through `runDbCommandDirect`) plus command `track` config sharing the tracking core with query/mutation paths.
- Misc: `mergeOptimisticMedia`, `useJoinedEntities`, `computePhase`, `replaceInitialSyncContract`.

### Migration notes

- Subscription runtime envelope contract: the runtime unwraps every transport result BY ENTRY KEY before calling `onData`. `onData(payload)` receives the value of the subscription root field, not the `{ data }` envelope. Reading `payload.<rootField>` again is the most common adoption mistake and fails silently (the handler early-returns on `undefined`). `runtime.dispatch(key, payload)` takes the same unwrapped shape, so test fixtures must not wrap payloads either.
- `enabled` inversion: former `inactive: true` sites become `enabled: false`; former `enabled: false` sites that relied on an eternal skeleton now render the `idle` phase and should gate UI on `computePhase` output instead.
- `InfiniteQueryResult` renames are mechanical; the single-request hook result is a TanStack `UseQueryResult` passthrough and did not change.
- `belongsTo` propagation replaces hand-rolled parent-preview sync: register a `propagate` callback on the child relation and delete manual writers; it fires on local writes, server writes, and reconcile paths, with a newer-than gate in the callback.

### Defect fixes (consolidated from the betas)

- Extract collision merge (`appendExtractValue` no longer clobbers on sink-key collision).
- Direct-mutation `destroy` parity with the hook path.
- `reconcileOptimisticRows` `onExisting: 'drop' | 'return'` (subscription echo of an optimistic row no longer requires app-side loops).
- Unconditional read hooks in `count()` bindings (Rules-of-Hooks hazard removed).
- Invalid mutation presets throw instead of being silently ignored.
- Vars-salted single-request derived keys.
- Write-propagation announce no longer depends on a state read-back inside an open collection transaction, so `belongsTo` propagate and model `mirror` fire reliably for server-ingested writes (beta.5).

## 2.5.0-beta.5 - 2026-07-09

- Fix write-propagation announce to use the definitively written row instead of a state read-back inside the open collection transaction: on device (Hermes) the read-back could miss a fresh insert, silently skipping `belongsTo` propagate and model `mirror` for server-ingested writes (reproduced on-device; not reproducible in jest). Updates now announce the post-update snapshot.
- Log previously-silent collection `update`/`delete` failures through the configured db logger instead of swallowing them.
- Align TanStack DB dev dependencies with the consuming app (`@tanstack/db` 0.6.14) so the suite tests the runtime actually shipped.

## 2.5.0-beta.4 - 2026-07-09

- Add `ModelStatusPollerConfig.onSessionStop?: (id, reason: 'terminal' | 'budget') => void`: fired once per poll-session end (terminal status reached or attempt budget exhausted), not on detach and not on budget reset.
- Add `ModelStatusPoller.isSessionTerminal(id)` for snapshot reads of a session's terminal state.

## 2.5.0-beta.3 - 2026-07-09

- Consolidate command execution: `useCommand.mutationFn` now routes through `runDbCommandDirect`, giving hook and direct command paths one execute choke point.
- Add command `track` config (`start` / `success` / `error`) on the command mutation base, sharing the `emitConfiguredTrackEvent` core with query/mutation tracking (no per-path tracking copies).

## 2.5.0-beta.2 - 2026-07-08

### Breaking changes vs 2.5.0-beta.1

- Relax `enabled: false` from full data blackout to network-idle semantics: TanStack Query execution, freshness scheduling, `loadMore`, and `refetch` stay disabled, while local collection reads stay live.
- Remove the collection-binding read-suppression channel added in beta.1: `useData(filter, disabled)` is now `useData(filter)`, and `CollectionBindingUseDataContext.disabled` is removed.

### Migration

- Consumers already on the beta.1 rename surface do not need extra app changes unless they adopted the temporary second `useData` argument or `context.disabled`; drop those beta.1-only usages.

## 2.5.0-beta.1 - 2026-07-08

### Breaking changes

| Old | New |
| --- | --- |
| `executeDbSingleRequest` | `runDbQueryDirect` |
| `executeDbInfiniteRequest` | `runDbInfiniteQueryDirect` |
| `InfiniteQueryResult.items` | `InfiniteQueryResult.data` |
| `InfiniteQueryResult.refresh` | `InfiniteQueryResult.refetch` |
| `InfiniteQueryResult.fetchNextPage` | `InfiniteQueryResult.loadMore` |
| `getFirstWhere` | `getFirst` |
| singleton `upsert` | `upsertCurrent` |
| `_collection` | `collection` |
| config `inactive` | config `enabled` with inverted meaning |
| `FetchStatePageInfo` | removed |
| `NormalizedPageInfo` | removed |
| `DisplayState` | removed |
| `DisplayStateInput` | removed |
| `ServerSyncContract` | removed |
| `ServerSyncMode` | removed |

- Prune 47 runtime exports from the public barrel. The following internals moved out of the public package surface: `DEFAULT_FETCH_STATE_MAX_AGE_MS`, `acceptPersistentCollectionMutations`, `clearAllFreshnessMetadata`, `clearCollectionFetchState`, `clearCollectionFetchStates`, `clearModelRegistry`, `createCollectionModel`, `createMerge`, `createPatchCrud`, `createPersistentCollection`, `createReplace`, `deriveDbKey`, `getCollectionFetchState`, `getCollectionFetchStateVersion`, `getDbExtractSink`, `getDbLogger`, `getDbMutationExtractResolver`, `getDbQueryClient`, `getDbStorageAdapter`, `getDbTransport`, `getRegisteredModel`, `isInManagedMutationBatch`, `isIncomingNewer`, `listCollectionFetchScopes`, `mmkvCollectionOptions`, `readBoolean`, `readString`, `refetchDbRequests`, `registerCollectionFetchStateCache`, `registerModel`, `registerModelRuntimeReset`, `registerPersistentCollectionMutationAcceptor`, `resolveMergedField`, `runInManagedMutationBatch`, `setCollectionFetchState`, `setDbExtractSink`, `setDbLogger`, `setDbMutationExtractResolver`, `setDbStorageAdapter`, `setDbTransport`, `shallowEqual`, `shouldAcceptIncoming`, `subscribeCollectionFetchState`, `toQueryValue`, `useCollectionRead`, `useCommandMutation`, and `useStableArray`.

### Intentional behavior changes

- `enabled: false` now yields phase `idle` instead of an eternal `initial_loading` state.
- Scope keys are canonicalized: `{}` equals the root scope, `undefined` fields are stripped, and object key order is stable.
- Extract collisions for the same sink key now merge into arrays instead of silently clobbering earlier values.
- Extract sinks dispatch in a model-first two-pass order.
- `runDbMutationDirect` now applies optimistic destroy behavior.
- Single-request derived keys are salted with variables.

### New primitives

- Defects and canonicalization: `reconcileOptimisticRows` `onExisting`, strict `readId`, unconditional read hooks, and invalid-preset throws.
- Schema: `fromKey` and `readFieldsPatch`.
- Typing: typed reads, `ExtractSpecOf`, and typed sideload pluck.
- Relations: `hasOne`, `belongsTo` propagation, and model mirror helpers.
- Extract: `extractSource`, sink contracts, and command extract support.
- Subscriptions: `DbTransport.subscribe`, `createDbSubscriptionRuntime`, `createKeyedBatchBuffer`, `createTombstoneLedger`, `patchWhenPresent`, and `waitForRow`.
- Misc: `createModelStatusPoller`, `mergeOptimisticMedia`, `useJoinedEntities`, `computePhase`, and `replaceInitialSyncContract`.

## 2.4.0-beta.1 - 2026-07-08

- Fix `createSchema.normalize` to drop non-object/null row sources instead of throwing, matching the existing defensive behavior of `readObjectField` used by every field reader. `applyServerData`/`merge` now tolerate sparse arrays (nulls mixed with valid rows) for every model, not just ones with app-side pre-filtering.

## 2.3.2-beta.0 - 2026-07-08

- Add IntelliSense-grade JSDoc for every value exported from `src/index.ts`, including schema builders, field-spec modifiers, shape helpers, relations, query/runtime helpers, and runtime primitives.
- Keep documentation current by removing the retired ActiveRecord README references and documenting array patchers in runtime primitives.

## 2.3.1 - 2026-07-08

- Add shape-derivation helpers: `projectShape`, `f.object(shape).emptyDefault()`, `createKeyedArrayPatcher`, and `createIdArrayPatcher`.
- Relax relation typing so real statics-extended fields models work in `hasMany` without casts.
- Make `hasMany` `dependent` optional; omitted relations are query-only and ignored by cascade destroy.

## 2.3.0 - 2026-07-08

- Add direct execution paths: `runDbQueryDirect`, `runDbCommandDirect`, and `runDbMutationDirect` support for patch mutations through `selectPatch`.
- Upgrade collection bindings with custom comparators, `useData` overrides, nullish disabled scoped reads, `mergeInitialSyncContract`, and `patchNode` `globalIndex`.
- Add shared primitives: `useStableEntity`, stable `useStableItems` defaults, `readShapeOrThrow`, read string shorthand helpers, `pruneExpiredRows`, and `createOptimisticSequence`.
- BREAKING: custom extract function sinks now receive lifted payload arrays; use `liftExtractNodes` for explicit normalization.
- Add relations: lazy `hasMany` with cascade destroy, `hasManyThrough`, related accessors, row-level related chains, `belongsTo`, and belongs-to touch propagation.
- Redesign freshness: `emptyStaleTime`, real `invalidateModel`, reactive fetch-state gate, destroy-scope coherence, freshness skip/clear logs, startup pruning through `configureDb`, and infinite `refetchOnMount`.
- BREAKING: known-empty fetch-state scopes default to `emptyStaleTime: 0`, so they no longer suppress network fetches unless explicitly opted in.
- BREAKING: remove the legacy ActiveRecord surface (`query`, `instance`, `useInstance`, `ModelRelation`, `ModelInstance`); use `CollectionModel` methods, relation accessors, and row-level related chains instead.

## 2.2.0 - 2026-07-08

- Add stable-view helpers: `useStableItems`, `useStableSorted`, `useStableArray`, `useOrderedEntities`, and `useWindowedLoadMore`.
- Add request runtime helpers: `invalidateModel`, `modelDetailRequest`, and scope-derived infinite request filters/variables.
- Add mutation ergonomics: optional derived `key`/`logPrefix`, optimistic `optimisticRow` context, `mergeOptimisticSnapshot`, and `preserveOnCommit`.
- Add declarative extract helpers: `createMutationExtractResolver` and `createExtractSink`.
- Add runtime primitives for subscriptions and maintenance: `reconcileOptimisticRows`, cleanup helpers, `createThrottledSingleFlight`, `createNestedObjectPatcher`, and `singletonStatics`.

## 2.1.0 - 2026-07-08

- Add field factory defaults with `.default(...)` and fields-model `buildStored(...)` for complete optimistic stored rows.
- Add `useDbMutation` declarative `optimistic` preset for temp-row insert, retry, and server commit flows.
- Add mutation `track` sections plus `configureDb({ trackSink })` for analytics-agnostic start/success/error events.
- Add `pickDefined` and `pickPresent` sparse-patch helpers for defined-only and present-only patch construction.

## 2.0.0 - 2026-07-07

- Add the declarative fields schema DSL with `f.*` builders, generated model normalizers, nested shapes, and model-derived `ModelStored` / `ModelInput` types.
- Add declarative model sideloads for syncing nested payloads into registry-named target models before parent writes.
- Add the model registry helpers `registerModel`, `getRegisteredModel`, and `clearModelRegistry`.
- Keep normalize-based models working unchanged; the new API is additive and does not introduce runtime breaking changes for existing models.

## 1.2.0 - 2026-07-06

- Add Rails-style model statics for composing model-level helpers from the base DSL with collision protection.

## 1.1.0 - 2026-07-06

- Add typed predicate reads with `DbWhere`, `DbReadOptions`, reactive `first`, and snapshot `getFirst` APIs.
- Add configured QueryClient imperative request APIs for invalidation, refetch, and runtime reset.
- Derive db request keys from models and scoped collection bindings with `deriveDbKey`.

## 1.0.4 - 2026-07-06

- Fix `configureDb` modelDefaults init-order: the `dedupeWindowMs` default is now resolved lazily per merge call, so calling `configureDb` after models are created still applies the default. Per-model explicit values keep winning; regression test added.

## 1.0.3 - 2026-07-06

- Export `computeLoadingState` from the public API.
- Add public `Model.collection` accessor for live-query joins and snapshot reads (replaces private `_collection` reach-ins; `_collection` kept for compatibility).
- Add `configureDb({ modelDefaults: { merge: { dedupeWindowMs } } })` global default.
- Port model-core, merge-invariants, and temp-id test coverage from the consuming app.

## 1.0.2 - 2026-07-06

- Expose `createUniqueIds`, `EMPTY_IDS`, and `pickEqual` from the public API for consumers building query stability/id helpers.

## 1.0.1 - 2026-07-06

- Track the prebuilt `lib/` in git so GitHub-tag installs ship usable output. Yarn does not run `prepare` for git dependencies, so the `prepare` script was removed.

## 1.0.0 - 2026-07-05

Extracted from a production React Native application where it powers the app's local-first, GraphQL-backed data layer; 1.0.0 packages that engine as a standalone, dependency-injected library.

Included:

- Model DSL: `defineModel`, `CollectionModel`, reactive reads, snapshot reads, merge/replace sync, and freshness metadata.
- Query DSL: `useDbSingleRequest` and `useDbInfiniteRequest` over `TypedDocumentNode` GraphQL operations.
- Mutation DSL: `useDbMutation` with optimistic writes and rollback, patch/destroy variants, and `useCommand`.
- ActiveRecord DSL: `query`, `instance`, and `useInstance` convenience handles.
- Injectable GraphQL transport, storage with MMKV default, logger, and extract seams via `configureDb`.
- Full `docs/` reference and JSDoc across the public API.
- Dedicated Jest test suite.

# Changelog

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

# Changelog

## 10.0.0-beta.14 - 2026-08-04

### Breaking changes and migration

- BREAKING: `StoragePlane.set` accepts 1 key and value. Migration: remove batch adapters and implement synchronous single-key writes.
- BREAKING: mutation retry policy is removed. GraphQL mutations never retry automatically.
- BREAKING: `once: true` requires `dedupe.key`. The runtime namespaces the key by model and action.
- `RowOperationState` adds `deliveryUnknown`. Transport adapters throw `MutationDeliveryUnknownError` only when delivery cannot be proved.

### Fixed

- Row changes and operation transitions share 1 immutable WAL record and 1 ordered checkpoint.
- A durable reset intent completes namespace resets after process death and restores compatibility metadata before boot.
- Query family invalidation uses 1 revision record, so process death cannot leave sibling query records fresh.
- Durable correlation registers before the first operation. Unknown mutation delivery preserves optimistic rows without sending the mutation again.

## 10.0.0-beta.10 - 2026-08-02

### Fixed

- WritePlan.update rejects explicit undefined patch fields before commit, preserving the root response, target row, and invalidations as one atomic planning boundary.

## 10.0.0-beta.9 - 2026-08-02

### Breaking changes and migration

- BREAKING: actions, remote queries, and live ingest replace cross-model after, invalidate, and extract callbacks with one write(context, plan) callback. Migration: declare plan.upsert, plan.update, plan.destroy, and plan.invalidate intents inside write.
- BREAKING: remove intoIf, ExtractSink, PlanRowsSink, model views, reachability garbage collection, gc, inSessionGc, and dropIdleScopesAfterMs. Migration: use model relations and scoped reads; use maintenance only for bounded temporary-row and per-scope retention.

### Added

- WritePlan - actions, remote queries, and live ingest commit root landing and cross-model writes in one envelope, then run invalidations after commit.
- Model-local schema fingerprints reset only incompatible model rows, scopes, query buckets, and operations; compatible models stay durable.

### Fixed

- A failed manifest read cannot silently erase runtime data; new models persist without resetting existing models.
- Query and relation freshness follows committed membership, reader ownership, and invalidations while React Query owns request scheduling.
- Persisted query buckets and observer wiring are shared per query identity, preventing sibling readers from racing or duplicating lifecycle work.
- Operation records without a current owner remain readable and do not corrupt the registry.

## 10.0.0-beta.8 - 2026-08-01

### Fixed

- Store collections no longer lose their rows to the collection library's own retention timer. A model left without a mounted reader for five minutes had its rows cleared behind the store, while the indexes built over the collection kept their keys, so the next scope projection read rows the collection no longer held and threw. Every collection this package builds now declares store-owned lifetime.
- A mounted reader whose declared filter changes now serves the new filter on the same render instead of keeping the previous result.
- A filter comparing a field to `null` selects the rows whose field is `null`, and `notIn` admits a row whose field carries no value, on both the row predicate and the live query.

### Changed

- Model reads (`find`, `where`, `exists`, `count`, `first`, `pluck`) are compiled into live queries of the collection engine; the package no longer carries its own read engine. One declaration is served by one live query however many readers hold it, and a commit reaches only the queries whose result it changes.
- Ordering follows one total order across the live query and the comparator: an ordered value first, then a value with no position in its own type (`NaN`, an invalid `Date`) which reverses with the direction, then absence which stays last either way.

### Removed

- The `contains` filter operator. The engine's pattern match treats `%` and `_` as wildcards and has no escape, so a literal search containing them would give a live query a wider answer than the row predicate.
- The `readEngineRebuilds` diagnostic counter: with queries maintained incrementally, no path recomputes a whole result.
- The `@tanstack/react-db` and `@tanstack/query-db-collection` dependencies, which no code imported.

## 10.0.0-beta.7 - 2026-07-31

### Fixed

- Rows held by open operations (pending and failed-retryable) survive every planning cut, not only TTL and GC: a complete-coverage server snapshot keeps a held member it cannot confirm, retention-trim never cuts a held row and does not spend budget on it, and a held row keeps its comparator position among freshly landed snapshot rows. An optimistic send no longer disappears from a sorted thread while its confirmation is in flight.
- An invalidate that lands while the same query or fetch is already in flight is no longer satisfied by that response: the run detects the newer invalidate after landing, restores the invalidated mark, and performs exactly one follow-up refetch. This covers model invalidation, scope invalidation, and foreground-resume staleness for both `defineQuery` and `defineFetch`.
- Destroying an id whose row never existed is a no-op for relation effects: it does not cascade into orphan children that merely carry the id as a foreign key and does not touch parent counters.

### Changed

- The operation ledger exposes `openRowIdsFor(model)` - the single protection root projected for scope planning. Row-bucket lookups drop tautological model re-checks.

## 10.0.0-beta.6 - 2026-07-31

### Fixed

- Query freshness follows result materialization, not row survival alone. A row that stays alive while leaving its destination scope - through a complete-coverage snapshot, retention trim, or garbage-collected membership - is pruned from the chain that landed it, and a chain that keeps nothing goes stale. A reader whose scope emptied this way refetches instead of serving the empty result for the rest of the freshness window.
- Committed row destruction and committed membership loss reconcile through one feed instead of two mechanisms, and only registered chains are pruned, so a cached payload that merely looks like a chain is never touched. Identity replacement stays materialized and leaves freshness intact.

## 10.0.0-beta.5 - 2026-07-31

### Added

- Write groups accept `policy: 'local'` for fields that may be created and patched locally but must survive every server snapshot and optimistic identity replacement. This replaces consumer continuity and monotonic workarounds for client-owned fields.

### Fixed

- Entity rows and relation memberships publish as one store transition, so live relations observe only the final identity after optimistic replacement instead of an intermediate missing row.
- Replace transitions apply local, continuity, snapshot, and nested-key write policies before removing the prior identity.
- Insert actions without an optimistic builder commit the row selected from the server response.
- Custom `rowId` extraction normalizes query results, relation landings, mutation responses, and inverse plans through the model field codecs.
- Relation `by` keys reject both missing and null mapped values before creating an incomplete scope identity.
- Empty page connections resolve to an empty result instead of being interpreted as a model row.

## 10.0.0-beta.4 - 2026-07-31

### Fixed

- Named relation parameters require every mapped `by` key even when a transport callback declares that key optional, keeping the public type aligned with runtime relation identity.

## 10.0.0-beta.3 - 2026-07-31

### Added

- `scalar.<kind>.read(value)` and `scalar.<kind>.require(value, label)` expose the model field codecs for individual transport values, including `scalar.enum(values)`, and replace consumer-owned one-field shape wrappers such as yupi_v2 `transportScalars.ts`.

## 10.0.0-beta.2 - 2026-07-31

### Fixed

- `Model.invalidate(partialValue)` invalidates relations covered by the supplied fields and skips relations whose `by` keys are not covered, without throwing.
- Relation scope values pass through their field codecs before query identity, GraphQL variables, registration, matching, and response landing, so equivalent typed inputs share one request and cache entry.

## 10.0.0-beta.1 - 2026-07-30

### Breaking changes and migration

- BREAKING: `defineModel(key, config)` is the only public model constructor. Migration: replace former model constructors with one model declaration exposing flat relations, `actions`, `events`, reads, writes, operation state, and domain statics.
- BREAKING: model config uses `schema`, `associations`, `relations`, `actions`, `events`, and `sideloads`. Migration: move former `fields`, `scopes`, model query/mutation/view/ingest builders, detached operations, and pollers into these declarations.
- BREAKING: `Relation` owns snapshot reads, subscribed reads, counts, invalidation, local window growth, remote pagination, refresh, loading state, and errors. Migration: replace separate scope/query/window surfaces with the named relation.
- BREAKING: `gql.single`, `gql.connection`, `gql.action`, and `gql.live` infer transport data and variables from `TypedDocumentNode`. Migration: bind typed documents directly and remove duplicated transport result and variable types.
- BREAKING: scalar coercion belongs to typed field codecs; standalone `readId` and `stringifyNullish` exports are removed. Migration: use `f.num()`, `f.int()`, `f.bool()`, and model field codecs at the transport boundary.

### Fixed

- Sideload traversal plans every model write before one atomic envelope commit, deduplicates model/id destinations, and terminates cycles.

## 9.0.0-beta.14 - 2026-07-30

### Fixed

- `ConnectionLike` accepts codegen-shaped nullable relay payloads - `nodes: (T | null)[] | null`, `edges: (Edge | null)[] | null`, `pageInfo: ... | null` - so the `connection:` shorthand types against generated GraphQL responses without casts; a nullable edge element no longer crashes node extraction.


## 9.0.0-beta.13 - 2026-07-30

### Added

- `useLoadMore(target, { debounceMs?, enabled? })` - the standalone debounced list-footer advance behind `useWindow`'s `loadMore`: works over any surface carrying `hasNextPage`/`isFetchingNextPage`/`fetchNextPage` (`LoadMoreTarget`), guarded at fire time and suppressible via `enabled`. Retires the consumer's `useDeferredLoadMore` re-implementation.
- `emptyStaleTime` in `Model.query`/`defineQuery`/`Model.fetch`/`defineFetch` configs now accepts a freshness class name from `defaults.freshnessClasses`, resolving like `staleTime`; an unknown name throws on the first run. Retires the consumer's last numeric freshness-dictionary lookup (`FRESHNESS.EMPTY_RETRY`).


## 9.0.0-beta.12 - 2026-07-30

### Breaking changes and migration

- BREAKING: remove the `scope()` builder. Migration: declare scopes as plain `ScopeSpec` object literals - `scopes: { thread: { by: { chatId: 'chatId' }, sort: { field: 'createdAt', dir: 'asc' } } }`. `defineModel` now provides full contextual inference for literal scopes (`member`/`comparator` parameters are typed, `by`/`sort` field names are checked), so no wrapper is needed; the `StructuralScopeSpec` type is removed with it.
- BREAKING: remove the write-only membership-edge surface - `QueryConfig.edge`, edge payloads on scope entries, journal scope-delta `edge` fields, and `ScopePlacement` edge capture. Edge data had no read surface, so no consumer migration exists. `DB_FORMAT_VERSION` bumps to 6: on-device storage written by an edge-era build cold-resets once on first boot and refills from the server.
- BREAKING: `StorageAdapter` loses `clear()`. The runtime never called it - cold reset deletes keys individually - so custom adapters simply drop the method.

### Declarative reads

- `ViewConfig.sort` - declare view-item ordering with a single field, a key list (per-key direction, missing-values-last, id tie-break), or a comparator over the mapped item. Replaces app-side re-sorting of view results.
- `ViewConfig.filter` - `(row, included) => boolean` predicate evaluated after include resolution, so a view can filter by joined data (e.g. a chat list filtered by its joined opponent). `totalCount` reflects the filtered set.
- `configureDb` gains `defaults.freshnessClasses: Record<string, number>`; `staleTime` in `Model.query`, `defineQuery`, `Model.fetch`, and `defineFetch` configs now also accepts a class name. An unknown class name throws on the first run of the query, naming the class.

### Durability and integrity

- The WAL journal's committed-epoch index advances only after its storage batch succeeds: `committedEntry`/`pruneCommitted` return a write plan (`entries` + `commit()`), so a failed `storage.set` retries with the full prune-delete set instead of silently leaking committed records past the retention cap.
- The checkpoint scheduler keeps its pending-plan backlog when a flush write throws; the cap-forced flush still fires on the next plan instead of restarting the count from zero.
- A commit that throws after its WAL record became durable is recovered by the next replay (contract pinned; `applyTransitions` never writes storage - durability belongs to the prepared WAL batch, also pinned).
- An operation-ledger no-op transition (status mismatch or unknown id) no longer strips the hydrated resume mark, so a pending optimistic operation cannot silently lose its boot-resume slot.
- `generateTempId` is monotonic under wall-clock rollback: an NTP correction can no longer re-issue an already-used timestamp+counter pair.
- `hasMany` `dependent: 'destroy'` cascades build a plan-local FK index: destroying N parents in one plan scans the child model once per relation instead of once per parent (new `relationChildScans` diagnostics counter).
- The committed-row loss feed can only ever touch query chain metadata: a cached fetch result whose payload happens to carry an `ids` array is untouched by row destroys (contract pinned on the fetch cache envelope).


## 9.0.0-beta.11 - 2026-07-30

### Breaking changes and migration

- BREAKING: remove `QueryConfig.map`. Migration: a `map`-only config becomes `select` with identical semantics (`map: fn` -> `select: fn`); a `select`+`map` pair composes into one `select`.
- BREAKING: `QueryResult.data` is now typed by destination - a scope-destination query and a paginated (`page`/`connection`) model-destination query read `T[]`; a non-paginated model-destination query reads `T | undefined`. Migration: delete app-side re-declarations and `as unknown as` casts of query results.
- BREAKING: `FetchResult.error` narrows from `unknown` to `Error | null` (the runtime already produced only that).
- BREAKING: `createDbSubscriptionEffects(...).reset()` no longer unregisters the channel's effect names; it only restores noop implementations. An ingest `effect` stays resolvable after logout/reset.

### Durability and identity (core fixes)

- `hasCommitted(idempotencyKey)` no longer probes the operation ledger with operation ids, so an idempotency key can never falsely collide with an unrelated committed operation id.
- WAL replay applies every pending journal record even when `txId` values collide across process restarts (two crashes in a row could previously mark a pending record committed without applying it).
- Sorted-scope placement assigns unique order keys to rows that are not yet resolvable in the plan overlay (previously all such rows in one placement shared one key).
- Write policies restore a field the previous row never had by omission - `continuity`, monotonic rejection, and nested key policies no longer inject explicit `undefined` into persisted rows (which made the checkpoint flush throw away its whole batch).
- The commit-envelope plan normalizes non-string ids across `patch`/`counter`/`destroy` branches, so one overlay identity survives the batch and a destroyed row can no longer resurrect through a same-batch patch.
- A full scope entry set supersedes delta state accumulated earlier in the same commit - a stale detach can no longer erase a membership the authoritative snapshot just declared.
- `configureDb` re-entry rebinds every model plane to the newly configured storage (previously cached planes kept serving rows hydrated from the previously configured storage until `resetRuntime`).
- A snapshot scope read (`toArray`) no longer creates and leaks a live scope collection; live collections are born only on subscribe.

### Reactivity and lifecycle

- Model reads keep ONE commit-bus subscription across re-renders (previously every render of `use.find`/`use.first`/`use.where` unsubscribed and resubscribed).
- A throwing debounced subscription `onData` delivery is contained and reported through `onSyncError` (+`errorCount`) instead of escaping the timer unhandled; the synchronous `dispatch` path still rethrows to its caller.
- `createThrottledSingleFlight` gains `resetOnRuntimeReset` (mirrors `createSingleFlight`), so a stale throttle window never suppresses post-reset callers.
- `configureDb` validates `defaults.resumeRefetch.chunkSize` at configure time instead of throwing from the first foreground resume.

### Queries and pagination DSL

- `ViewWindowResult` gains `resolved` (mirroring `ScopeWindowResult.resolved`), so a view window bridges into `bridgeWindowPagination` unchanged. This corrects the `7.0.0-beta.7` note that claimed the field already existed.
- Scope-destination queries gain `queryHandle.useWindow(scope, { pageSize?, renderKeys?, require?, keepPrevious?, enabled?, loadMoreDebounceMs? })` - the bridged local-window/network surface (`WindowPaginationBridge`) built in, plus `loadMore()`, a trailing-debounced (160ms) guarded list-footer advance.
- `QueryConfig.connection` - relay-connection shorthand: point at the connection object and the query pages it with dense nodes (`fromNodes` applied) and `pageInfo` passthrough; mutually exclusive with `page`/`select`.
- `QueryConfig.requiredScope` - declare the scope keys that must be non-nullish for the query to run; a nullish key holds the query inactive, replacing hand-written `enabled: s => s.x != null` guards.
- `FetchConfig.key` is now optional (matching the runtime and `Model.fetch`).

### Scopes and ordering

- `scope({ sort })` accepts a declared key LIST - `[{ field: 'sequenceNumber', dir: 'desc' }, { field: 'createdAt', dir: 'desc' }]` - with per-key direction, missing-values-last per key, and the implicit id tie-break. Multi-level orderings no longer need a hand-written comparator plus `orderFields`.

### Utilities

- `readId` is exported: the exact id coercion `f.id()` applies during `build`/`normalize`, for ingest/subscription handler paths that compare payload ids with stored rows.

### Documentation

- Document `optimistic.correlate` (the mandated cross-channel temp-row correlation) in mutations.md; correct the stale `@returns` on `defineMutation`/`defineCommand` (`{ run, retry, discard, use }`); fix the unscoped package name in one runtime.md import; document multi-key scope sort and the bridged query window.

## 9.0.0-beta.10 - 2026-07-29

### Fixed

- Let `query.useRowEnsured(..., { require })` treat an existing partial row as absent until its required fields land, while retaining the single forced retry only for a truly absent stored row.

### Testing

- Add red-first and mutation-proven coverage for fetching a partial ensured row exactly once when a required detail field is missing.

## 9.0.0-beta.9 - 2026-07-29

### Fixed

- Return the rows committed by `Model.query(... into: Model).use(scope)` and derive `loadingState` from the same result, preventing successful single-row reads from publishing a terminal empty state.
- Retain every loaded page identity in direct-model paginated query results instead of replacing prior pages with the latest page.
- Classify non-paginated direct-model query freshness from its committed row count instead of treating every result as empty.

### Testing

- Add red-first and mutation-proven contracts for single, array, empty, restart-identity, pagination, and freshness behavior across model and scope destinations.

## 9.0.0-beta.8 - 2026-07-29

### Fixed

- Enforce the single `src/types` declaration store for indented and nested `type` or `interface` declarations in production modules.

### Testing

- Calibrate the type-discipline gate red-first against existing nested declarations and an isolated indented mutation.

## 9.0.0-beta.7 - 2026-07-29

### Fixed

- Preserve the full `defineModel` row, scope-parameter, and statics types when an inferred scope `member` or `comparator` callback accepts a `Pick` of the fields it reads.

### Testing

- Add a red-first compile contract covering different row subsets in named `member` and `comparator` callbacks on one parameterized scope.

## 9.0.0-beta.6 - 2026-07-29

### Breaking changes and migration

- BREAKING: `query.useRowEnsured(...)` now returns its materialized row as `data` instead of `row`, aligning ensured point reads with every other query result. Replace `.row` destructuring and access with `.data`.
- BREAKING: `Model.mutation(...).run`, `.retry`, and hook `mutateAsync` now resolve to the non-null payload at the declared `result` field instead of the outer GraphQL response envelope. Remove app-side `?.<result> ?? null` adapters.
- BREAKING: remove `reconcileOptimisticRows` and its option types from the public API. Declare insert identity once with `optimistic.correlate`; query, scope, extract, ingest, seed, and mutation landings use the same ledger-backed correlation path.
- BREAKING: field-based ordering accepts only orderable scalar domains. Non-orderable field specs fail at definition or type-check time; use an explicit comparator for structured domains.
- BREAKING: `registerReset` accepts synchronous resetters only. Runtime reset never schedules unobserved asynchronous cleanup.

### Identity and atomicity

- Encode composite identity and scope keys injectively, so embedded delimiters cannot alias unrelated rows, scopes, operations, or reader keys.
- Commit row operations, operation-ledger transitions, WAL state, relation effects, and scope repositioning as one envelope and one publish epoch. Failed post-WAL apply restores every touched model before rethrowing.
- Reposition all affected sorted-scope members after batched changes without dropping or misordering peers.

### Persistence and lifecycle

- Validate persisted rows, scopes, journals, operations, and manifests structurally before hydration; quarantine corrupt records without trusting partial objects.
- Preserve exact large numeric values, array holes, explicit `undefined`, non-finite numbers, and negative zero through stable serialization and persistence codecs.
- Fence queries, mutations, subscriptions, pollers, detached operations, maintenance, and scheduled checkpoints to one runtime generation so pre-reset work cannot mutate the next session.
- Keep checkpoint scheduling, maintenance, reset callbacks, subscription delivery, and sync-error reporting on one canonical owner path.

### Runtime ownership and performance

- Delegate row storage and collection pacing to TanStack-backed owners, centralize freshness checks, and remove duplicate local registries, equality helpers, retry and backoff formulas, generation fences, and sync-error paths.
- Split apply execution, target registration, commit-envelope planning, ordering, freshness, generation registries, and sync-error reporting into single-purpose modules guarded by structural zoo tests.
- Shard Jest deterministically, verify generated `lib/` artifacts in CI and pre-commit, and keep every shard below the 30-second budget.

### Testing

- Add red-first and mutation-proven contracts for mixed found and missing identity maps, account switching, injective keys, atomic WAL recovery, scope repositioning, durable-state validation, generation fencing, channel-agnostic correlation, payload return shapes, and exact public surface ownership.

## 9.0.0-beta.5 - 2026-07-29

### Added

- Add optional per-bucket `debounce.merge` to subscription entries so partial payloads can coalesce without dropping fields.
- Add `onSubscribe`, invoked after every successful initial or retry subscription attempt, so consumers can reconcile authoritative snapshots after a disconnected interval.

### Fixed

- Rebuild a declaratively sorted first-page reset from the incoming page plus every retained member, then assign one global order. A refetch can no longer pin refreshed rows ahead of newer retained rows.
- Continue a pagination cursor only for explicit `fetchNextPage`. Mount, invalidation, resume, and manual refetch always restart at the first page.

### Testing

- Add red-first regression contracts for retained-union ordering, first-page cursor reset, lossless partial subscription debounce, and reconnect reconciliation.
- Extend the chat-list subscription contract to assert that realtime `lastActivityAt` changes reposition rows in both directions.

## 9.0.0-beta.4 - 2026-07-29

### Fixed

- Fix a `ladder` monotonic write-policy guard treating an explicit `null` stage value as an unranked tier instead of an absent one, rejecting the entire guarded field group. Any nested field sourced through `f.enum(...).nullDefault()` always materializes as `null` rather than staying absent, so every write to a field whose ladder path legitimately has no tracked stage (for example a photo message's `media.transcodeStatus`, which only videos populate) was rejected outright - permanently discarding the rest of the payload in the same group, including `media.fileUrl`. `null` now abstains from the ladder check the same way an absent key already did, matching the null-as-absent convention used everywhere else in the write-policy engine.

## 9.0.0-beta.3 - 2026-07-29

### Breaking changes and migration

- BREAKING: scope order is now ONE persisted lexical fractional key. `ScopeEntry` carries `orderKey: string` instead of a numeric `order` (the half-dead `seq` field is gone), order keys are born once at write-planning time, and every read surface - live scope queries, `Model.view`, imperative `scope.read()`, `scope.useCount` - is a mechanical projection of the persisted entry order with zero comparators on the read path. `DB_FORMAT_VERSION` bumps 3 -> 4: on first boot after the upgrade the on-device cache cold-resets (a fresh sync rebuilds it); no code changes are required in consumers that stayed on the public DSL.
- BREAKING: `scope.useCount` now counts the same materialized require-gated row set that `use()`/`totalCount` serve, so a membership without a loaded row is no longer counted (previously it counted raw scope entries).
- BREAKING: `DbDefaults.networkMode` is removed (it was accepted and ignored). React-query's own network mode stays pinned to `'always'`; connectivity is coordinated exclusively through the new `setFetchNetworkOnline` entry point.
- BREAKING: dead read options are gone from point-read signatures - `query.use.find(id, opts)` and `useRowEnsured(scope, rowId, opts)` no longer accept `orderBy`/`limit` (they were accepted and ignored on a by-id read).
- Legacy colon-format scope-key migration is removed together with the `scopeKeyMigrations` diagnostics counter: after the v4 cold reset there is nothing left to migrate. A persisted scope key that does not belong to a declared scope is dropped as corrupt at hydrate (with a `corrupt-scope` data-loss note).

### Scope order

- `keyBetween`/`keyBefore`/`keyAfter`/`keysForSequence` (internal `core/orderKey`) form the single home for order keys: base62, codepoint-compared, unlimited precision; bulk landings distribute keys evenly instead of degrading through chained midpoints, and over-tight bounds fall back to a chained walk instead of throwing.
- Same-order page landings keep existing keys (zero membership writes - now measured by the `membershipWrites` work counter), shuffled payloads of unchanged rows keep the canonical order via plan-time canonicalization, and a row detached by its own plan is never re-added by a reposition pass.
- GC publishes through the same store-projection seam as commits (`publishProjectedBatch`), so a scope removed by GC can no longer resurrect through orphaned store memberships; a structural gate fails any data-carrying commit batch published outside the seam.

### Reset and definition registries

- Definition registries now survive `resetRuntime` with keyed-replace semantics: subscription effects stay resolvable after a reset, boot validations declared before a reset run on the next boot (`registerBootValidation` is now keyed), and re-registering the same query/model definition replaces its invalidation callback and resetter instead of accumulating dead closures (`registerKeyedReset`).
- `defineFetch` offline-pause state belongs to one runtime generation: after `resetRuntime` the next generation starts unpaused.

### Freshness and network

- `setFetchNetworkOnline(online)` is public on the barrel: wire the host's reachability source (e.g. NetInfo) once and the coordinator pauses query/fetch requests and holds subscription retries while offline, resuming and resubscribing on reconnect. Subscription reconnect backoff now shares the one `backoffDelayMs` formula with the query/mutation retry policy.
- `QueryConfig.maxPages` is enforced: reaching the ceiling reports `hasNextPage: false` and `fetchNextPage` stops issuing requests.
- `DbDefaults.refetchOnMount` now applies to `Model.query` mounts as well as `defineFetch` (per-query `refetchOnMount` still wins).
- A query whose committed rows were evicted by GC drops its freshness lazily and refetches on the next mount, same as destroyed rows.

### Durable operations

- A failed-but-retryable optimistic insert now keeps its temp row protected from BOTH the temp-row TTL and GC for as long as the ledger operation stays open; discarding the operation releases the row. One protection root: `operationState.open()` (pending + failed) feeds TTL, GC marking, and replay orphan cleanup.

### Internals

- One home per behavior: reader-local pause state shared by `defineQuery`/`defineFetch` (`createKeyedLocalState`), `isFetchedResult`, `toTimestamp` replaces a local date parser, dependency signatures use the canonical NUL composite key, reader-key serialization uses `stableSerialize`, and module-private helpers (`useReadEngineHarness`, `readPersistenceManifest`, `snapshotDiagnostics`/`resetDiagnostics`) lost their unused `export`s.

## 9.0.0-beta.2 - 2026-07-28

### Internals

- Finish the types-store extraction: every `type`/`interface` declaration now lives in `src/types/<area>.<subject>.types.ts` (91 module-local declarations moved), structurally duplicated shapes are collapsed into shared generics (`RowRecord`, `StoredRow`), and every moved type carries editor-facing JSDoc. A new surface gate turns any declaration outside `src/types` into a red test.
- True up spec wording and suite names to the TanStack core (`c-merge-policy` -> `c-write-policy-groups`; stale mirror-era comments removed).

### Documentation

- Remove phantom API mentions from docs: `mergeOptimisticSnapshot`, `patchWhenRowExists` (renamed `updateWhenRowExists`), `BootDbOptions`/`bootOptions.wipe` (`DbProvider` takes no boot options; a deliberate empty-store boot goes through `resetRuntime()` or a `dataVersion` bump). The export-reference table is now gated two-way against the real barrel.

## 9.0.0-beta.1 - 2026-07-28

### Breaking changes and migration

- BREAKING: `@tanstack/db` collections are now the primary row store - the entity and scope-membership collections are the single runtime copy of every row (the previous planes/adapter/mirror stack held up to four). Reads, scopes, write policies, relations, persistence format, and the WAL journal are unchanged for consumers. One declared deviation: model reads without an `orderBy` and without a model `defaultOrder` now return deterministic id order instead of insertion order (insertion order never survived a restart).
- BREAKING: query and fetch freshness now runs on `@tanstack/react-query` (a package-owned client; TanStack stays fully encapsulated - no provider, no re-exports). `staleTime`/`emptyStaleTime`/`resumeStaleTime`, the retry policy formula, offline pause and resume chunking keep their existing semantics; rows still land through the store's write seams, never through a query cache.
- `Model.query`/`defineFetch` runtime dependencies: `@tanstack/react-query` and `@tanstack/query-db-collection` are new pinned dependencies.

### Added

- Add `optimistic.correlate` (`{ fields, match?, createdAtWindowMs? }`) to insert mutations: channel-agnostic correlation that replaces a pending optimistic temp row with the matching server row no matter which channel lands it first - query landing, scope landing, ingest echo, or the mutation's own response - and closes the pending operation. Opt-in per mutation; candidates come from the durable operation ledger only.

### Fixed

- Fix scope reads dropping a member row after a reorder; ordered scope reads now retain the full current membership.
- Fix a forced same-key refetch racing an older in-flight response: the newer request now cancels and supersedes the older one synchronously, the superseded call resolves silently, and an older response that resolves last can never overwrite the newer applied result.
- Fix `invalidate` refetching scopes that no one is reading: invalidation drops freshness for every registered scope, but only mounted readers refetch.

### Internals

- Delete the scope mirror/adapter stack (`EngineAdapter`, `entityState`, the fetch ledger and its request-state machine) - collections plus the react-query client own those responsibilities now. Scope projections, local windows, `keepPrevious`, resolution, and row identity remain unchanged; diagnostics report `scopeReadPasses` and `scopeReadResorts`.

### Persistence and reconciliation

- Add `Model.detached(kind, config)`: a durable operation lifecycle for immediate temp rows whose consumer-owned executor completes later. Open entries survive restart, core resumes them once after hydration and before GC, and orphaned or throwing executors apply the declaration failure policy with inspectable loss diagnostics.
- Reject GraphQL responses carrying non-empty `errors` before mutation, query, or fetch data is applied. Transport consumers must now populate optional `DbTransport.errors`, including partial responses with `data`, or the library cannot classify that response as a failure.
- Persist serializable failed optimistic-insert inputs in the operation ledger so `retry(tempId)` survives runtime restart; report and skip retry for unserializable input. Optimistic insert declarations now require `maintenance.dropTempRowsAfterMs`.
- Preserve relation counters and dependent children across optimistic identity swaps: the `replace` destroy half is now neutral for relation effects, while ordinary destroy behavior is unchanged.
- Recover persisted entity rows, tombstones, and scope keys per corrupt key instead of cold-resetting an otherwise valid model cache.
- Add mutation-proven reverse scope-index cleanup coverage for reconciliation, retention trim, scope eviction, and destroy detach paths.
- Fix `computeSchemaFingerprint` sorting declaration ids by locale-dependent order (`localeCompare`) instead of codepoint order - reuse the canonical `compareCodepoints` comparator so the persistence-compatibility fingerprint is stable across locales and environments.
- Reject an unparseable (non-`Date`-parseable) `updatedAt` string the same way as a nullish one in `isIncomingNewer`: an incoming value that fails to parse can never prove novelty (rejected), and an existing value that fails to parse can never block a parseable incoming write (accepted). Previously both cases silently fell through to a `NaN` comparison that always resolved to `false`.
- Fix `resolveStaleTempRows` treating a temp row with an unparseable `createdAt` as permanently protected from cleanup; it is now treated as maximally stale and resolved immediately instead of leaking forever.

### Testing infrastructure

- Replace wall-clock performance gates with deterministic work counters for scans, incremental read application, commit fanout, scope churn, and app-shaped account/refill flows.
- Bind the jest `react-native-mmkv` fake to the real package's `MMKV` instance type (`ReturnType<typeof createMMKV>`) instead of a hand-written mirror, so a future API rename (the class of defect behind the 8.0.0-beta.4 boot crash) fails `tsc` instead of silently crashing on device. Add a storage contract suite exercising the real `mmkvStorage` -> `mmkvStoragePlane` -> manifest boot path chain against the typed fake.
- Mutation-prove the internal "transport not configured" and "unknown model/scope handle" guards - both were correct but had zero test coverage of their throw branch, so a future refactor could silently turn either into a no-op.

### Environment

- Bump the devDependency versions of `react` to `19.2.3`, `react-native` to `0.86.0`, and `react-test-renderer` to match, aligning the dev/test environment with the consumer app.

### Internals

- BREAKING: remove the domain-specific `{ media }` write policy. Express guarded nested updates with `{ monotonic: { ladder | tuple | present | equal | all | any } }` and `{ keys: { ... } }`; group policies may be ordered arrays.
- Replace hand-written array-union and array-uniq reimplementations (`[...new Set(...)]` variants) with `es-toolkit`'s `union`/`uniq` in `gc.ts`, `operationState.ts`, `defineQuery.ts`, `useLiveRead.ts`, `modelStatusPoller.ts`, `recovery.ts`, and `transaction.ts`, and hand-written single-key object sort comparators with `es-toolkit`'s `sortBy` in `schemaManifest.ts`, `journal.ts`, and `defineModel.ts`. Behavior is unchanged; a few structurally-equivalent hot-path candidates (`commitBus.ts`, `tanstack/mirror.ts`, `scopeIndex.ts`, `entityState.ts`) were deliberately left on their manual implementation because the library call would have added array/Set conversions on the per-commit path.
- Split the six unrelated subsystems in `src/utils/runtimePrimitives.ts` (511 lines) into dedicated modules: `modelPatchers.ts` (keyed array, id array, nested object patchers), `singletonStatics.ts` (`createSingletonStatics`), `modelMaintenance.ts` (`trimRowsPerScope`, `resolveStaleTempRows`), `optimisticReconcile.ts` (`reconcileOptimisticRows` and its candidate-matching helpers), `singleFlight.ts` (`createSingleFlight`, `createThrottledSingleFlight`), and `runtimeGeneration.ts` (`createGenerationFence`). Public export names, generics, and return shapes are unchanged. Pure code movement, no behavior change.

- BREAKING: replace function-based `write.accept` and `write.groups[].policy.merge` declarations with closed model-owned policies: `server`, `continuity`, monotonic predicates, nested-key rules, and shallow snapshot fold.
- BREAKING: remove `mergeOptimisticMedia`; declare object-field preservation through the model's `write` groups.

## 8.0.0-beta.4 - 2026-07-27

- Fix a startup crash on react-native-mmkv v4: the storage adapter called a non-existent `allKeys()` (v4 API is `getAllKeys()`), killing the JS runtime before app registration on the first manifest boot (endless splash in release builds). Adapter types now derive from the real `react-native-mmkv` package instead of a hand-written mirror, so any future API drift fails typecheck.

## 8.0.0-beta.3 - 2026-07-27

- Query handles accept `null` as a disabled scope across `use`, `useRowEnsured` and imperative `fetch`: a `null` scope is an idle read - no `vars`/`enabled` callbacks, no scope registration or subscription, no transport call; `fetch(null)` resolves as a no-op. Restores the documented "pass `null` for an absent scope" consumer contract lost in the v8 rewrite.

## 8.0.0-beta.2 - 2026-07-27

- Restore the view DSL (`Model.view` plus the `ViewConfig` / `ViewIncludeModel` / `ViewIncludeSpec` types) removed in 8.0.0-beta.1 by a faulty dead-code audit - the consumer app relies on it for chat list and thread projections. Restored with its full pre-removal test coverage adapted to the v8 API (scope-window view contracts; include propagation and item identity are mutation-proven).

## 8.0.0-beta.1 - 2026-07-26

Stabilization release: the entire dark-path registry (28 findings) is closed, write semantics are unified into a single model-owned declaration, and the persistence core is redesigned around explicit invariants. Every fix in this release is covered by a test that was seen red on the broken behavior (red-first or mutation-proven).

### Breaking changes and migration

- BREAKING: rename the ActiveRecord model API - `get`->`find`, `getAll`->`all`, `getWhere`->`where`, `patch`->`update`, `patchWhere`->`updateAll`, `destroyWhere`->`destroyAll`, `insertStored`->`insert`, `insertStoredMany`->`insertMany`, `buildStored`->`build`, `replaceRaw`->`replace`, `use.row`->`use.find`, `patchWhenRowExists`->`updateWhenRowExists`, `patchClamped`->`updateClamped`, `sinkIf`->`intoIf`. Mechanical rename at each call site.
- BREAKING: remove `mergePolicy`, `merge.shouldOverwrite`, `preserveOnCommit`, `commitMergers`, and `mergeOptimisticSnapshot`. Migrate to the single model-owned `write` declaration: `write: { accept?, groups: [{ fields, policy: 'server' | 'continuity' | { monotonic } | { merge } }] }`, applied identically on every write path (mutation commit, ingest, query page, poller patch).
- BREAKING: split `defineIngest`'s `invalidate?: boolean | object` into `invalidate?: object` and `invalidateAll?: true` - boolean values are no longer accepted. Replace a boolean `true` with `invalidateAll: true`.
- BREAKING: reject empty scope values - a named scope no longer accepts `{}` or an object with `undefined` fields (previously collapsed silently into the `__root__` bucket). Express the absence of a scope only with `null`.
- BREAKING: remove the dead DSL surface `model.crud(...)`, `model.view(...)` / `defineView`, and unused core APIs.
- BREAKING: make persistence self-describing - the library stores a manifest `{ formatVersion, schemaFingerprint, dataVersion }` and performs a managed cold-cache reset of its own prefix on any mismatch. Remove `bootOptions.wipe`; pass `configureDb({ dataVersion })` (e.g. the app build number) instead of maintaining an external cache-version sentinel.
- BREAKING: bump `DB_FORMAT_VERSION` to 2 (raw-journal storage format) - existing persisted data cold-resets once on upgrade.

### Write-semantics core

- Validate the whole replace plan before the first mutation (atomic replace) - an invalid replacement node no longer destroys the existing row; commit-replace passes the same write gates as every other path (no more merge bypass on mutation commit).
- Derive relations, touch, counter caches, and membership only from the accepted effective row, never from raw rejected input; the journal stores raw ops and re-derives effects on replay.
- Enforce optimistic `ownedFields` in the core on every write path - a background patch cannot overwrite fields owned by a pending operation, and rollback restores the correct base.
- Commit ledger transitions in the same transaction as the data they describe; terminal ledger states are immutable (repeat close is an idempotent no-op).
- Apply a mutation response through the same pipeline as any server write ("commit == echo" contract), closing the class of optimistic-media losses.

### Persistence core

- Clear dirty state only after a confirmed successful write (checkpoint acknowledge protocol); prune the WAL only for provably persisted copies.
- Add an invariant-derived recovery protocol for corrupted persistence (targeted repair instead of catch-and-wipe); clean an orphaned scope key point-wise instead of cold-resetting the whole model.

### Lifecycle and account switch

- Make `resetRuntime` exception-safe (aggregate protocol) and complete - query scope registries, staleness guards, row waiters, pollers, and the maintenance scheduler all reset and restart correctly across `configureDb` cycles.
- Rebuild the runtime on a re-`configureDb` with a stale subscription generation instead of silently no-oping; re-create planes on every configure.
- Stop row waiters (`waitForRow`, `updateWhenRowExists`) immediately on generation mismatch instead of surviving until TTL; cancel resume drain on provider unmount.
- Include pending patches by real id, not only temp ids, in GC liveness roots - a row can no longer disappear under a pending mutation.

### Subscriptions and ingest

- Fix the subscription retry race (assign the unsubscribe handle before subscribe - a synchronous failure no longer blocks reconnect); make activation atomic.
- Namespace effect channels - creating a second subscription-effects channel no longer clears the handlers of the first.
- Count an event as delivered only after its handler applies successfully.
- Report partial ingest-apply failure honestly - malformed WAL entries and per-op errors are reported, not swallowed.

### Queries

- Derive `use.byIds`'s `byId` map solely from returned row identity; missing ids can never shift rows under wrong keys.
- Share staleness guards for complete-coverage scope writes per destination bucket across all query definitions - a stale response from one query can no longer overwrite a fresher response of another query targeting the same scope.
- Deduplicate poller work through the shared single-flight primitive; dedupe duplicate ids in a batch with a stable tie-break order.

### Test infrastructure

- Add GitHub Actions CI (typecheck, JSDoc gate, tests) plus a local pre-commit hook; run jest without `--forceExit`; fix the coverage threshold.
- Add an app-shaped harness - fixture declarations of the real consumer models with mixing/loss/speed contract suites at app scale.
- Verify the mutation-proven core - apply, journal, checkpoint, entity state, and scope index suites - by breaking the protected behavior and observing red.
- Measure real library paths with ratio budgets (honest perf gates).

## 7.0.0-beta.13 - 2026-07-26

- Fix `use.byIds` keying rows under wrong ids when some requested ids are missing.

## 7.0.0-beta.11 - 2026-07-25

### Read completeness

- Add `require?: string[]` to scope reads (`ScopeHandle.use`/`useWindow`): a row transiently missing a required field (mid sideload/partial write) is held back from render and reappears through the same subscription the moment the field commits; window `totalCount`/`hasMore` count only complete rows. The filter is memoized per hook by snapshot identity.

### Write-path performance

- Replace the double full-row `stableSerialize` deep-equality guard in entity upsert with a changed-fields-only comparison (measured 7.8x -> 1.04x on heavy rows); new `entityUpsertGuardHits` diagnostics counter.
- Replace the full `join('\0')` scope order comparison with an allocation-free element-wise check.
- Index pending operations by row (`pendingForRow`/`failedForRow`): `use.pending`/`use.failed`/`use.unsyncedChanges` and internal owned-fields/latest-value scans drop from O(all pending operations) to O(operations for the row) (measured 229x -> 0.56x at 3000 foreign operations).
- Trim the per-scope row identity cache in live scope reads down to current members after each snapshot update.

### Test harness

- Add `p04-app-scale-lifecycle` - an app-in-miniature contract suite (23 concurrent readers over 4 models): resume drain chunk budget, once-per-resume, inactive skip, commit fanout budget, churn steady-state, churn-during-drain consistency.
- Add `p05-pending-index-scale` and `p06-large-scope-churn` ratio gates for the pending-operations index and large-scope write paths.
- Add `c-scope-require` contracts for the scope read completeness gate.

## 7.0.0-beta.10 - 2026-07-25

### Resume and freshness

- Add per-query `resumeStaleTime?: number | null` to `defineQuery`/`defineFetch` configs; `null` opts a query out of foreground resume invalidation entirely, a number overrides the global `DbDefaults.resumeStaleTime` for that query.
- Drain resume refetches in chunks (`DbDefaults.resumeRefetch.chunkSize`, default 4) instead of one synchronous burst; inactive queries invalidate with `refetchType: 'none'`, and a new background transition or resume cancels the previous drain generation.

### Read engine and scopes

- Remove the 64-row threshold that forced full O(collection) rescans in `use.where`/`byIds`/`count` reads; batched row changes now apply as deltas, with a fast path that skips resorting when no order-relevant field changed.
- Add `member?: (row) => boolean` predicate to `by`-derived scopes: rows join and leave the scope instance inside the same apply transaction when the predicate flips.
- Add `orderFields` to comparator-sorted scopes so unrelated field writes no longer trigger comparator resorts.
- Fix parent-row and relation-model dependency gaps in `use.related` (`hasMany`/`hasOne`) and view includes; a new matching row now wakes the including view.
- `defineIngest` invalidate accepts `boolean | scope object` for scoped invalidation.

### Primitives and helpers

- Add `useMergedScopeRows(baseRows, extraRows, { comparator? })` - canonical union of two scope reads with id dedup and identity-stable results.
- Add `createSingleFlight(fn, { resetOnRuntimeReset? })` - promise coalescing that PROPAGATES rejections (unlike `createThrottledSingleFlight`), with optional in-flight reset on runtime reset.
- Add `createSingletonStatics.useCurrentField(field)` - field-level subscription for singleton models.
- Add `compositeKey`, move `semanticValue` beside `stableSerialize` in `core/serialize` - one owner module for stable serialization and composite keys.

### Diagnostics

- Add `__DBLAYER_DIAGNOSTICS__.snapshot()/reset()` global with commit, commit-fanout, read-engine apply, mirror scope pass, resume drain, and FK-index counters.

### Internal

- Deduplicate scope-sort application (`sortRowsBySpec`), membership predicate checks (`matchesMemberPredicate`), and array equality (`arraysShallowEqual` reuse); normalize string literal quoting.
- Remove `bootDb`, `collectGarbage`, `flushPersistence` from the public barrel - `DbProvider` owns the full data lifecycle (they join the forbidden-exports gate).
- Fix derived scope key collapse for membership scopes (carried from the pre-release round).

## 7.0.0-beta.9 - 2026-07-21

### Breaking changes and migration

- BREAKING: deep subpath imports are removed - `react-native-dblayer/core/*`, `react-native-dblayer/utils/*`, and `react-native-dblayer/types` no longer resolve. Import everything from the package root barrel.
- BREAKING: `f.enum` now takes the allowed value list and validates at runtime: `f.enum(['a', 'b'] as const)` (or `f.enum(Object.values(SomeCodegenEnum))`). Values outside the list are skipped like any other rejected field read. The old type-only `f.enum<T>()` passthrough form is removed - migrate each call site by passing the enum's values.
- BREAKING: pruned barrel exports with zero consumers: `getDbTransport`, `setDbTransport`, `suspendDb`, and `mmkvStoragePlane` are no longer exported (`bootDb` is unchanged). Internal-only symbols and unused type exports are removed from the public type surface.
- BREAKING: the `use.related` select overload types the callback row as a generic record - relation rows belong to the TARGET model, so narrow to the target stored type at the call site. Projection options apply only to `hasMany`; `belongsTo`/`hasOne` return the single target row as-is.

### ActiveRecord ergonomics

- `DbWhere` leaves accept comparison operators: `{ score: { gte: 5 } }` with `gt`/`gte`/`lt`/`lte`/`in`/`notIn`/`contains` (`contains` is string-only). Plain values keep exact-match semantics and the exact-match fast path; operator operands go through the same id coercion as plain criteria.
- Read-builder terminals: `.last()`, `.pluck(field)`, and `.exists()` (count-only, no row materialization) on `use.where(...)` builders.
- Batch writes: `patchWhere(where, partial)` and `destroyWhere(where)` apply one journaled multi-op plan against a snapshot of matching rows and return the matched count.
- `defaultOrder` model config: `{ field, direction }` orders every order-less read (`getWhere`, `use.first`, builders without `.orderBy`). An explicit order fully replaces it.
- `queryScopes` model config: named reusable local predicates exposed as `model.use.<name>(extra?)` returning the standard read builder (the fragment's `where` composed with `extra` via `and`, optional `orderBy`/`limit` pre-applied, terminals included). A name colliding with a built-in `use` key throws at define time. Distinct from membership `scopes`.
- `use.unsyncedChanges(id)`: reactive partial of stored fields currently owned by still-pending optimistic patch operations on the row - `undefined` when none are pending. Identity stays stable while the unsynced values are shallow-equal.
- `f.date()`: ISO-8601 string field - accepts parseable strings as-is, converts `Date` and epoch-ms numbers via `toISOString`, skips invalid values.

### Consumer helpers

- `fromNodes(connection)`: unwrap a GraphQL connection into a dense node array (nullish connections, node lists, and entries tolerated).
- `sinkIf(into, row)`: build an extract sink list from one optional node - `[]` for nullish, one sink otherwise. Collapses the `x ? [{ into, rows: [x] }] : []` pattern.
- `bridgeWindowPagination(window, query)`: combine a scope window (local pagination) with its backing query (network pagination) into one list-ready surface with window-first `fetchNextPage` and OR-ed `hasNextPage`. New `WindowPaginationBridge` type; `ScopeWindowResult` is now exported.
- `ScopeHandle.useFirst(scopeValue, opts?)`: reactive first scope row or `undefined`; nullish scope values stay unsubscribed.

### Reads and correctness

- Row ordering is locale-independent everywhere: every sort tie-break now compares ids by codepoint (`localeCompare` is gone from all read paths), so equal-key row order is deterministic across devices and locales.
- `resetRuntime()` is a safe no-op before `configureDb` has ever run (previously threw), so defensive teardown paths can call it unconditionally.
- `use.related` now carries behavioral contracts for `belongsTo`/`hasMany`/`hasOne` reads (reactive parent tracking, comparator-best `hasOne`, nullish-id empties, unknown-relation throw).

### Removed (dead code)

- Dropped the unused incremental scope read engine path - the live scope-read implementation is the only one.
- Dropped the dead `uniqueIds` module and duplicate equality/guard/comparator copies in favor of the canonical shared helpers.

### Testing

- Every new surface landed red-first with consumer-shaped contracts, and the earlier-landed features were retroactively proven red against their parent commits. Named behavioral contracts now cover the previously untested exports (id/patch utils, shape readers, row waiters, optimistic merge, runtime patchers, gc/reset/subscription utils). New perf gates cover the operator scan and the unified sort comparator. Full suite: 73 suites, 364 tests, green.

## 7.0.0-beta.8 - 2026-07-21

### Breaking changes and migration

- BREAKING: the `use.where(...)` builder is now reactive-only. Its synchronous `.read()` terminal is removed; the builder exposes `.orderBy`/`.limit`/`.require`/`.select`/`.rows()` (reactive) only. For a synchronous filtered snapshot use `getWhere(where, opts?)`, the single canonical imperative sync read.

### Reads and correctness

- Numeric-id criteria now match. `getWhere({ id: 54 })`, `use.where({ id: 54 }).rows()`, and `use.first({ id: 54 })` resolve rows whose stored `id` is the normalized string `'54'`, closing the last read paths where a numeric `Int` id was compared raw against a string-keyed row. Extends the beta.7 id-key normalization to `DbWhere` criteria on the primary `id` key.
- Numeric scope values now read the correct bucket. `scopes.x.use({ chatId: 54 })` (and `useWindow`/`useCount`/`read`) resolve the same membership bucket the write side files a row under, because the scope key is now built by coercing scope-value fields through the same field readers the membership derivation uses (read-write scope-key symmetry). A scope read with a numeric value no longer returns empty against string-keyed membership.

### Internals and correctness

- `defineFetch` validates `document` XOR `fetcher` at define time (fail-fast), matching `defineModel`/`defineMutation`, instead of deferring the check to `bootDb`.
- The scope order-revision cache is cleared by `resetRuntime` (reset-contract completeness): it was the only module-level runtime cache outside the reset contract. No reachable behaviour change - the stale entry was overwritten by the next structural resync before it could skip a rebuild - but a cross-generation cache no longer survives a runtime reset.
- `ScopeCoverage` is defined once and re-exported, removing a duplicate literal type and a core-to-dsl type import.
- Internal helper dedup: `stableSerialize`'s plain-object guard, cascade-destroy id de-duplication, and `dedupeIds` reuse the canonical `isNonArrayRecord` / es-toolkit `uniq` instead of hand-rolled copies.

### Removed (dead code)

- Removed unreachable schema/inference surface with zero consumers: `createSchema` and `DbSchema` (the `schema.ts` module), `AnyDbSchema`, `InferStored`, `InferInput`, `InferSparseInput`, `FieldModeValue`, `InferFieldsInput`, and a duplicate `AnyDbShape`. Public inference types (`ModelStored`, `ModelInput`, `InferShapeStored`) are unchanged.
- Removed seven unused internal declarations (`setDbStorageAdapter`, `cancelPersistence`, `hasWriter`, `collectionFor`, `membershipCollectionFor`, `getScopeLiveReadRegistryStats`, `DbSubscriptionEffectsTable`).
- Removed the legacy persisted-blob (`rows:<model>`) migration path; per-row storage keys have been the only write format for several releases. A device still holding the old blob re-fetches those rows on next sync (local-first, no data loss).

### Known limitations

- Unchanged from 7.0.0-beta.7: concurrent optimistic patches on the SAME field that ALL fail can briefly settle to the last optimistic value before the next server sync corrects it; a concurrent optimistic `destroy` + `patch` on the same row has undefined field ordering on destroy rollback; `Symbol` values are not distinguishable as ids or scope-key values.

### Testing

- Red-first contracts added for the numeric-id criteria and numeric scope-value read paths (both previously returned empty), the define-time `defineFetch` validation, and the scope order-cache reset contract; the full suite stays green.

## 7.0.0-beta.7 - 2026-07-20

### Breaking changes and migration

- BREAKING: `LoadingPhase` no longer includes `'hydrating'`. The phase was never emitted (hydration is synchronous behind `DbProvider`'s boot gate), so no read ever produced it; remove any dead `case 'hydrating'` from an exhaustive switch over `loadingState.phase`.

### Reads and loading state

- Row ids are normalized to strings consistently across every read AND write path: `get`, `use.row`, `use.field`, `use.byIds`, `use.first`, scope reads, `DbWhere` criteria, AND `patch`, `destroy`, `destroyMany`, `replaceRaw`, optimistic operation ids (`use.pending`/`use.failed`), and ingest payloads (`apply: 'destroy'`/`'existing'` guard). A model whose GraphQL ids are numeric (`Int`) no longer silently reads empty, nor silently drops a `patch(54, ...)` / `destroy(54)` / a subscription `{ id: 54 }` delete, when a value of the other type is passed - the write side, the read side, and the operation ledger now always agree on the string key. This fixes reads and mutations that succeeded on the backend but appeared to do nothing on device.
- `showEmptyState` is now provably terminal: it is true only after a fetch has completed with zero rows, never while a fetch, an automatic retry, an offline pause, or an imminent refetch is in flight. A query whose previously-committed destination rows die locally (destroy / GC / trim) holds `initial_loading` and refetches instead of flashing an empty/not-found frame before the refetch lands.
- `query.useRowEnsured` refetches when its ensured row is absent despite a completed, still-fresh fetch (a detail row present-then-destroyed, or addressed under a warm cache), instead of resolving to a terminal not-found. A genuinely absent row settles into `showEmptyState` after one bounded refetch - it does not loop.
- `LoadingState` gains `isRetrying` (a failed request is being retried), `retryAttempt` (consecutive failure count), and `isOffline` (the request is paused because the device is offline). A screen can show a "retrying" or "offline" affordance while data or the skeleton is held, without an empty/error flash between attempts.
- `defineFetch`: a fetched `null` or empty result is now classified as empty (`showEmptyState`), not treated as present data - `hasData` respects the fetch's `isEmpty` predicate.

### Scopes

- `ScopeWindowResult` (`scope.useWindow`) gains `resolved: boolean` - true once the scope has been reconciled at least once (membership generation > 0), reactive even when the reconcile produces zero rows. An ingest-only (socket-fed) scope can now tell "waiting for the first sync" from "synced and genuinely empty". Decide empty-vs-loading from `resolved` (or a query's `loadingState`), never from raw `rows.length`. With `keepPrevious`, `resolved` reports the CURRENT key's reconciliation (false while the retained prior rows are shown), not the retained snapshot's. Mirrors the existing `ViewWindowResult.resolved`.
- Field-sorted scope reads place null/undefined sort values last with a stable `id` tiebreak, so a reactive field sort matches the server order contract (nulls last) and never reorders equal-key rows.
- A stale in-flight next-page fetch that completes after a newer reset/refetch of the same scope is dropped instead of appending its stale rows onto the replaced scope.

### Writes (optimistic causality)

- Optimistic method-`patch` rollback reverts a field only while that patch still owns it: it restores only the fields the patch changed, and only when the current stored value is still the one it wrote. A second concurrent optimistic patch survives an earlier patch's rollback - both when it wrote a different field and when it overwrote the same field.
- A stale non-optimistic write (a query snapshot or ingest event created before an optimistic patch) no longer overwrites a field held by a still-pending optimistic patch. The optimistic value holds until that operation commits or rolls back, so there is no visible flip-then-flip-back (e.g. pin -> unpin -> pin) while the mutation is in flight. A committing patch's OWN authoritative server value (via its `extract`) still wins once it commits - the overlay releases before the commit applies. Out-of-order successful commits remain the domain of `mergePolicy` (declare a monotonic guard group for fields that must not regress).

### Internals and correctness

- `stableSerialize` is now total and injective across `null`, `undefined`, numbers (including `NaN`), `bigint`, strings, booleans, `Date`, arrays, plain objects, and other objects, so identity and dedup gates keyed on it no longer collide two structurally different values.
- Foreground-resume invalidation covers `defineFetch` results (`dbl-fetch`), not only `Model.query` scopes.

### Known limitations

- Rolling back one of several concurrent optimistic patches on the same field of the same row now restores that field to the latest still-pending patch's value (or its pre-patch base). One residual edge remains: if MULTIPLE concurrent patches write the SAME field and ALL of them fail, the field can briefly settle to the last optimistic value rather than the committed base; the next server sync of that row corrects it. Avoid firing overlapping optimistic patches on the same field where a stale flash would be unacceptable.
- Combining an optimistic `destroy` and another optimistic write (a `patch`) on the SAME row concurrently has undefined field ordering when the `destroy` later rolls back: the destroy's row-restore may overwrite a value the concurrent write committed. Avoid overlapping an optimistic `destroy` with other optimistic writes on the same row; a fully causal per-operation overlay is planned for a later release.
- `stableSerialize` distinguishes every JSON-representable value this layer carries; JavaScript `Symbol` values are not distinguishable from one another and must not be used as ids or scope-key values (GraphQL scalars never produce them).

### Testing

- Add behavioural contracts covering every class above, recorded as frame-sequence timelines where a transient matters (so a mid-flight empty/error/flip frame fails the suite, not just the final state): id-key normalization across reads AND writes/ingest/pending, the loading-phase machine (empty-state terminality, retry/offline observability), transport realism (numeric-id round trips, reset and page ordering fences, nulls-last sort), total serialization, fetch empty results, write causality (rollback field-ownership, stale-write overlay, own-commit authority, out-of-order commit via `mergePolicy`), scope-window `resolved` reactivity and keep-previous correctness, ensured-row survival refetch, and network resilience (retry / offline / manual `refetch`).

## 7.0.0-beta.6 - 2026-07-20

### Breaking changes and migration

- BREAKING: optimistic insert mutations now KEEP their row on transport failure (marked failed, `onFailurePatch` applied) instead of destroying it. Declare `failure: 'rollback'` on any mutation that relied on the row vanishing.

### Freshness

- Queries become vacuously stale when their committed destination rows no longer exist locally: a detail query under `staleTime: Infinity` refetches on mount after its rows were destroyed, GC'd, or reset instead of serving a permanent miss.
- Add `DbDefaults.resumeStaleTime` (default 60000 ms): on foreground resume, every db query whose data is older than the window is invalidated - active hooks refetch immediately, inactive cache entries refetch on next mount. Set `null` to disable.

### Reads

- Add `query.useRowEnsured(scope, rowId, readOpts?)` on model-destination query handles - a reactive point read that fetches only while the row is absent and reports a unified `loadingState`; `showEmptyState` is the only terminal not-found signal. Ensured fetches resurrect locally destroyed rows (an authoritative read-back bypasses the delete tombstone).

### Writes

- Add `mergePolicy.groups` on `defineModel` - per-field cross-writer merge guards enforced at the entity apply choke point for EVERY writer (query extracts, ingest, sync, relation touch, mutations, patches). Rejected group fields keep their current values while the rest of the same write applies; fully rejected writes emit no commit wave.
- Optimistic failure surface: mutation handles gain `retry(tempId)` / `discard(tempId)`, models gain `use.failed(id)`; `onFailurePatch`/`onRetryPatch` declare the row's visible failure/retry state. Failed operations survive journal replay; `retry` after an app restart returns null (input is session-scoped).

## 7.0.0-beta.5 - 2026-07-20

### Scopes

- Add `scope.issueSequence(scopeValue, field)` - synchronously reserves the next optimistic numeric value at a comparator-sorted scope's new edge. The result is one more than the larger of the current scope snapshot's maximum numeric `field` value and the largest value already issued for the same model, scope key, and field in this runtime session, so an uncommitted send burst stays strictly monotonic even when denormalized previews lag. Issued state is cleared by `resetRuntime`; nullish scope values throw. Replaces hand-rolled optimistic ordering floors in consumers.

## 7.0.0-beta.4 - 2026-07-20

### Breaking changes and migration

- BREAKING: `DbProvider` and `configureDb` now own the TanStack Query client entirely. The package no longer re-exports any TanStack Query API - `QueryClient`, `QueryClientProvider`, `useQuery`, `useQueryClient`, `focusManager`, and `getDbQueryClient` are all removed, and `configureDb` no longer accepts a `queryClient` option (it constructs and owns its own client internally). Render `DbProvider` once at the app root instead of your own `QueryClientProvider`, and stop passing `queryClient` into `configureDb`. Configure retries through the new `DbDefaults.retry: { query?, mutation? }` (a `DbRetryPolicy`: `classify`/`budgets`/`backoff`) instead of a raw TanStack retry function.
- BREAKING: the projection contract is unified across every row-shaped read surface. `select` changes meaning on `use.row`/`use.first`: it is now a projector function `(row) => TProjection`, not an array of field names - the previous array-of-keys form is renamed `renderKeys`. Passing both `select` and `renderKeys` on the same call throws `` `${surface} cannot use select and renderKeys together` ``. The same mutually-exclusive `select`/`renderKeys` pair is extended to `use.byIds` and `use.related` (neither had a projection option before).
- BREAKING: `use.byIds(ids)` returns `{ rows, byId }` instead of a bare array - `rows` preserves input order, `byId` is a `ReadonlyMap<string, TStored | TProjection>` keyed lookup. Update destructuring at every call site: `const { rows, byId } = Model.use.byIds(ids)`. Nullish `ids` return `{ rows: [], byId: <empty map> }` without subscribing.
- BREAKING: `Model.mutation`'s conventional dedupe now guards in-flight duplicates only by default - a committed key is released immediately, so the same input can be resubmitted right after it commits. Pass `once: true` to retain the previous "committed key never re-sent" behavior; combining `once: true` with `dedupe: false` throws at define time (`'once cannot be combined with dedupe: false'`).
- BREAKING: internal handle plumbing is no longer visible on public objects. `ScopeHandle` and ingest declarations no longer carry `__`-prefixed members in their generated types - plan/apply internals moved to a private `WeakMap`-backed registry, resolving the beta.3 known limitation. The public type-boundary casts `castNode`/`castNodes` are removed along with the escape hatch they existed for.
- BREAKING: `purgeForeignStorageKeys` and `replayJournal` are no longer exported as standalone primitives - both are now internal `bootDb()` boot steps (see beta.3's `wipe` option for a pre-replay reset). Manual maintenance stays available through `flushPersistence` and `collectGarbage`.
- BREAKING: dead/superseded exports are removed from the public barrel: `emptyIds`, `dedupeIds`, `createModelStatusPoller`, `trimRowsPerScope`, `resolveStaleTempRows`. Replace `emptyIds` with a local stable empty-array constant, and `dedupeIds` with a local nullish-filter-plus-`uniq()` (or an equivalent inline reduction); status polling is `Model.poller` (see below); per-scope row trimming is the declarative `maintenance: { maxRowsPerScope }` model option (already available since beta.2).

### Provider and configuration

- Add `DbProvider` - the library-owned `QueryClientProvider` plus boot gate. Render it with optional `bootOptions` (forwarded to `bootDb`); it renders `children` only after boot completes. It also drives `AppState`-based lifecycle internally (query focus tracking, and `suspendDb()` on backgrounding) - none of this needs manual wiring on the consumer side.
- Add `DbRetryPolicy` (`classify`, `budgets`, `backoff`) on `configureDb({ defaults: { retry: { query?, mutation? } } })` - `classify` buckets a failure into `'network' | 'server' | 'retriable' | 'fatal'`, `budgets` caps retry attempts per non-fatal class, `backoff` tunes the exponential delay bounds (defaults 1000ms/30000ms). Omitting `classify` disables retries for that policy.

### Reading and projections

- Unify the `select`/`renderKeys` projection pair across `use.row`, `use.first`, `use.byIds`, and `use.related` (see Breaking changes above). Both options run through one shared per-hook projection gate that returns the previous output reference when the equality value (the selector's output for `select`, the listed keys' values for `renderKeys`) is unchanged.
- `use.byIds(ids, opts?)` applies the same per-item projection gate plus an outer array-level shallow-equal check, so an untouched row's projected entry keeps its reference inside the returned `rows` array too.
- Array-valued `select`/`renderKeys` fields now compare element-wise by reference instead of by whole-array identity, so a freshly-constructed array of the SAME element references (e.g. a `[...row.userIds]` spread) no longer defeats the stability gate.
- Add `keepPrevious` on `ScopeHandle.use`/`useWindow` and `Model.view`'s `use`/`useWindow` - opt in to retaining the prior non-empty key's snapshot until the new key resolves (its first non-empty result, or a confirmed-empty read). `useWindow` additionally reports `isPreviousData: boolean`, so a screen can distinguish retained content from current-key content without guessing from row count. Not recommended for account/detail identity switches where showing the previous entity would be unsafe.
- Add `Model.use.pending(id)` - true only while that exact row id belongs to an open optimistic operation (an insert's temp id, or a patch's existing id), false for every other row and for nullish ids, without subscribing on the nullish path. Boot replay reconciles hydrated pending operations before it completes, so a resurrected temp id reports false once boot settles.

### Seeding

- Add dev/test-only seed primitives: `Model.seed(rows)` and `Model.scopes.<scope>.seed(scopeValue, rows)`. Both normalize and upsert through the normal journalled apply pipeline, including automatic membership; the scope form also replaces that scope's complete explicit membership in the supplied order. Subscribers receive at most one commit wave.

### Views

- `Model.view` accepts explicit `ViewConfig<TRow, TIncluded, TItem>` generics - declare the include map as the second type argument (`ChatModel.view<ChatListItem, { lastMessage: StoredMessage | null; users: UserData[] }>('list', { ... })`) to type `included` without coupling related-row shapes to the underlying model readers. `ViewIncludeSpec`/`ViewIncludeModel` are exported for typing computed includes directly.
- A view may now combine `select` with `renderKeys` - unlike row-level reads, which still require exactly one. The selected object from `select` remains the returned item; its reference is preserved when every listed `renderKeys` field on that selected output stays shallow-equal.

### Status polling

- `Model.poller(name, config)`'s boolean `isTerminal` classifier is replaced by `classify: (data) => 'ready' | 'failed' | null` (`null` keeps polling), and the reader surface gains a full phase machine: `getPhase`/`usePhase` return `{ phase: 'idle' | 'polling' | 'ready' | 'failed' | 'stalled', reason?, attempts }` instead of the removed `isSessionTerminal(id): boolean`. Migrate a removed `isSessionTerminal(id)` check to `phase === 'ready' || phase === 'failed'`. `onSessionStop`'s reason strings are also renamed: `'terminal-payload'`/`'budget-exhausted'`/`'stopped'` replace `'terminal'`/`'budget'` (a detach on an active session now reports too). The standalone `createModelStatusPoller` this ran on top of is no longer exported - status polling is `Model.poller`-only.

### Ephemeral fetches

- `defineFetch` gains `emptyStaleTime`/`isEmpty`, mirroring `Model.query`'s empty-result freshness policy: a selected result classified as empty (nullish or empty array by default, or per a custom `isEmpty`) uses `emptyStaleTime` instead of `staleTime`, so a confirmed-empty ephemeral fetch (e.g. an empty search result) is not treated as fresh for as long as real data would be.
- `DbDefaults.emptyStaleTime` now applies to `defineFetch` results too, not only `Model.query`.

### Maintenance

- Fix scope retention: a `maxRows`-capped scope declared with a `sort` (field or `comparator`) now re-sorts by that order before trimming, so retention keeps the true top-N instead of an arbitrary subset when a bulk write pushes the scope over its cap.

### Example app

- The example app runs entirely on the big-bang surface: `DbProvider`, `Model.query`/`Model.mutation`/`Model.fetch`, projected reads, and the poller phase machine replace every pre-migration pattern.

### Documentation

- Restructure the reference into one topic-owning page per surface - `getting-started.md`, `models.md`, `reading.md`, `queries.md`, `mutations.md`, `ingest-live.md`, `runtime.md` - replacing `configuration.md` and `runtime-primitives.md`. `docs/README.md` indexes every public export to its home page, and the project `README.md` cross-links into it. A coverage gate fails when a barrel export is undocumented.
- Document the Hermes crypto polyfill prerequisite as verified on-device (previously stated but unconfirmed).

### Test coverage

- `src/__tests__/spec/` is now the only specification - the superseded `acceptance/` suite is removed. 38 suites, 178 tests at this tag, covering consumer behavior contracts, rerender/render-count matrices, integrity, sufficiency, performance scale gates, and public surface/type gates.

### Known limitations

- Array-aware projection equality (see Reading and projections) compares array elements by reference, one level deep. A `select`-derived array of FRESH per-run objects (not stable row references) still produces a new element reference on every recompute and defeats the `renderKeys`/`select` stability gate for that field; a row-level array of stable references, or an array of primitives, is unaffected. Deeper (per-element field) comparison is a planned follow-up.

## 7.0.0-beta.3 - 2026-07-19

### Boot lifecycle

- Add `wipe` to `bootDb` options: `bootDb({ ..., wipe: true })` runs the `resetRuntime` kill-switch after configuration and deferred validations but before journal replay, so boot starts from an empty store. Use it for consumer-side schema/cache-version bumps where stale persisted rows must not be rehydrated - previously a pre-boot wipe had no first-class path (`resetRuntime` throws before `configureDb`).

## 7.0.0-beta.2 - 2026-07-19

### Breaking changes and migration

- BREAKING: standalone `defineQuery`, `defineMutation`, and `defineIngest` are removed from the public API. Migrate to the model-owned constructors: `Model.query(name, config)`, `Model.mutation(name, config)`, `Model.ingest(entries)`. `defineFetch` (model-less ephemeral reads) and `defineCommand` (model-less RPC mutations) remain public.
- BREAKING: `Model.mutation` deduplicates by default with a conventional input-sensitive key (`<modelId>:<name>:<input>`); pass `dedupe: false` to opt out. The removed standalone constructor defaulted to no deduplication.
- BREAKING: ordered reads unify null ordering. `getWhere`, `use.first`, the chainable builder, and field-sorted scopes now treat `null` and `undefined` as equivalent missing values sorted LAST, with antisymmetric comparators and an implicit `id` tie-break. Field-sorted paths previously ordered nulls first; re-check consumer scopes sorting on nullable fields.
- BREAKING: final naming sweep of the public barrel - `Coverage` is now `ScopeCoverage`, `ScopeHandleExpr` is now `ScopePlacement`, `EMPTY_IDS` is now `emptyIds`, `createUniqueIds` is now `dedupeIds`, `toStr` is now `stringifyNullish`, and `singletonStatics` is now `createSingletonStatics`. Mechanical rename on the consumer side; no behavior changes.
- BREAKING: `bootDb` now runs deferred definition validations before replay and rejects on invalid configurations - in particular a conventional `crud`/`mutation` optimistic destroy on a model whose relations declare `dependent: 'destroy'` cascades. These configurations previously surfaced only when the mutation ran; the run-time guard also remains. `resetRuntime` clears the validation registry.

### Model-centric DSL

- Add `Model.query`, `Model.mutation`, and `Model.fetch` with conventional `<modelId>:<name>` keys and model-owned destinations, plus `defineCommand` for model-less RPC.
- Add `Model.view(name, { include, select, renderKeys })` - joined reactive projections with memoized foreign-key indexes; `useWindow` evaluates includes only for visible rows while keeping `totalCount`/`hasMore` reactive.
- Add `Model.ingest(entries)` returning `{ entries, apply(key, payload) }` - fused subscription entries (guards, echo suppression, injected effects, custom apply) plus a declaration-return `{ handler }` form that applies atomically as one plan; the imperative `apply` delivers through the same pipeline as a live subscription.
- Add chainable reads `Model.use.where(criteria).orderBy(field, dir).limit(n)` with reactive `.rows()` and snapshot `.read()` terminals - stable subscriptions across re-construction, natural storage order without `orderBy`.
- Add model `maintenance: { maxRowsPerScope }` declarations executed by `bootDb` (its report is returned as `maintenance`; protection thunks may read other models), and `Model.poller(name, config)` - a refcounted status poller with `<modelId>:<name>` failure diagnostics. Boot-time temp-row cleanup needs no maintenance entry: the replay orphan sweep already destroys unconfirmed temp rows on every boot.

### Optimistic writes

- Add `prependTo`/`appendTo` on Insert and Respond optimistic configs - declarative placement of the temp row at the top or bottom of a server-order scope via `ScopeHandleExpr` (`{ scope, value(input) }`). The assigned position survives the temp-to-server swap; rollback restores the previous scope order. Define-time validation rejects non-server-order scopes, foreign-model scopes, method optimistic configs, and setting both at once.
- Add the Respond optimistic variant: `optimistic: { model, selectServerNode, respond(input, { tempId, operationId }) }` fabricates a transport-shaped response that runs through the exact same plan builder as the real one - `result` extraction, node selection, `extract` sinks, and placement composition are identical on the fabricated and committed passes. Rollback captures per-target inverses (absent rows invert to destroy, existing rows restore with their scope memberships).

### CRUD scaffold

- Add `Model.crud({ list, get, create, update, destroy })` - a Rails-resources-style composer over `Model.query`/`Model.mutation` with conventional keys and optimistic defaults: `list` requires an explicit `into` scope (define-time throw), `get` targets the model, `create` takes `respond` or `build`+`selectServerNode` with `prependTo`/`appendTo` pass-through, `update` defaults to a patch by `input.id` with the id excluded from the patch, `destroy` defaults to a destroy by `input.id`. Explicit `optimistic` overrides a convention entirely; `optimistic: false` disables the local write. Conventional `update`/`destroy` inputs require `id: string` at the type level; returned handles are fully typed per present section.

### Live subscription colocation

- Add `live: { <event>: <ingest entry> }` on `Model.query` - subscription entries colocated with the query they keep fresh, compiled through the `Model.ingest` pipeline. Subscriptions are refcounted on the query's `use` readers: first mount subscribes, last unmount unsubscribes, overlapping readers share one transport subscription, `fetch` alone never subscribes. `resetRuntime` drops the runtime and reactivates it for still-mounted readers; late payloads after teardown write nothing. The returned handle adds `live.apply(event, payload)` (typed `LiveQueryHandle`, present only when the config declares `live`).

### Required fields

- Add the `require` gate on every read surface: `use.row(id, { require })`, `use.first(where, { require })`, the chainable builder's `.require(...)` step, and per-include `require` inside `Model.view` configs. A row is delivered only when every required field is present; `undefined` counts as missing while an explicit `null` counts as present. Filtering is row-level only - scope `totalCount` and windowing stay driven by the unfiltered source. TypeScript narrows delivered rows so required fields drop their `undefined` arm.

### Retention and garbage collection

- `collectGarbage` roots now include mounted readers: any row, scope, or model a mounted hook depends on survives collection, and unmounting releases it for the next pass. Manual GC during active screens no longer needs protective scope design.
- Add opt-in in-session GC scheduling via `configureDb({ defaults: { inSessionGc: { threshold, debounceMs } } })` (defaults 500 disappearances / 1000ms debounce, `false` to keep GC purely app-driven). Pressure counts row disappearances and scope detaches - bulk inserts and hydration build none - and a maintenance pass never re-triggers itself.
- Add opt-in idle scope collection via model `maintenance: { dropIdleScopesAfterMs }`: scopes not accessed for the window are dropped together with rows that become unreferenced. Access marks are mount-time (hooks and views) or explicit (`scope.read()`); re-renders never refresh them. Hydration seeds a grace window, and a mounted reader always protects its scope regardless of age.
- Tombstones now decay on three tiers: a 24h TTL, a 10,000-per-model cap that never evicts tombstones younger than 10 minutes, and an overflow valve that trims straight to the cap when a burst passes 20,000. Every flush prunes every known model, so quiescent models decay too.

### Tooling

- Add `yarn check:jsdoc` - an AST-driven gate (TypeScript compiler API) that fails when any value export of the public barrel lacks IntelliSense-grade JSDoc on its declaration.
- Perf gates now measure process CPU time with warmup and median-of-25 sampling, making scale ratios immune to wall-clock noise from parallel test workers.

### Reliability and performance

- Lock every public read surface with guarantee-matrix contracts (reference identity, counted renders, reset/lifecycle, teardown). Fixed by those contracts: windowed views no longer re-render on off-window writes; a stopped subscription runtime ignores late transport payloads; `defineFetch` hook results keep stable identity for unchanged data.
- Round-two surfaces carry the full matrix plus negative paths: duplicate live events are idempotent with preserved array/row identity, unrelated readers render zero times on placement/respond/crud/live writes, colocated debounce and retry timers clear after the last unmount, and 20k/1k scale ratio gates bound placement, respond, crud, and live delivery.
- Fix an O(scope) hot path in optimistic placement discovered by those gates: membership mirroring now carries sparse scope orders end to end (scope-index boundary fast-path, append orders plumbed through the commit bus, placement-covered auto memberships deduplicated at plan assembly). A prepend into a 20k-row scope dropped from ~950ms to under 0.4ms; all scale gates hold ratios under 12.
- On-device (Hermes, iOS simulator): cold boot with 20k persisted rows in ~6.5-7.0s (target <10s), patch median 20k/1k ratio ~3.2, optimistic prepend and respond flows verified end to end on the example app.
- Unify comparison, equality, and generation-fence helpers on shared implementations with `es-toolkit`-first utilities; sorting runs only when an ordering is declared.

### Known limitations

- Internal `__`-prefixed handle members (plan/apply plumbing on `ScopeHandle` and ingest declarations) remain visible in generated declarations; opaque wrappers are deferred with rationale - they are optional, undocumented, and carry no support surface.
- A define-time cascade guard is structurally impossible (relations are lazy thunks); the guard runs at `bootDb` instead, with the run-time check as backstop.
- `docs/` reference is fully reconciled with the shipped surface in this release; the historical v6 planning artifacts (`docs/v6-api-mapping.md`, `docs/v6-contract-spec.md`) are removed.

## 7.0.0-beta.1 - 2026-07-18

### Breaking changes and migration

- BREAKING: the reactive core now runs on TanStack DB. On Hermes, consumers must provide Web Crypto: install `react-native-get-random-values`, import it first in the app entry, and polyfill `crypto.randomUUID` (yupi_v2 already ships both - no action needed there).
- BREAKING: all models must be imported (registered) before `bootDb()` / `replayJournal()` runs; Metro inline-requires can defer screen modules, so import model modules explicitly in the app entry. Journal replay and maintenance soft-fail on unregistered models instead of crashing, but registration-before-boot is the supported pattern.

### Core

- Serve `Model.scopes.X.use` and `useWindow` from shared TanStack live queries - one incrementally-maintained pipeline per scope with native `orderBy`; concurrent readers of the same scope share it.
- Mirror entity rows and scope membership into TanStack collections through a commit-bus firehose - a single path covering apply, journal replay, and GC maintenance - with sort-value-based membership ordering for field-sorted scopes.
- Keep the arbitration planes (tombstones, coverage, merge gates, operation ledger) and WAL/checkpoint persistence unchanged - no storage migration; existing persisted data is picked up as-is.
- Fix a subscription race after `resetRuntime` on the new read path and guard collection seeding against unregistered models.

### Performance

- Scope-read patch and resort scale better than the previous engine: acceptance gate ratios improved and absolute large-scope timings dropped several-fold; every existing perf budget is unchanged and green.

### Example

- The example app runs on the new core and demonstrates the consumer patterns above (crypto polyfill, models imported before boot).

### Known limitations

- Hybrid phase: `use.where`, `use.first`, and point reads still run on the previous engine paths; the model-centric Rails-like DSL lands in the next betas.

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

| Old                                 | New                                    |
| ----------------------------------- | -------------------------------------- |
| `executeDbSingleRequest`            | `runDbQueryDirect`                     |
| `executeDbInfiniteRequest`          | `runDbInfiniteQueryDirect`             |
| `InfiniteQueryResult.items`         | `InfiniteQueryResult.data`             |
| `InfiniteQueryResult.refresh`       | `InfiniteQueryResult.refetch`          |
| `InfiniteQueryResult.fetchNextPage` | `InfiniteQueryResult.loadMore`         |
| `getFirstWhere`                     | `getFirst`                             |
| singleton `upsert`                  | `upsertCurrent`                        |
| `_collection`                       | `collection`                           |
| config `inactive`                   | config `enabled` with inverted meaning |
| `FetchStatePageInfo`                | removed                                |
| `NormalizedPageInfo`                | removed                                |
| `DisplayState`                      | removed                                |
| `DisplayStateInput`                 | removed                                |
| `ServerSyncContract`                | removed                                |
| `ServerSyncMode`                    | removed                                |

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

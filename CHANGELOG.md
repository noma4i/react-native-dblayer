# Changelog

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

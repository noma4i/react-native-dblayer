# Changelog

## Pending

- Add lazy `hasMany` model relations with explicit cascade destroy support.
- Change custom extract function sinks to receive lifted payload arrays, and export `liftExtractNodes`.
- Add `useStableEntity`, stable-items defaults, `readShapeOrThrow`, `pruneExpiredRows`, and `createOptimisticSequence`.
- Add direct query and command executors, plus direct patch optimistic mutation support.

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

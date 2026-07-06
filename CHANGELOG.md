# Changelog

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

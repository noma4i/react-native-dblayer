# Changelog

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

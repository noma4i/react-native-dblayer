# API reference

Full reference for `@noma4i/react-native-dblayer`. For a guided tour with narrative examples, see
the [project README](../README.md).

## Reading order

| #   | Page                                       | Covers                                                                                                                                                                                                                  |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [getting-started.md](./getting-started.md) | Boot sequence: register models, `configureDb`, `DbProvider`, the internal boot sequence and automatic background suspension, storage/transport seams, runtime prerequisites. Start here.                                                           |
| 2   | [models.md](./models.md)                   | `defineModel(key, config)`, schema, associations, named relations, actions, events, sideloads, writes, maintenance, and statics. |
| 3   | [reading.md](./reading.md)                 | `find`, `useFind`, `where`, `byIds`, named `Relation` reads, counts, invalidation, pagination, and operation state. |
| 4   | [queries.md](./queries.md)                 | `gql.single`, `gql.connection`, relation loading state, and service-only `defineFetch`. |
| 5   | [mutations.md](./mutations.md)             | `gql.action`, request/durable/poll modes, and service-only `defineCommand`. |
| 6   | [ingest-live.md](./ingest-live.md)         | `gql.live`, `Model.events`, and the shared subscription runtime. |
| 7   | [runtime.md](./runtime.md)                 | Reset, persistence, row waiters, patchers, ids, and concurrency helpers. |

Every export below has exactly one home page - the doc where its full contract is documented. Where
a symbol is used from another doc's example (e.g. `belongsTo` inside a `Model.query` extract sink),
that doc links back to the symbol's home instead of re-documenting it.

## The model-centric surface

Every model-bound capability is declared once in `defineModel(key, config)`. Named relations become
flat model methods, actions live under `Model.actions`, and subscriptions live under `Model.events`.
There are no public model-bound query, mutation, view, ingest, poller, detached-operation, scope, or
`use.*` constructors.

| Surface | Role | Home |
| --- | --- | --- |
| Named relation method | Local or GraphQL-backed immutable relation. | [queries.md](./queries.md) |
| `Model.actions.name` | Request, durable, or poll action. | [mutations.md](./mutations.md) |
| `Model.events` | Typed subscription entries and manual delivery. | [ingest-live.md](./ingest-live.md) |
| `Model.operation(id)` | Snapshot or reactive row operation state. | [reading.md](./reading.md) |

`defineFetch` (model-less reads) and `defineCommand` (model-less RPC) remain standalone
constructors for capabilities that do not belong to any single model.

## Export reference

Generated from `src/index.ts`, grouped by area. Runtime (value) exports are gated by
`src/__tests__/spec/surface/docs-coverage.test.ts` - every name below must appear at least once
somewhere under `docs/`.

### Getting started

| Export              | Kind  | Home                                                                |
| ------------------- | ----- | ------------------------------------------------------------------- |
| `configureDb`       | value | [getting-started.md](./getting-started.md#configuredboptions)       |
| `DbDefaults`        | type  | [getting-started.md](./getting-started.md#dbdefaults)               |
| `DbRetryClass`      | type  | [getting-started.md](./getting-started.md#dbdefaults)               |
| `DbRetryPolicy`     | type  | [getting-started.md](./getting-started.md#dbdefaults)               |
| `DbProvider`        | value | [getting-started.md](./getting-started.md#dbprovider)               |
| `DbProviderProps`   | type  | [getting-started.md](./getting-started.md#dbprovider)               |
| `StoragePlane`      | type  | [getting-started.md](./getting-started.md#storage-seam)             |
| `DbTransport`       | type  | [getting-started.md](./getting-started.md#transport-seam)           |
| `DbTransportError`  | type  | [getting-started.md](./getting-started.md#transport-seam)           |

### Model DSL

| Export        | Kind  | Home                                       |
| ------------- | ----- | ------------------------------------------ |
| `defineModel` | value | [models.md](./models.md#definemodelconfig) |
| `gql`         | value | [models.md](./models.md#graphql-declarations) |
| `ModelInput`  | type  | [models.md](./models.md#fields-f)          |
| `ModelStored` | type  | [models.md](./models.md#fields-f)          |
| `ModelAction` | type | [mutations.md](./mutations.md) |
| `ModelActionHook` | type | [mutations.md](./mutations.md) |
| `ModelEventHandle` | type | [ingest-live.md](./ingest-live.md) |
| `Relation` | type | [reading.md](./reading.md) |
| `RelationOptions` | type | [reading.md](./reading.md) |
| `RelationResult` | type | [reading.md](./reading.md) |
| `RowOperation` | type | [reading.md](./reading.md) |
| `RowOperationState` | type | [reading.md](./reading.md) |

### Schema DSL

| Export             | Kind  | Home                              |
| ------------------ | ----- | --------------------------------- |
| `f`                | value | [models.md](./models.md#fields-f) |
| `defineShape`      | value | [models.md](./models.md#fields-f) |
| `projectShape`     | value | [models.md](./models.md#fields-f) |
| `readShape`        | value | [models.md](./models.md#fields-f) |
| `readShapeOrThrow` | value | [models.md](./models.md#fields-f) |
| `InferShapeStored` | type  | [models.md](./models.md#fields-f) |

### Relations

| Export       | Kind  | Home                               |
| ------------ | ----- | ---------------------------------- |
| `belongsTo`  | value | [models.md](./models.md#relations) |
| `hasMany`    | value | [models.md](./models.md#relations) |
| `hasOne`     | value | [models.md](./models.md#relations) |
| `references` | value | [models.md](./models.md#relations) |

### Reading

| Export         | Kind | Home                                                  |
| -------------- | ---- | ----------------------------------------------------- |
| `DbWhere`      | type | [reading.md](./reading.md#snapshot-vs-reactive-reads) |
| `DbWhereOp`    | type | [reading.md](./reading.md#snapshot-vs-reactive-reads) |
| `LoadingState` | type | [queries.md](./queries.md#loading-state)              |
| `useMergedScopeRows` | value | [reading.md](./reading.md#usemergedscoperowsbaserows-extrarows-options) |

`use.*`, `Model.view`, and `ScopeHandle.use`/`useWindow` are methods, not separate barrel exports -
see [reading.md](./reading.md).

### Queries

| Export            | Kind  | Home                                                    |
| ----------------- | ----- | ------------------------------------------------------- |
| `defineFetch`     | value | [queries.md](./queries.md#definefetchconfig)            |
| `FetchConfig`     | type  | [queries.md](./queries.md#definefetchconfig)            |
| `FetchHandle`     | type  | [queries.md](./queries.md#definefetchconfig)            |
| `FetchResult`     | type  | [queries.md](./queries.md#fetchresult)                  |
| `QueryResult`     | type  | [queries.md](./queries.md#queryresult)                  |
| `ExtractSink`     | type  | [queries.md](./queries.md#modelqueryname-config)        |
| `fromNodes`       | value | [queries.md](./queries.md#connection-and-extract-helpers) |
| `intoIf`          | value | [queries.md](./queries.md#connection-and-extract-helpers) |
| `useLoadMore` | value | [queries.md](./queries.md#queryresult) |
| `LoadMoreTarget` | type | [queries.md](./queries.md#queryresult) |
| `LoadMoreOptions` | type | [queries.md](./queries.md#queryresult) |

`Model.query`/`Model.fetch` themselves are methods, not separate barrel exports - see
[queries.md](./queries.md).

### Mutations

| Export                    | Kind  | Home                                                     |
| ------------------------- | ----- | -------------------------------------------------------- |
| `defineCommand`           | value | [mutations.md](./mutations.md#definecommandname-config)  |
| `MutateCallbacks`         | type  | [mutations.md](./mutations.md#use-result-shape)          |
| `ScopePlacement`          | type  | [mutations.md](./mutations.md#optimistic-write-variants) |

`Model.mutation`/`Model.detached` themselves are methods, not separate barrel exports - see
[mutations.md](./mutations.md).

### Ingest and subscriptions

| Export                        | Kind  | Home                                                                      |
| ----------------------------- | ----- | ------------------------------------------------------------------------- |
| `createDbSubscriptionRuntime` | value | [ingest-live.md](./ingest-live.md#createdbsubscriptionruntimeentries)     |
| `createDbSubscriptionEffects` | value | [ingest-live.md](./ingest-live.md#createdbsubscriptioneffectsnoopeffects) |
| `defineDbSubscriptionEntry`   | value | [ingest-live.md](./ingest-live.md#definedbsubscriptionentryentry)         |
| `IngestDecl`                  | type  | [ingest-live.md](./ingest-live.md#modelingestentries)                     |

`Model.ingest` itself is a method, not a separate barrel export - see
[ingest-live.md](./ingest-live.md#modelingestentries).

### Runtime

| Export                        | Kind  | Home                                                                            |
| ----------------------------- | ----- | ------------------------------------------------------------------------------- |
| `resetRuntime`                | value | [runtime.md](./runtime.md#resetruntime-kill-switch)                             |
| `registerReset`               | value | [runtime.md](./runtime.md#resetruntime-kill-switch)                             |
| `setFetchNetworkOnline`       | value | [runtime.md](./runtime.md#setfetchnetworkonlineonline)                          |
| `updateWhenRowExists`          | value | [runtime.md](./runtime.md#row-waiters)                                          |
| `waitForRow`                  | value | [runtime.md](./runtime.md#row-waiters)                                          |
| `createThrottledSingleFlight` | value | [runtime.md](./runtime.md#createthrottledsingleflightfn-options) |
| `createSingleFlight`          | value | [runtime.md](./runtime.md#createsingleflightfn-options)          |
| `createKeyedArrayPatcher`     | value | [runtime.md](./runtime.md#array-and-nested-object-patchers)                     |
| `createIdArrayPatcher`        | value | [runtime.md](./runtime.md#array-and-nested-object-patchers)                     |
| `createNestedObjectPatcher`   | value | [runtime.md](./runtime.md#array-and-nested-object-patchers)                     |
| `createSingletonStatics`      | value | [runtime.md](./runtime.md#createsingletonstaticsmodel-recordid-defaults)        |
| `NumericField`                | type  | [runtime.md](./runtime.md#createsingletonstaticsmodel-recordid-defaults)        |
| `PatchModel`                  | type  | [runtime.md](./runtime.md#createsingletonstaticsmodel-recordid-defaults)        |
| `RowId`                       | type  | [runtime.md](./runtime.md#createsingletonstaticsmodel-recordid-defaults)        |
| `SingletonModel`              | type  | [runtime.md](./runtime.md#createsingletonstaticsmodel-recordid-defaults)        |
| `SingletonStatics`            | type  | [runtime.md](./runtime.md#createsingletonstaticsmodel-recordid-defaults)        |
| `generateTempId`              | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `isTempId`                    | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `stringifyNullish`            | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `readId`                      | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `pickDefined`                 | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `pickPresent`                 | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |

`Model.poller` itself is a method, not a separate barrel export - see
[runtime.md](./runtime.md#modelpollername-config).

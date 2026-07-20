# API reference

Full reference for `@noma4i/react-native-dblayer`. For a guided tour with narrative examples, see
the [project README](../README.md).

## Reading order

| #   | Page                                       | Covers                                                                                                                                                                                                                  |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [getting-started.md](./getting-started.md) | Boot sequence: register models, `configureDb`, `DbProvider`, `bootDb`/`suspendDb` (incl. `wipe`), storage/transport seams, runtime prerequisites. Start here.                                                           |
| 2   | [models.md](./models.md)                   | `defineModel` itself: the `f`/`defineShape` field DSL, writes, scopes (`sort`/`server-order`/`coverage`/`retention`), relations (`touch`/`counterCache`/`dependent`).                                                   |
| 3   | [reading.md](./reading.md)                 | Every read surface: `use.row`/`field`/`first`/`where`/`byIds`/`count`/`related`, `select`/`renderKeys` projections and their identity guarantees, scope `use`/`useWindow`, `keepPrevious`, `use.pending`, `Model.view`. |
| 4   | [queries.md](./queries.md)                 | `Model.query` (network reads into a model/scope, pagination, coverage semantics, loading state), `defineFetch` (`document`\|`fetcher`, `remove()`), `Model.fetch`.                                                      |
| 5   | [mutations.md](./mutations.md)             | `Model.mutation` (optimistic lifecycle, temp-id replace, rollback, dedupe), `defineCommand`, `Model.crud`, `mergeOptimisticSnapshot`, mutation error policy.                                                            |
| 6   | [ingest-live.md](./ingest-live.md)         | `Model.ingest`, the subscription runtime (`createDbSubscriptionRuntime`/`defineDbSubscriptionEntry`/`createDbSubscriptionEffects`), `Model.query`'s live colocation, echo semantics.                                    |
| 7   | [runtime.md](./runtime.md)                 | Maintenance, garbage collection, `resetRuntime`/`registerReset`, the persistence/journal model, `Model.poller`, row waiters, and the small cleanup/patcher/scalar helpers.                                              |

Every export below has exactly one home page - the doc where its full contract is documented. Where
a symbol is used from another doc's example (e.g. `belongsTo` inside a `Model.query` extract sink),
that doc links back to the symbol's home instead of re-documenting it.

## The model-centric surface

Every network-facing capability is a method on the model it belongs to. There are no standalone
`defineQuery`/`defineMutation`/`defineView`/`defineIngest` constructors.

| Method                         | Role                                                                                      | Home                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Model.query(name, config)`    | Network reads into a model/scope.                                                         | [queries.md](./queries.md#modelqueryname-config)        |
| `Model.mutation(name, config)` | Optimistic network writes.                                                                | [mutations.md](./mutations.md#modelmutationname-config) |
| `Model.crud(sections)`         | Conventional list/get/create/update/destroy scaffold over `Model.query`/`Model.mutation`. | [mutations.md](./mutations.md#modelcrudsections)        |
| `Model.fetch(name, config)`    | Ephemeral, store-free reads scoped to a model.                                            | [queries.md](./queries.md#modelfetchname-config)        |
| `Model.poller(name, config)`   | Refcounted async status polling.                                                          | [runtime.md](./runtime.md#modelpollername-config)       |
| `Model.view(name, config)`     | Reactive joined projection over a scope.                                                  | [reading.md](./reading.md#modelviewname-config)         |
| `Model.ingest(entries)`        | Subscription event declarations.                                                          | [ingest-live.md](./ingest-live.md#modelingestentries)   |

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
| `bootDb`            | value | [getting-started.md](./getting-started.md#bootdboptions--suspenddb) |
| `suspendDb`         | value | [getting-started.md](./getting-started.md#bootdboptions--suspenddb) |
| `BootDbOptions`     | type  | [getting-started.md](./getting-started.md#bootdboptions--suspenddb) |
| `MaintenanceReport` | type  | [getting-started.md](./getting-started.md#bootdboptions--suspenddb) |
| `DbProvider`        | value | [getting-started.md](./getting-started.md#dbprovider)               |
| `DbProviderProps`   | type  | [getting-started.md](./getting-started.md#dbprovider)               |
| `mmkvStoragePlane`  | value | [getting-started.md](./getting-started.md#storage-seam)             |
| `StoragePlane`      | type  | [getting-started.md](./getting-started.md#storage-seam)             |
| `getDbTransport`    | value | [getting-started.md](./getting-started.md#transport-seam)           |
| `setDbTransport`    | value | [getting-started.md](./getting-started.md#transport-seam)           |
| `DbTransport`       | type  | [getting-started.md](./getting-started.md#transport-seam)           |

### Model DSL

| Export        | Kind  | Home                                       |
| ------------- | ----- | ------------------------------------------ |
| `defineModel` | value | [models.md](./models.md#definemodelconfig) |
| `ScopeHandle` | type  | [models.md](./models.md#scopes)            |
| `scope`       | value | [models.md](./models.md#scopes)            |
| `ScopeSpec`   | type  | [models.md](./models.md#scopespec)         |
| `ModelInput`  | type  | [models.md](./models.md#fields-f)          |
| `ModelStored` | type  | [models.md](./models.md#fields-f)          |
| `ViewConfig` | type | [reading.md](./reading.md#modelviewname-config) |
| `ViewIncludeModel` | type | [reading.md](./reading.md#modelviewname-config) |
| `ViewIncludeSpec` | type | [reading.md](./reading.md#modelviewname-config) |

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
| `LoadingState` | type | [queries.md](./queries.md#loading-state)              |
| `EnsuredRowResult` | type | [reading.md](./reading.md#ensured-point-reads) |

`use.*`, `Model.view`, and `ScopeHandle.use`/`useWindow` are methods, not separate barrel exports -
see [reading.md](./reading.md).

### Queries

| Export            | Kind  | Home                                                    |
| ----------------- | ----- | ------------------------------------------------------- |
| `defineFetch`     | value | [queries.md](./queries.md#definefetchconfig)            |
| `FetchResult`     | type  | [queries.md](./queries.md#fetchresult)                  |
| `QueryResult`     | type  | [queries.md](./queries.md#queryresult)                  |
| `ExtractSink`     | type  | [queries.md](./queries.md#modelqueryname-config)        |
| `LiveQueryHandle` | type  | [queries.md](./queries.md#live-subscription-colocation) |
| `ScopeCoverage`   | type  | [queries.md](./queries.md#scopecoverage-semantics)      |

`Model.query`/`Model.fetch` themselves are methods, not separate barrel exports - see
[queries.md](./queries.md).

### Mutations

| Export                    | Kind  | Home                                                     |
| ------------------------- | ----- | -------------------------------------------------------- |
| `defineCommand`           | value | [mutations.md](./mutations.md#definecommandname-config)  |
| `mergeOptimisticSnapshot` | value | [mutations.md](./mutations.md#mergeoptimisticsnapshot)   |
| `MutateCallbacks`         | type  | [mutations.md](./mutations.md#use-result-shape)          |
| `ScopePlacement`          | type  | [mutations.md](./mutations.md#optimistic-write-variants) |

`Model.mutation`/`Model.crud` themselves are methods, not separate barrel exports - see
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
| `collectGarbage`              | value | [runtime.md](./runtime.md#garbage-collection)                                   |
| `GcReport`                    | type  | [runtime.md](./runtime.md#garbage-collection)                                   |
| `flushPersistence`            | value | [runtime.md](./runtime.md#persistence-model)                                    |
| `reconcileOptimisticRows`     | value | [runtime.md](./runtime.md#reconcileoptimisticrowsmodel-nodes-options)           |
| `patchWhenRowExists`          | value | [runtime.md](./runtime.md#row-waiters)                                          |
| `waitForRow`                  | value | [runtime.md](./runtime.md#row-waiters)                                          |
| `mergeOptimisticMedia`        | value | [runtime.md](./runtime.md#mergeoptimisticmediaoptimistic-server)                |
| `createThrottledSingleFlight` | value | [runtime.md](./runtime.md#createthrottledsingleflightfn-options) |
| `createKeyedArrayPatcher`     | value | [runtime.md](./runtime.md#array-and-nested-object-patchers)                     |
| `createIdArrayPatcher`        | value | [runtime.md](./runtime.md#array-and-nested-object-patchers)                     |
| `createNestedObjectPatcher`   | value | [runtime.md](./runtime.md#array-and-nested-object-patchers)                     |
| `createSingletonStatics`      | value | [runtime.md](./runtime.md#createsingletonstaticsmodel-recordid-defaults)        |
| `generateTempId`              | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `isTempId`                    | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `isIncomingNewer`             | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `stringifyNullish`            | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `pickDefined`                 | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |
| `pickPresent`                 | value | [runtime.md](./runtime.md#scalar-and-id-utility-helpers)                        |

`Model.poller` itself is a method, not a separate barrel export - see
[runtime.md](./runtime.md#modelpollername-config).

# API reference

Full reference for `@noma4i/react-native-dblayer`. For a guided tour with narrative examples, see
the [project README](../README.md).

## Contents

- [Models](./models.md) - `defineModel` end-to-end: the `f`/`defineShape` field DSL, writes, reads
  (including the chainable `use.where` builder), scopes, relations, boot-time maintenance, and
  `Model.poller`/`Model.view`/`Model.ingest`.
- [Queries](./queries.md) - `Model.query` (network reads into a model/scope, pagination, coverage
  semantics, status surface), `defineFetch` (model-less reads), and the stable view/list read
  helpers.
- [Mutations](./mutations.md) - `Model.mutation` (optimistic lifecycle, temp-id replace, rollback,
  dedupe), `defineCommand` (model-less RPC), `mergeOptimisticSnapshot`, and mutation error policy.
- [Configuration](./configuration.md) - `configureDb`/`DbDefaults`, `bootDb`/`suspendDb` (including
  the maintenance report), the composable startup/teardown primitives, `resetRuntime`, the
  storage/transport seams, the subscription runtime, the persistence model, and the React Query
  passthrough.
- [Runtime primitives](./runtime-primitives.md) - maintenance/cleanup helpers, row waiters,
  a model-backed status poller, array/nested-object patchers, singleton statics, and small
  scalar/id/type-boundary utility helpers.

Every export below has exactly one home file - the doc where its full contract is documented.
Where a symbol is used from another doc's example (e.g. `belongsTo` inside a `Model.query` extract
sink), that doc links back to the symbol's home instead of re-documenting it.

## The model-centric surface

Every network-facing capability is a method on the model it belongs to. There are no standalone
`defineQuery`/`defineMutation`/`defineView`/`defineIngest` constructors.

| Method | Role | Home |
| --- | --- | --- |
| `Model.query(name, config)` | Network reads into a model/scope. | [queries.md](./queries.md#modelqueryname-config) |
| `Model.mutation(name, config)` | Optimistic network writes. | [mutations.md](./mutations.md#modelmutationname-config) |
| `Model.fetch(name, config)` | Ephemeral, store-free reads scoped to a model. | [models.md](./models.md#defineshape) |
| `Model.poller(name, config)` | Refcounted async status polling. | [models.md](./models.md#modelpollername-config) |
| `Model.view(name, config)` | Reactive joined projection over a scope. | [models.md](./models.md#modelviewname-config) |
| `Model.ingest(entries)` | Subscription event declarations. | [models.md](./models.md#modelingestentries) |

`defineFetch` (model-less reads) and `defineCommand` (model-less RPC) remain standalone
constructors for capabilities that do not belong to any single model.

## Export reference

Generated from `src/index.ts`, grouped by area.

### Config and lifecycle

| Export | Kind | Home |
| --- | --- | --- |
| `configureDb` | value | [configuration.md](./configuration.md#configuredboptions) |
| `DbDefaults` | type | [configuration.md](./configuration.md#dbdefaults) |
| `bootDb` | value | [configuration.md](./configuration.md#bootdboptions-suspenddb) |
| `suspendDb` | value | [configuration.md](./configuration.md#bootdboptions-suspenddb) |
| `MaintenanceReport` | type | [configuration.md](./configuration.md#bootdboptions-suspenddb) |
| `resetRuntime` | value | [configuration.md](./configuration.md#resetruntime-kill-switch) |
| `registerReset` | value | [configuration.md](./configuration.md#resetruntime-kill-switch) |
| `replayJournal` | value | [configuration.md](./configuration.md#composable-primitives) |
| `collectGarbage` | value | [configuration.md](./configuration.md#composable-primitives) |
| `GcReport` | type | [configuration.md](./configuration.md#composable-primitives) |
| `purgeForeignStorageKeys` | value | [configuration.md](./configuration.md#composable-primitives) |
| `flushPersistence` | value | [configuration.md](./configuration.md#composable-primitives) |
| `getDbQueryClient` | value | [configuration.md](./configuration.md#options) |
| `mmkvStoragePlane` | value | [configuration.md](./configuration.md#storage-seam) |
| `StoragePlane` | type | [configuration.md](./configuration.md#storage-seam) |
| `getDbTransport` | value | [configuration.md](./configuration.md#transport-seam) |
| `setDbTransport` | value | [configuration.md](./configuration.md#transport-seam) |
| `DbTransport` | type | [configuration.md](./configuration.md#dbtransport) |

### Model DSL

| Export | Kind | Home |
| --- | --- | --- |
| `defineModel` | value | [models.md](./models.md#definemodelconfig) |
| `ScopeHandle` | type | [models.md](./models.md#scopehandle) |
| `scope` | value | [models.md](./models.md#scopes) |
| `ScopeSpec` | type | [models.md](./models.md#scopespec) |
| `ModelInput` | type | [models.md](./models.md#fields-f) |
| `ModelStored` | type | [models.md](./models.md#fields-f) |

### Schema DSL

| Export | Kind | Home |
| --- | --- | --- |
| `f` | value | [models.md](./models.md#fields-f) |
| `defineShape` | value | [models.md](./models.md#fields-f) |
| `projectShape` | value | [models.md](./models.md#fields-f) |
| `readShape` | value | [models.md](./models.md#fields-f) |
| `readShapeOrThrow` | value | [models.md](./models.md#fields-f) |
| `InferShapeStored` | type | [models.md](./models.md#fields-f) |

### Relations

| Export | Kind | Home |
| --- | --- | --- |
| `belongsTo` | value | [models.md](./models.md#relations) |
| `hasMany` | value | [models.md](./models.md#relations) |
| `hasOne` | value | [models.md](./models.md#relations) |
| `references` | value | [models.md](./models.md#relations) |

### Queries

| Export | Kind | Home |
| --- | --- | --- |
| `Coverage` | type | [queries.md](./queries.md#coverage-semantics) |
| `defineFetch` | value | [queries.md](./queries.md#definefetchconfig) |
| `FetchResult` | type | [queries.md](./queries.md#fetchresult) |

`Model.query` itself is a method, not a separate barrel export - see
[queries.md](./queries.md#modelqueryname-config).

### Mutations

| Export | Kind | Home |
| --- | --- | --- |
| `MutateCallbacks` | type | [mutations.md](./mutations.md#use-result-shape) |
| `defineCommand` | value | [mutations.md](./mutations.md#definecommandname-config) |
| `mergeOptimisticSnapshot` | value | [mutations.md](./mutations.md#mergeoptimisticsnapshot) |

`Model.mutation` itself is a method, not a separate barrel export - see
[mutations.md](./mutations.md#modelmutationname-config).

### Ingest and subscriptions

| Export | Kind | Home |
| --- | --- | --- |
| `createDbSubscriptionRuntime` | value | [configuration.md](./configuration.md#createdbsubscriptionruntimeentries) |
| `createDbSubscriptionEffects` | value | [configuration.md](./configuration.md#createdbsubscriptioneffectsnoopeffects) |
| `defineDbSubscriptionEntry` | value | [configuration.md](./configuration.md#definedbsubscriptionentryentry) |

`Model.ingest` itself is a method, not a separate barrel export - see
[models.md](./models.md#modelingestentries).

### Read helpers

| Export | Kind | Home |
| --- | --- | --- |
| `useStableProjection` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `useStableEntity` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `useStableSorted` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `pickEqual` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `EMPTY_IDS` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `createUniqueIds` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `computeLoadingState` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `computePhase` | value | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `LoadingState` | type | [queries.md](./queries.md#stable-view-and-list-hooks) |
| `DbWhere` | type | [models.md](./models.md#reads) |
| `StableProjectionConfig` | type | [queries.md](./queries.md#stable-view-and-list-hooks) |

### Utilities

| Export | Kind | Home |
| --- | --- | --- |
| `generateTempId` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `isTempId` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `isIncomingNewer` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `castNode` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `castNodes` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `toStr` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `pickDefined` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `pickPresent` | value | [runtime-primitives.md](./runtime-primitives.md#utility-helpers) |
| `mergeOptimisticMedia` | value | [runtime-primitives.md](./runtime-primitives.md#mergeoptimisticmediaoptimistic-server) |
| `createModelStatusPoller` | value | [runtime-primitives.md](./runtime-primitives.md#createmodelstatuspollerconfig) |
| `createThrottledSingleFlight` | value | [runtime-primitives.md](./runtime-primitives.md) |
| `createKeyedArrayPatcher` | value | [runtime-primitives.md](./runtime-primitives.md#array-patchers) |
| `createIdArrayPatcher` | value | [runtime-primitives.md](./runtime-primitives.md#array-patchers) |
| `createNestedObjectPatcher` | value | [runtime-primitives.md](./runtime-primitives.md#createnestedobjectpatchermodel-field-transform) |
| `singletonStatics` | value | [runtime-primitives.md](./runtime-primitives.md#singletonstaticsmodel-recordid-defaults) |
| `reconcileOptimisticRows` | value | [runtime-primitives.md](./runtime-primitives.md#reconcileoptimisticrowsmodel-nodes-options) |
| `trimRowsPerScope` | value | [runtime-primitives.md](./runtime-primitives.md#cleanup-helpers) |
| `resolveStaleTempRows` | value | [runtime-primitives.md](./runtime-primitives.md#cleanup-helpers) |
| `patchWhenRowExists` | value | [runtime-primitives.md](./runtime-primitives.md#row-waiters) |
| `waitForRow` | value | [runtime-primitives.md](./runtime-primitives.md#row-waiters) |

### React Query passthrough

| Export | Kind | Home |
| --- | --- | --- |
| `focusManager` | value | [configuration.md](./configuration.md#react-query-passthrough) |
| `QueryClient` | value + type | [configuration.md](./configuration.md#react-query-passthrough) |
| `QueryClientProvider` | value | [configuration.md](./configuration.md#react-query-passthrough) |
| `useQuery` | value | [configuration.md](./configuration.md#react-query-passthrough) |
| `useQueryClient` | value | [configuration.md](./configuration.md#react-query-passthrough) |

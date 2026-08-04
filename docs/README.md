# API reference

Full reference for `@noma4i/react-native-dblayer`. Start with the [project README](../README.md).

## Reading order

| # | Page | Covers |
| --- | --- | --- |
| 1 | [getting-started.md](./getting-started.md) | Runtime configuration, provider, storage, and transport. |
| 2 | [models.md](./models.md) | Model schema, associations, relations, actions, events, writes, maintenance, and statics. |
| 3 | [reading.md](./reading.md) | Point reads, relations, counts, pagination, and operation state. |
| 4 | [queries.md](./queries.md) | Model-owned single, list, and connection GraphQL reads. |
| 5 | [mutations.md](./mutations.md) | Model-owned request, durable, and poll actions. |
| 6 | [ingest-live.md](./ingest-live.md) | Model-owned live events and subscription lifecycle. |
| 7 | [runtime.md](./runtime.md) | Reset, persistence, patchers, ids, and concurrency helpers. |

## The model-centric surface

Declare every model-bound capability inside `defineModel(key, config)`. The factory owner exposes
the only GraphQL DSL through `owner.gql`. Named relations become model methods. Actions live under
`Model.actions`. Events live under `Model.events`.

Every write source compiles one root and optional cross-model intents into one `WritePlan`. The
runtime persists one commit envelope before it publishes any row, scope, relation, or operation
state. A failed storage write publishes nothing.

## Export reference

The reference below matches `src/index.ts` exactly.

### Getting started

| Export | Kind | Home |
| --- | --- | --- |
| `configureDb` | value | [getting-started.md](./getting-started.md) |
| `DbDefaults` | type | [getting-started.md](./getting-started.md) |
| `DbRetryClass` | type | [getting-started.md](./getting-started.md) |
| `DbRetryPolicy` | type | [getting-started.md](./getting-started.md) |
| `DbProvider` | value | [getting-started.md](./getting-started.md) |
| `DbProviderProps` | type | [getting-started.md](./getting-started.md) |
| `StoragePlane` | type | [getting-started.md](./getting-started.md) |
| `DbTransport` | type | [getting-started.md](./getting-started.md) |
| `DbTransportError` | type | [getting-started.md](./getting-started.md) |

### Model DSL

| Export | Kind | Home |
| --- | --- | --- |
| `defineModel` | value | [models.md](./models.md) |
| `ModelInput` | type | [models.md](./models.md) |
| `ModelStored` | type | [models.md](./models.md) |
| `ModelAction` | type | [mutations.md](./mutations.md) |
| `ModelActionHook` | type | [mutations.md](./mutations.md) |
| `ModelEventHandle` | type | [ingest-live.md](./ingest-live.md) |
| `ModelWaitOptions` | type | [reading.md](./reading.md) |
| `Relation` | type | [reading.md](./reading.md) |
| `RelationOptions` | type | [reading.md](./reading.md) |
| `RelationResult` | type | [reading.md](./reading.md) |
| `RowOperation` | type | [reading.md](./reading.md) |
| `RowOperationState` | type | [reading.md](./reading.md) |

### Schema DSL

| Export | Kind | Home |
| --- | --- | --- |
| `f` | value | [models.md](./models.md) |
| `scalar` | value | [models.md](./models.md) |
| `defineShape` | value | [models.md](./models.md) |
| `projectShape` | value | [models.md](./models.md) |
| `readShape` | value | [models.md](./models.md) |
| `readShapeOrThrow` | value | [models.md](./models.md) |
| `InferShapeStored` | type | [models.md](./models.md) |
| `ScalarValue` | type | [models.md](./models.md) |

### Associations

| Export | Kind | Home |
| --- | --- | --- |
| `belongsTo` | value | [models.md](./models.md) |
| `hasMany` | value | [models.md](./models.md) |
| `hasOne` | value | [models.md](./models.md) |
| `modelRef` | value | [models.md](./models.md) |
| `references` | value | [models.md](./models.md) |

### Reading and queries

| Export | Kind | Home |
| --- | --- | --- |
| `DbWhere` | type | [reading.md](./reading.md) |
| `DbWhereOp` | type | [reading.md](./reading.md) |
| `LoadingState` | type | [queries.md](./queries.md) |
| `QueryResult` | type | [queries.md](./queries.md) |
| `fromNodes` | value | [queries.md](./queries.md) |
| `useLoadMore` | value | [queries.md](./queries.md) |
| `LoadMoreTarget` | type | [queries.md](./queries.md) |
| `LoadMoreOptions` | type | [queries.md](./queries.md) |
| `useMergedScopeRows` | value | [reading.md](./reading.md) |

### Writes and events

| Export | Kind | Home |
| --- | --- | --- |
| `WritePlan` | type | [mutations.md](./mutations.md) |
| `MutationDeliveryUnknownError` | value | [mutations.md](./mutations.md) |
| `useDbSubscriptions` | value | [ingest-live.md](./ingest-live.md) |

### Runtime

| Export | Kind | Home |
| --- | --- | --- |
| `resetRuntime` | value | [runtime.md](./runtime.md) |
| `registerReset` | value | [runtime.md](./runtime.md) |
| `setFetchNetworkOnline` | value | [runtime.md](./runtime.md) |
| `createThrottledSingleFlight` | value | [runtime.md](./runtime.md) |
| `createKeyedArrayPatcher` | value | [runtime.md](./runtime.md) |
| `createIdArrayPatcher` | value | [runtime.md](./runtime.md) |
| `createNestedObjectPatcher` | value | [runtime.md](./runtime.md) |
| `createSingletonStatics` | value | [runtime.md](./runtime.md) |
| `NumericField` | type | [runtime.md](./runtime.md) |
| `PatchModel` | type | [runtime.md](./runtime.md) |
| `RowId` | type | [runtime.md](./runtime.md) |
| `SingletonModel` | type | [runtime.md](./runtime.md) |
| `SingletonStatics` | type | [runtime.md](./runtime.md) |
| `generateTempId` | value | [runtime.md](./runtime.md) |
| `isTempId` | value | [runtime.md](./runtime.md) |
| `pickDefined` | value | [runtime.md](./runtime.md) |
| `pickPresent` | value | [runtime.md](./runtime.md) |

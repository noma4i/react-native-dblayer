# API reference

Full reference for `@noma4i/react-native-dblayer`. For a guided tour with narrative examples, see
the [project README](../README.md).

## Reading order

| #   | Page                                       | Covers                                                                                                                                                                                                                  |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [getting-started.md](./getting-started.md) | Boot sequence: register models, `configureDb`, `DbProvider`, the internal boot sequence and automatic background suspension, storage/transport seams, runtime prerequisites. Start here.                                                           |
| 2   | [models.md](./models.md)                   | `defineModel(key, config)`, schema, associations, named relations, actions, events, sideloads, writes, maintenance, and statics. |
| 3   | [reading.md](./reading.md)                 | `find`, `wait`, `useFind`, `where`, `byIds`, named `Relation` reads, counts, invalidation, pagination, and operation state. |
| 4   | [queries.md](./queries.md)                 | `gql.single`, `gql.connection`, relation loading state, and service-only `defineFetch`. |
| 5   | [mutations.md](./mutations.md)             | `gql.action`, request/durable/poll modes, and service-only `defineCommand`. |
| 6   | [ingest-live.md](./ingest-live.md)         | `gql.live`, `Model.events`, and the shared subscription runtime. |
| 7   | [runtime.md](./runtime.md)                 | Reset, persistence, patchers, ids, and concurrency helpers. |

Every export below has one home page. The reference table is checked against `src/index.ts`.

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
| `Model.wait(id, options)` | Read-only wait for one committed row. | [reading.md](./reading.md) |
| `Model.operation(id)` | Snapshot or subscribed row operation state. | [reading.md](./reading.md) |

`defineFetch` (model-less reads) and `defineCommand` (model-less RPC) remain standalone
constructors for capabilities that do not belong to any single model.

## Export reference

Generated from `src/index.ts`, grouped by area. Runtime (value) exports are gated by
`src/__tests__/spec/surface/docs-coverage.test.ts` - every name below must appear at least once
somewhere under `docs/`.

### Getting started

| Export              | Kind  | Home                                                                |
| ------------------- | ----- | ------------------------------------------------------------------- |
| `configureDb`       | value | [getting-started.md](./getting-started.md)       |
| `DbDefaults`        | type  | [getting-started.md](./getting-started.md)               |
| `DbRetryClass`      | type  | [getting-started.md](./getting-started.md)               |
| `DbRetryPolicy`     | type  | [getting-started.md](./getting-started.md)               |
| `DbProvider`        | value | [getting-started.md](./getting-started.md)               |
| `DbProviderProps`   | type  | [getting-started.md](./getting-started.md)               |
| `StoragePlane`      | type  | [getting-started.md](./getting-started.md)             |
| `DbTransport`       | type  | [getting-started.md](./getting-started.md)           |
| `DbTransportError`  | type  | [getting-started.md](./getting-started.md)           |

### Model DSL

| Export        | Kind  | Home                                       |
| ------------- | ----- | ------------------------------------------ |
| `defineModel` | value | [models.md](./models.md) |
| `gql`         | value | [models.md](./models.md) |
| `ModelInput`  | type  | [models.md](./models.md)          |
| `ModelStored` | type  | [models.md](./models.md)          |
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

| Export             | Kind  | Home                              |
| ------------------ | ----- | --------------------------------- |
| `f`                | value | [models.md](./models.md) |
| `scalar`           | value | [models.md](./models.md) |
| `defineShape`      | value | [models.md](./models.md) |
| `projectShape`     | value | [models.md](./models.md) |
| `readShape`        | value | [models.md](./models.md) |
| `readShapeOrThrow` | value | [models.md](./models.md) |
| `InferShapeStored` | type  | [models.md](./models.md) |
| `ScalarValue`      | type  | [models.md](./models.md) |

### Relations

| Export       | Kind  | Home                               |
| ------------ | ----- | ---------------------------------- |
| `belongsTo`  | value | [models.md](./models.md) |
| `hasMany`    | value | [models.md](./models.md) |
| `hasOne`     | value | [models.md](./models.md) |
| `modelRef`   | value | [models.md](./models.md) |
| `references` | value | [models.md](./models.md) |

### Reading

| Export         | Kind | Home                                                  |
| -------------- | ---- | ----------------------------------------------------- |
| `DbWhere`      | type | [reading.md](./reading.md) |
| `DbWhereOp`    | type | [reading.md](./reading.md) |
| `LoadingState` | type | [queries.md](./queries.md)              |
| `useMergedScopeRows` | value | [reading.md](./reading.md) |

### Queries

| Export            | Kind  | Home                                                    |
| ----------------- | ----- | ------------------------------------------------------- |
| `defineFetch`     | value | [queries.md](./queries.md)            |
| `FetchConfig`     | type  | [queries.md](./queries.md)            |
| `FetchHandle`     | type  | [queries.md](./queries.md)            |
| `FetchResult`     | type  | [queries.md](./queries.md)                  |
| `QueryResult`     | type  | [queries.md](./queries.md)                  |
| `fromNodes`       | value | [queries.md](./queries.md) |
| `useLoadMore` | value | [queries.md](./queries.md) |
| `LoadMoreTarget` | type | [queries.md](./queries.md) |
| `LoadMoreOptions` | type | [queries.md](./queries.md) |

### Mutations

| Export                    | Kind  | Home                                                     |
| ------------------------- | ----- | -------------------------------------------------------- |
| `defineCommand`           | value | [mutations.md](./mutations.md)  |
| `MutateCallbacks`         | type  | [mutations.md](./mutations.md)          |
| `ScopePlacement`          | type  | [mutations.md](./mutations.md) |
| `WritePlan`               | type  | [mutations.md](./mutations.md) |

### Ingest and subscriptions

| Export                        | Kind  | Home                                                                      |
| ----------------------------- | ----- | ------------------------------------------------------------------------- |
| `createDbSubscriptionRuntime` | value | [ingest-live.md](./ingest-live.md)     |
| `createDbSubscriptionEffects` | value | [ingest-live.md](./ingest-live.md) |
| `defineDbSubscriptionEntry`   | value | [ingest-live.md](./ingest-live.md)         |
| `IngestDecl`                  | type  | [ingest-live.md](./ingest-live.md)                     |

### Runtime

| Export                        | Kind  | Home                                                                            |
| ----------------------------- | ----- | ------------------------------------------------------------------------------- |
| `resetRuntime`                | value | [runtime.md](./runtime.md)                             |
| `registerReset`               | value | [runtime.md](./runtime.md)                             |
| `setFetchNetworkOnline`       | value | [runtime.md](./runtime.md)                          |
| `createThrottledSingleFlight` | value | [runtime.md](./runtime.md) |
| `createSingleFlight`          | value | [runtime.md](./runtime.md)          |
| `createKeyedArrayPatcher`     | value | [runtime.md](./runtime.md)                     |
| `createIdArrayPatcher`        | value | [runtime.md](./runtime.md)                     |
| `createNestedObjectPatcher`   | value | [runtime.md](./runtime.md)                     |
| `createSingletonStatics`      | value | [runtime.md](./runtime.md)        |
| `NumericField`                | type  | [runtime.md](./runtime.md)        |
| `PatchModel`                  | type  | [runtime.md](./runtime.md)        |
| `RowId`                       | type  | [runtime.md](./runtime.md)        |
| `SingletonModel`              | type  | [runtime.md](./runtime.md)        |
| `SingletonStatics`            | type  | [runtime.md](./runtime.md)        |
| `generateTempId`              | value | [runtime.md](./runtime.md)                        |
| `isTempId`                    | value | [runtime.md](./runtime.md)                        |
| `pickDefined`                 | value | [runtime.md](./runtime.md)                        |
| `pickPresent`                 | value | [runtime.md](./runtime.md)                        |

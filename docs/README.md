# API reference

Full reference for `@noma4i/react-native-dblayer`. For a guided tour with component examples, see the
[project README](../README.md).

## Contents

- [Configuration](./configuration.md) — `configureDb`, the transport/storage/logger/extract seams,
  `createMutationExtractResolver`, `createExtractSink`, and their adapter interfaces.
- [Models](./models.md) — `defineModel` options and the full `CollectionModel` read/write API.
- [Queries](./queries.md) — `useDbSingleRequest`, `modelDetailRequest`, `useDbInfiniteRequest`,
  `runDbQueryDirect`, their config options, and return shapes.
- [Stable views and list helpers](./queries.md#stable-view-and-list-hooks) — `useStableItems`, `useStableEntity`,
  `useWindowedLoadMore`.
- [Mutations](./mutations.md) — `useDbMutation` (default / patch / destroy variants), `useCommand`,
  `runDbCommandDirect`, `runDbMutationDirect`.
- [Runtime primitives](./runtime-primitives.md) — optimistic subscription reconcile, cleanup helpers,
  throttled single-flight, nested object patching, and singleton statics.

## Public runtime exports

| Export | Purpose | Signature essentials |
| --- | --- | --- |
| `EMPTY_IDS` | Shared empty string-id array. | `readonly string[]` |
| `belongsTo` | Define inverse relation from child to parent. | `belongsTo(model,{ foreignKey, touch? })` |
| `buildStableItems` | Build stable item projections outside React. | `buildStableItems(source, config, previous?)` |
| `castNode` | Type boundary cast for one node. | `castNode<T>(value)` |
| `castNodes` | Type boundary cast for node arrays. | `castNodes<T>(value)` |
| `clearAllCollections` | Clear every registered persistent collection. | `clearAllCollections.run()` |
| `clearDbStorage` | Clear DB-owned storage keys. | `clearDbStorage()` |
| `computeLoadingState` | Build UI loading-state flags from phase/data. | `computeLoadingState(phase, hasData)` |
| `computePhase` | Resolve a loading phase. | `computePhase(input)` |
| `configureDb` | Configure transport, storage, logger, query client, extract, tracking. | `configureDb(options)` |
| `createCollectionBinding` | Bind a model to scoped infinite-query reads/writes. | `createCollectionBinding(model, options?)` |
| `createDbSubscriptionRuntime` | Create imperative subscription dispatcher. | `createDbSubscriptionRuntime(entries)` |
| `defineDbSubscriptionEntry` | Type a subscription entry from its GraphQL document and root key. | `defineDbSubscriptionEntry(entry)` |
| `createDbSubscriptionEffects` | Create injectable UI-effects channel for subscription entries. | `createDbSubscriptionEffects(noopEffects)` |
| `createExtractSink` | Build extract sink from model/custom table. | `createExtractSink(sinkTable)` |
| `createIdArrayPatcher` | Create immutable id-array patch helpers. | `createIdArrayPatcher()` |
| `createKeyedArrayPatcher` | Create immutable keyed sub-row array patch helpers. | `createKeyedArrayPatcher(shape,{ key })` |
| `createModelStatusPoller` | Create non-React status poller. | `createModelStatusPoller(config)` |
| `createMutationExtractResolver` | Build mutation extract preset resolver. | `createMutationExtractResolver(presetTable)` |
| `createNestedObjectPatcher` | Create nested object patch helper. | `createNestedObjectPatcher(model, field, transform)` |
| `createThrottledSingleFlight` | Create coalesced throttled async runner. | `createThrottledSingleFlight(fn, options)` |
| `createUniqueIds` | Dedupe ids preserving order. | `createUniqueIds(ids)` |
| `defineModel` | Define a collection model. | `defineModel(config)` |
| `defineShape` | Define reusable field shape. | `defineShape<T>()(fields)` |
| `devClearAllDataAndState` | Clear collections and runtime state. | `devClearAllDataAndState()` |
| `f` | Field builder namespace. | `f.str(), f.num(), f.id(), ...` |
| `generateTempId` | Generate optimistic temporary id. | `generateTempId(prefix?)` |
| `getDbStorageKeys` | List DB-owned storage keys. | `getDbStorageKeys()` |
| `hasMany` | Define one-to-many relation. | `hasMany(model,{ foreignKey, dependent? })` |
| `hasManyThrough` | Define query-only through relation. | `hasManyThrough({ through, source })` |
| `hasOne` | Define one-to-one relation. | `hasOne(model,{ foreignKey })` |
| `invalidateDbRequests` | Invalidate explicit React Query key. | `invalidateDbRequests(key, options?)` |
| `invalidateModel` | Clear model freshness and invalidate model query keys. | `invalidateModel(model, scope?)` |
| `isIncomingNewer` | Compare updatedAt timestamps (incoming newer-or-equal wins). | `isIncomingNewer(existing, incoming)` |
| `isTempId` | Check optimistic temp id. | `isTempId(id)` |
| `liftExtractNodes` | Normalize extract payload to array. | `liftExtractNodes(value)` |
| `mergeInitialSyncContract` | Initial-page merge sync contract resolver. | `mergeInitialSyncContract(ctx)` |
| `mergeOptimisticMedia` | Preserve optimistic media while server catches up. | `mergeOptimisticMedia(optimistic, server)` |
| `mergeOptimisticSnapshot` | Merge optimistic row fields into server row. | `mergeOptimisticSnapshot(optimistic, server, options?)` |
| `mergeSyncContract` | Create merge sync contract. | `mergeSyncContract(source, scope?)` |
| `mmkvStorageAdapter` | Default MMKV storage adapter. | `StorageAdapter` |
| `mmkvStorageEventApi` | No-op RN storage event API. | `StorageEventApi` |
| `modelDetailRequest` | Build standard single-row request config. | `modelDetailRequest(model, config)` |
| `patchWhenPresent` | Patch a row now or when it appears. | `patchWhenPresent(model,id,patch,options)` |
| `pickDefined` | Build sparse patch from defined values. | `pickDefined(source, keys)` |
| `pickEqual` | Compare selected render keys. | `pickEqual(left,right,keys)` |
| `pickPresent` | Build sparse patch from non-nullish values. | `pickPresent(source, keys)` |
| `projectShape` | Project source through a shape. | `projectShape(shape, source, overrides?)` |
| `pruneStaleFetchStates` | Remove stale persisted fetch metadata. | `pruneStaleFetchStates(maxAgeMs?)` |
| `readId` | Read/coerce required id. | `readId(value)` |
| `readNullableNumber` | Read number or null. | `readNullableNumber(value)` |
| `readNullableString` | Read string or null. | `readNullableString(value)` |
| `readNumber` | Read required number. | `readNumber(value)` |
| `readShape` | Read reusable shape. | `readShape(shape, input)` |
| `readShapeOrThrow` | Read shape or throw labeled error. | `readShapeOrThrow(shape,input,label)` |
| `reconcileOptimisticRows` | Match server rows to optimistic rows. | `reconcileOptimisticRows(model,nodes,options)` |
| `removeDbStorageKey` | Remove one DB storage key. | `removeDbStorageKey(key)` |
| `replaceInitialSyncContract` | Initial-page replace sync contract resolver. | `replaceInitialSyncContract(ctx)` |
| `replaceSyncContract` | Create replace sync contract. | `replaceSyncContract(source, filter?)` |
| `resetAllModelsState` | Reset registered model runtime state. | `resetAllModelsState()` |
| `resetDbQueryRuntime` | Cancel and clear configured QueryClient. | `resetDbQueryRuntime()` |
| `resolveStaleTempRows` | Find stale temp rows and call handler. | `resolveStaleTempRows(model, options)` |
| `runDbCommandDirect` | Run command mutation outside React. | `runDbCommandDirect(config,input)` |
| `runDbInfiniteQueryDirect` | Run one infinite-query page outside React. | `runDbInfiniteQueryDirect(config,pageParam?)` |
| `runDbMutationDirect` | Run mutation config outside React. | `runDbMutationDirect(config,input,context?)` |
| `runDbQueryDirect` | Run single query outside React. | `runDbQueryDirect(config)` |
| `singletonStatics` | Build singleton model statics. | `singletonStatics(model, recordId, defaults)` |
| `stableSerialize` | Stable serialize scope objects. | `stableSerialize(value)` |
| `toStr` | Coerce nullable string. | `toStr(value)` |
| `trimRowsPerScope` | Trim rows per scope with protection. | `trimRowsPerScope(model, field, max, compare, protect?)` |
| `useCommand` | Run command mutation hook. | `useCommand(config)` |
| `useDbInfiniteRequest` | Run cursor-paginated query hook. | `useDbInfiniteRequest(config)` |
| `useDbMutation` | Run optimistic mutation hook. | `useDbMutation(config)` |
| `useDbSingleRequest` | Run single query hook. | `useDbSingleRequest(config)` |
| `useStableEntity` | Stabilize one entity reference. | `useStableEntity(value, config)` |
| `useStableItems` | Stabilize list item references. | `useStableItems(source, config)` |
| `useStableSorted` | Stable sorted projection hook. | `useStableSorted(source, compare, key?)` |
| `useWindowedLoadMore` | Window render count around loadMore/refetch. | `useWindowedLoadMore(loadMore, refetch, pageSize, resetKey)` |
| `waitForRow` | Resolve when row appears without polling. | `waitForRow(model,id,options)` |

## Conventions used in these docs

- **Reactive** = a React hook. Call it at the top level of a component (or another hook); it re-renders the
  component when the underlying data changes. Reactive members are called out explicitly.
- **Snapshot** = a synchronous, one-shot read. Safe to call anywhere — event handlers, effects, subscription
  handlers, non-React code.
- **Default** column: `—` means the option is optional with no effect when omitted; a concrete value is the
  effective default the library applies; "TanStack Query" means the underlying `@tanstack/react-query` default
  applies.
- All ids are `string`. Rows must have a `string` `id`; an optional `updatedAt` (ISO string) enables the
  newer-wins timestamp gate on writes.

## One model surface

Drive models through the direct `CollectionModel` API: `Model.find(id)`, `Model.where(...)`,
`Model.applyServerData(...)`, related accessors, and row-level related chains. See [Models](./models.md).

Data is fetched with the [query DSL](./queries.md) and changed with the [mutation DSL](./mutations.md); both write
into the same collections your components read from.

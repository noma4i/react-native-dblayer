# Runtime

The runtime owns canonical rows, relation indexes, operation state, write-ahead persistence,
pinpoint notifications, boot recovery, and cleanup.

## Persistence model

One logical plan persists the pending journal record before data, then persists data and the
committed marker. Boot replays an incomplete record. Cross-model sideloads, association effects,
relation membership, and optimistic correlation commit under one epoch.

## `resetRuntime()` kill-switch

`resetRuntime()` deletes persisted package state, clears every in-memory plane and registry, stops
stale work, and notifies mounted readers. Use it for logout or account replacement.
`registerReset(callback)` attaches package-owned cleanup to the same generation boundary.

## `setFetchNetworkOnline(online)`

Updates query retry state for network reachability. Offline work remains contained and mounted
readers receive the corresponding `LoadingState`.

## Row waiters

`waitForRow` resolves when a model row appears and supports timeout and abort.
`updateWhenRowExists` applies a patch immediately or after the row arrives. Both use commit
notifications and always detach their listener.

## Scalar and id utility helpers

`generateTempId` and `isTempId` own optimistic identity. Field codecs normalize supported scalar shapes.
`pickDefined` and `pickPresent`
build patches without accidental undefined or null values.

## Array and nested object patchers

`createKeyedArrayPatcher`, `createIdArrayPatcher`, and `createNestedObjectPatcher` preserve
unchanged references while updating nested stored values. `PatchModel` is the minimal target type.

## `createSingletonStatics(model, recordId, defaults)`

Builds model-owned singleton methods. `SingletonModel`, `SingletonStatics`, `NumericField`, and
`RowId` describe its type contract.

## `createSingleFlight(fn, options)`

Deduplicates concurrent work by key and clears entries on settlement.

## `createThrottledSingleFlight(fn, options)`

Adds a bounded start interval to keyed single-flight execution without retaining settled keys.

## Maintenance

Model `maintenance` rules trim idle relation indexes, stale temporary rows, and bounded
per-relation history. `DbProvider` runs boot maintenance and background cleanup. Garbage
collection preserves relation members, exempt rows, optimistic operations, and mounted readers.

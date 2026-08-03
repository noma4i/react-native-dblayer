# Reading

Every model provides point reads and immutable `Relation` objects.

## Point reads

`Model.find(id)` returns a snapshot. `Model.useFind(id, options)` subscribes to one row and accepts
field-level `renderKeys` or required fields. Nullish ids return `undefined` without caller guards.

`Model.wait(id, options)` resolves with the first committed row for the exact model and id.
`ModelWaitOptions` requires `timeoutMs` and accepts an `AbortSignal`. Nullish ids, timeout, abort,
and `resetRuntime()` resolve with `undefined`. The waiter never writes or retains deferred work.

## Relations

Named methods, `Model.where(where, options)`, `Model.byIds(ids)`, and association methods return a
`Relation`.

| Method | Contract |
| --- | --- |
| `read()` | Returns a local snapshot. |
| `fetch()` | Fetches the remote relation or resolves immediately for a local relation. |
| `seed(rows)` | Normalizes rows and replaces named relation membership. |
| `use(options)` | Subscribes and optionally loads remote data. |
| `count()` | Returns a snapshot count. |
| `useCount()` | Subscribes to count changes. |
| `invalidate()` | Invalidates only this relation identity. |
| `issueSequence(field)` | Reserves an order value for ordered named relations. |

## `RelationOptions`

| Option | Purpose |
| --- | --- |
| `pageSize` | Sets the visible local window. |
| `renderKeys` | Limits row change notifications to named fields. |
| `require` | Requires named fields before a row is complete. |
| `keepPrevious` | Retains the previous window while relation identity changes. |
| `enabled` | Enables remote work. |
| `loadMoreDebounceMs` | Debounces pagination advances. |

`RelationResult` contains `data`, `loadingState`, `error`, `hasMore`, `isFetchingMore`,
`isPreviousData`, `loadMore()`, and `refresh()`.

## Snapshot and subscribed reads

`DbWhere` supports exact values and `DbWhereOp` operators. `where` performs scoped local matching
without exposing the backing collection. `byIds` preserves requested identity order and skips
missing rows. Array reads preserve references for unchanged rows.

`useMergedScopeRows(baseRows, extraRows, options)` merges two model-less row sources with stable
identity. Model relations do not need this adapter.

## Row operation state

`Model.operation(id)` returns a `RowOperation`. `read()` snapshots and `use()` subscribes to
`RowOperationState`: `pending`, `failed`, and `unsyncedChanges`. This is the model-owned status
surface for optimistic work.

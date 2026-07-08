# Runtime Primitives

Utilities for subscription handlers, cleanup jobs, nested status updates, throttled syncs, and singleton rows.

## `reconcileOptimisticRows(model, nodes, options)`

Matches incoming server nodes against optimistic local rows and commits the best match.

| Option | Type | Description |
| --- | --- | --- |
| `resolveCandidates` | `(node) => rows` or `{ fields }` / `{ fieldMap }` | Candidate source. The shorthand uses `model.getWhere(...)`. |
| `isCandidate` | `(candidate, node) => boolean` | Extra predicate. Temp ids from `isTempId(candidate.id)` always qualify. |
| `match` | `(candidate, node) => boolean` | Domain content match. |
| `createdAtWindowMs` | `number` | Optional maximum absolute `createdAt` delta. |
| `commit` | `(tempId, node) => void` | Called for matched nodes. |

For each node, if `model.get(node.id)` already exists, the node is skipped. Otherwise the helper finds matching
candidates, chooses the one with the smallest absolute `createdAt` delta, calls `commit(candidate.id, node)`, and
omits it from the return value. The return value is the unmatched server nodes.

## Cleanup Helpers

| Helper | Behavior |
| --- | --- |
| `pruneOrphanedRows(model, foreignKeyField, liveParentIds)` | Deletes rows whose foreign key is not in the live id set. Uses one public `destroyMany(ids)` batch, so cascade and fetch-state clearing run. |
| `pruneExpiredRows(model, field, ttlMs, now?)` | Deletes rows whose timestamp field is older than `ttlMs`. Boundary rows and invalid/missing timestamps are kept. Uses public `destroyMany(ids)`. |
| `trimRowsPerScope(model, scopeField, maxPerScope, compare, protect?)` | Groups unprotected rows by scope, sorts each group with `compare`, keeps the first `maxPerScope`, deletes the rest through the internal maintenance delete path, and returns the deleted count. It does not cascade or clear fetch-state. Protected ids/rows do not count toward the limit. |
| `resolveStaleTempRows(model, { maxAgeMs, protectedIds?, onStale })` | Calls `onStale(row)` for temp-id rows older than `maxAgeMs` and not protected. Returns the resolved count. |

## `createOptimisticSequence()`

Returns `{ next: () => number }`, an independent monotonic counter for local optimistic ordering.

## `createThrottledSingleFlight(fn, { minIntervalMs, isForced? })`

Returns a function that coalesces concurrent calls and suppresses calls inside the post-success interval.

| Case | Result |
| --- | --- |
| A call is already in flight | Returns the same in-flight promise. |
| Previous successful call completed less than `minIntervalMs` ago | Returns `Promise.resolve(undefined)`. |
| `isForced(...args)` is true, or first arg has `{ force: true }` | Bypasses interval suppression. |
| `fn` rejects or throws | Resolves `undefined`; the success timestamp is not advanced. |

## Array patchers

`createKeyedArrayPatcher(shape, { key })` returns immutable helpers for array-of-shape sub-rows:

| Method | Parameters | Behavior |
| --- | --- | --- |
| `upsert` | `(rows, input)` | Normalizes `input` with `shape`, removes an existing row with the same `key`, then appends the normalized row. Nullish `rows` are treated as `[]`. |
| `remove` | `(rows, keyValue)` | Removes rows whose `key` equals `keyValue`. Nullish `rows` are treated as `[]`. |

`createIdArrayPatcher()` returns immutable helpers for id arrays:

| Method | Parameters | Behavior |
| --- | --- | --- |
| `upsert` | `(ids, id, 'prepend' | 'append')` | Dedupes `id` and inserts it at the requested edge. Nullish `ids` are treated as `[]`. |
| `remove` | `(ids, id)` | Removes `id`. Nullish `ids` are treated as `[]`. |

## `createNestedObjectPatcher(model, field, transform)`

Creates `(id, ...args) => boolean`.

| Parameter | Description |
| --- | --- |
| `model` | Model used to read and patch the containing row. |
| `field` | Nested object field to patch. |
| `transform` | Function that receives the current nested object and caller args, then returns a shallow partial update. |

The patcher reads the row, returns `false` when `row[field]` is `null` or missing, and otherwise patches
`{ [field]: { ...current, ...transform(current, ...args) } }`.

## `singletonStatics(model, recordId, defaults)`

Builds statics for one-row models:

| Static | Behavior |
| --- | --- |
| `recordId` | The singleton id. |
| `defaults` | The default row returned by `useCurrent()` before insertion. |
| `current()` | Snapshot read by `recordId`. |
| `useCurrent()` | Reactive read by `recordId`, falling back to `defaults`. |
| `upsert(input)` / `upsertCurrent(input)` | Patches existing row or inserts `{ ...defaults, ...input, id: recordId }`; ignores `input.id`. |
| `patchClamped(field, delta, min = 0)` | Adds `delta` to a numeric field and clamps at `min`. Returns `false` when the row is missing or `delta` is zero. |

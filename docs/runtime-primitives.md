# Runtime Primitives

Utilities for cleanup jobs, row waiters, nested status updates, throttled syncs, singleton rows,
and small scalar/id helpers used across the schema and mutation DSLs.

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
| `trimRowsPerScope(model, scopeField, maxPerScope, compare, protect?)` | Groups unprotected rows by scope, sorts each group with `compare`, keeps the first `maxPerScope`, deletes the rest with `model.destroyMany(ids)`, and returns the deleted count. Protected ids/rows (a predicate, a `Set`, or an id array) do not count toward the limit. |
| `resolveStaleTempRows(model, { maxAgeMs, protectedIds?, onStale })` | Calls `onStale(row)` for temp-id rows older than `maxAgeMs` and not protected. Returns the resolved count. |

Subscription-runtime and `defineIngest` primitives (`createDbSubscriptionRuntime`,
`defineDbSubscriptionEntry`, `createDbSubscriptionEffects`, `defineIngest`) are documented in
[configuration.md](./configuration.md#subscription-runtime-and-defineingest-echo-guard), alongside
the rest of the runtime configuration surface.

## Row waiters

### `patchWhenRowExists(model, id, patch, { ttlMs })`

Applies a partial patch immediately if `model.get(id)` exists. Otherwise it queues the patch on the
commit bus and applies it, in registration order, the moment a write makes the row exist. `patch`
may be a partial object or `(row) => partial`. TTL expiry drops the queued patch without applying it.

### `waitForRow(model, id, { timeoutMs, signal? })`

Resolves immediately with `model.get(id)` when present. Otherwise it subscribes to the commit bus and resolves
with the row when it appears, or `undefined` on timeout/abort. Every exit path removes the timer and subscription.

## `createModelStatusPoller(config)`

Creates a refcounted non-React poller for model-backed async status updates.

| Config | Signature essentials | Behavior |
| --- | --- | --- |
| `fetch` | `(id) => Promise<TResult>` | Fetches the latest status payload for an id. |
| `apply` | `(id, result) => void` | Writes fetched data back into the model. |
| `isTerminal` | `(result) => boolean` | Stops the session when the fetched payload is terminal. |
| `onSessionStop` | `(id, reason) => void` | Optional lifecycle callback for terminal payloads and exhausted budgets. |
| `intervalMs` | `number` | Interval between scheduled status refreshes. |
| `maxAttempts` | `number` | Maximum fetch attempts before a non-terminal session stops. |

`onSessionStop` receives reason `'terminal'` when `isTerminal(result)` stops the session and `'budget'` when
`maxAttempts` is exhausted. Last-detach teardown and `refresh(id, { resetBudget: true })` re-arming do not emit the
callback. Callback errors are logged and do not break polling.

| Method | Signature essentials | Behavior |
| --- | --- | --- |
| `attach` | `(id) => detach` | Starts or refs a session; the returned detach decrements refs and removes the last detached session. |
| `subscribe` | `(id, listener) => unsubscribe` | Observes terminal snapshot changes without adding refs or starting polling. |
| `refresh` | `(id, { resetBudget? }) => Promise<void>` | Runs an immediate fetch; `resetBudget` clears attempts and terminal state before fetching. |
| `isPolling` | `(id) => boolean` | True while an attached non-terminal session has an active interval. |
| `isSessionTerminal` | `(id) => boolean` | True while a retained session has stopped on a terminal payload or budget; detached/unknown ids return false. |

Subscribers are notified when terminal/budget stop changes the snapshot to true, when `resetBudget` clears it, and
when last detach removes a terminal session. Subscriber errors are logged and contained. The returned controller
avoids overlapping fetches per id. Fetch errors consume attempts, are logged, and never throw from scheduled ticks.

## `mergeOptimisticMedia(optimistic, server)`

Merges server media with optimistic local media fields. Server values win except for local preview/cover/blur data
that the server has not populated yet. Use it from mutation commit paths that must preserve visible media continuity
while the backend finishes processing.

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
| `upsertCurrent(input)` | Patches existing row or inserts `{ ...defaults, ...input, id: recordId }`; ignores `input.id`. |
| `patchClamped(field, delta, min = 0)` | Adds `delta` to a numeric field and clamps at `min`. Returns `false` when the row is missing or `delta` is zero. |

## Utility helpers

Small scalar/id/type-boundary helpers, standalone or used internally by the schema and mutation DSLs.

| Export | Signature | Behavior |
| --- | --- | --- |
| `generateTempId` | `(prefix?: string) => string` | Generates a stable-format optimistic temporary id: `temp[-prefix]-<timestamp>-<counter>`. Ids generated within the same millisecond share the timestamp but get a strictly increasing counter, so ids stay unique and sortable under rapid-fire calls. Used internally by `defineMutation`'s optimistic insert; also useful for building your own temp ids outside a mutation. |
| `isTempId` | `(id: string \| null \| undefined) => boolean` | Returns `true` for an id generated by `generateTempId` (starts with `temp-`). |
| `isIncomingNewer` | `(existingUpdatedAt, incomingUpdatedAt) => boolean` | The newer-wins acceptance gate: returns `true` when an incoming `updatedAt` is newer than or equal to the existing one. Nullish timestamps are permissive - both nullish accepts, only-existing-nullish accepts, only-incoming-nullish rejects (an incoming row with no timestamp cannot prove it is newer). Drop it straight into `merge.shouldOverwrite` (see [models.md](./models.md#definemodelconfig)). |
| `castNode` | `<T>(node: unknown) => T` | Type-only cast of one untyped node (e.g. a GraphQL response field) to `T` at a package boundary. Performs no runtime check or copy. |
| `castNodes` | `<T>(nodes: unknown[]) => T[]` | Type-only cast of an untyped node array to `T[]` at a package boundary. Performs no runtime check or copy. |
| `toStr` | `(v: unknown) => string \| null \| undefined` | `String(v)`, preserving explicit `null`/`undefined` as-is instead of stringifying them. Does not filter empty strings. |
| `pickDefined` | `(source, keys) => Partial<Pick<TSource, TKey>>` | Picks the listed keys whose values are not `undefined`; explicit `null` values are kept. |
| `pickPresent` | `(source, keys) => Partial<...>` | Picks the listed keys whose values are neither `null` nor `undefined`. |

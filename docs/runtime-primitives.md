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
| `trimRowsPerScope(model, scopeField, maxPerScope, compare, protect?)` | Groups unprotected rows by scope, sorts each group with `compare`, keeps the first `maxPerScope`, deletes the rest through the internal maintenance delete path, and returns the deleted count. It does not cascade or clear fetch-state. Protected ids/rows do not count toward the limit. |
| `resolveStaleTempRows(model, { maxAgeMs, protectedIds?, onStale })` | Calls `onStale(row)` for temp-id rows older than `maxAgeMs` and not protected. Returns the resolved count. |

## Subscription runtime and ingest primitives

### `createDbSubscriptionRuntime(entries)`

Creates an imperative subscription dispatcher for transport-level GraphQL subscriptions.

| Surface | Signature essentials | Behavior |
| --- | --- | --- |
| `setActive(active)` | `(active: boolean) => void` | Subscribes or unsubscribes every entry through the configured transport. |
| `isActive()` | `() => boolean` | Returns the runtime-wide active flag. |
| `stop()` | `() => void` | Unsubscribes active subscriptions and clears runtime state. |
| `dispatch(key, payload)` | `(key: string, payload: unknown) => void` | Manually routes a payload through the matching entry for tests or external transports. |
| `inspect()` | `() => DbSubscriptionRuntimeInspectRow[]` | Returns runtime status rows for diagnostics. |

Entries provide `{ key, query, vars?, debounce?, onData }`. The runtime unwraps transport response data by `key`,
validates a record payload, applies optional keyed trailing debounce, and calls `onData(payload)`. Transport errors
are logged, unsubscribed, and retried with bounded exponential backoff.

Use `defineDbSubscriptionEntry({ key, query, vars, debounce, onData })` with a typed GraphQL document. It constrains
`key` to a result root field, infers `vars` from the document variables, and types `onData`/`debounce.keyOf` from the
selected root payload while still returning an entry that can join a heterogeneous runtime registry.

### `createDbSubscriptionEffects`

Creates an injectable UI-effects channel for subscription entries. It returns `{ effects, configure(overrides), reset() }`;
the `effects` table and every wrapper keep stable identity while forwarding to the currently configured effect.
Entries capture `channel.effects` when they are built, then the effect owner calls `configure` on mount and `reset` on
teardown without rebinding entries.

## Row waiters

### `patchWhenPresent(model, id, patch, { ttlMs })`

Applies a partial patch immediately if `model.get(id)` exists. Otherwise it queues the patch and applies queued
patches in registration order when the row appears through the model collection's `subscribeChanges` channel.
`patch` may be a partial object or `(row) => partial`. TTL expiry drops queued patches and logs a debug entry.
Model runtime reset clears deferred queues.

### `waitForRow(model, id, { timeoutMs, signal? })`

Resolves immediately with `model.get(id)` when present. Otherwise it subscribes to the model collection and resolves
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

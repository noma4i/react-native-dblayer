# Runtime

Everything that keeps a long-lived session healthy: maintenance and garbage collection, the
`resetRuntime` kill-switch, the write-ahead persistence model, a model-backed status poller, and the
small cleanup/row-waiter/patcher/scalar helpers used across the schema and mutation DSLs.

## Contents

- [Maintenance](#maintenance)
- [Garbage collection](#garbage-collection)
- [`resetRuntime()` kill-switch](#resetruntime-kill-switch)
- [Persistence model](#persistence-model)
- [`Model.poller(name, config)`](#modelpollername-config)
- [`reconcileOptimisticRows(model, nodes, options)`](#reconcileoptimisticrowsmodel-nodes-options)
- [Row waiters](#row-waiters)
- [`mergeOptimisticMedia(optimistic, server)`](#mergeoptimisticmediaoptimistic-server)
- [`createThrottledSingleFlight(fn, options)`](#createthrottledsingleflightfn-options)
- [Array and nested-object patchers](#array-and-nested-object-patchers)
- [`createSingletonStatics(model, recordId, defaults)`](#createsingletonstaticsmodel-recordid-defaults)
- [Scalar and id utility helpers](#scalar-and-id-utility-helpers)

## Maintenance

```ts
maintenance: {
  maxRowsPerScope: [
    { scopeField: 'chatId', limit: 500, compare: (a, b) => Number(b.createdAt) - Number(a.createdAt) }
  ],
  dropIdleScopesAfterMs: 30 * 60 * 1000
}
```

Declared on `ModelConfig.maintenance` (see [models.md](./models.md#definemodelconfig)):

| Field                    | Type                                                | Description                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRowsPerScope`         | `Array<{ scopeField, limit, compare, protect? }>`      | Groups rows by `scopeField`, keeps the first `limit` per group ordered by `compare` (newest/most-important first), and deletes the rest. `protect?: () => (row) => boolean` is evaluated at run time (may read other models) to exempt rows from the count. |
| `dropIdleScopesAfterMs`   | `number` (ms)                                          | Opt-in idle scope collection: a scope with no read in this window is removed on the next `collectGarbage()` sweep, and its rows then follow normal reachability (evicted too, unless another scope/reference/reader still roots them). Omit to keep every scope alive until it empties on its own. |

`maxRowsPerScope` tasks run once, at boot, as part of `bootDb` (see
[getting-started.md](./getting-started.md#bootdboptions--suspenddb)) - not on every write. Temp-row
cleanup does not need a maintenance entry: it is already handled by the replay orphan sweep during
boot. Each declared model surfaces one `MaintenanceReport` per `maxRowsPerScope` task
(`{ model, task: 'maxRowsPerScope', affected }`) in `bootDb`'s return value.

`dropIdleScopesAfterMs` is checked differently: every time `collectGarbage()` runs (at boot, in
`suspendDb`, from an in-session GC-trigger sweep, or a direct call) - not just once at startup. A
"read" is a mounted `use`/`useWindow`/`useCount` scope reader, a mounted `Model.view` reader over
that scope (stamped once at mount time - re-renders never re-stamp), or a `ScopeHandle.read(...)`
snapshot call - all three stamp the scope's last-access time. A currently-mounted reactive reader
always survives regardless of that timestamp, since its live commit-bus subscription roots the
scope directly. A scope restored from storage at hydration also gets a fresh access timestamp, so
a session restart never makes an existing scope instantly idle-eligible before the app has had a
chance to read it again. Idle removal is reflected in `GcReport.scopesRemoved` alongside ordinary
dead/empty scope cleanup - the two are not counted separately.

## Garbage collection

```ts
import { collectGarbage } from '@noma4i/react-native-dblayer';

const report = collectGarbage(); // { evicted, scopesRemoved }, both keyed by model id
```

`collectGarbage(): GcReport` runs a reachability sweep over every registered model. Roots: scope
members, `gc: 'exempt'` model rows (see [models.md](./models.md#definemodelconfig)), pending
optimistic operations, and every mounted reader (`use.row` roots that row, a model-wide reader
roots the whole model, a scope reader roots its members). Edges: `belongsTo`/`references` of live
rows. Unreached rows are evicted (no tombstones - a later write resurrects them cleanly, see
[models.md](./models.md#writes)), dead scope entries detached, empty scope keys removed, opt-in
idle scopes dropped (`maintenance.dropIdleScopesAfterMs`, see [Maintenance](#maintenance) above),
then persistence flushes. Safe to call during in-session UI rendering - a sweep never evicts a row
any mounted reader is currently reading. Returns `{ evicted, scopesRemoved }`, both keyed by model
id.

`collectGarbage` runs automatically as part of `bootDb`'s startup sequence and `suspendDb`'s
teardown sequence (see [getting-started.md](./getting-started.md#bootdboptions--suspenddb)); most
apps never call it directly.

### In-session GC trigger

Watches every applied write and, once enough eviction-shaped pressure accumulates, runs one
debounced `collectGarbage()` sweep automatically - long-lived sessions reclaim unreachable rows
without the host app ever calling `collectGarbage()` itself.

Pressure accumulates as (rows that actually disappeared - destroyed or GC-evicted) + (detached
scope entries). Bulk inserts and hydration build no pressure: a brand-new row also reports
`fields: null` on its commit batch, but nothing disappeared, so it does not count. Once pressure
reaches `threshold` (default 500) and no sweep is already pending, a `debounceMs` (default 1000)
timer arms; further pressure while it pends keeps accumulating but does not add a second timer. On
fire, `collectGarbage()` runs once and pressure resets to zero. `collectGarbage()`'s own published
batch never counts toward pressure, so a sweep can never re-trigger itself.

`resetRuntime()` stops the current trigger and cancels any pending sweep; the next `configureDb`
call starts a fresh one. Set `defaults.inSessionGc: false` on `configureDb` to disable the trigger
entirely (see [getting-started.md](./getting-started.md#dbdefaults)) - `bootDb`'s startup sweep and
any manual `collectGarbage()` call are unaffected either way.

## `resetRuntime()` kill-switch

```ts
import { resetRuntime } from '@noma4i/react-native-dblayer';

resetRuntime(); // e.g. on logout
```

Full invalidation in one call: discards pending checkpoint snapshots, deletes every persisted key
under the library namespace, clears all registered in-memory state, and notifies every live
subscriber. There is no partial/per-model variant - the host app decides when to pull it. Fully
synchronous by design: state is clean the moment the call returns, with no deferred teardown to
await, so seeding and subsequent reads can rely on it immediately.

`registerReset(reset: () => void | Promise<void>) => () => void` registers extra in-memory state
that the kill-switch must clear; `defineModel` calls it automatically for its own planes, so use it
directly only for runtime state defined outside a model. `resetRuntime` throws if a registered
resetter returns a `Promise` - an async resetter is a registration error, not a supported case.

## Persistence model

Every write compiles into a plan that persists as write-ahead log (WAL) plus checkpoints: the plan
writes exactly one pending journal record first, then - off the hot path, batched by the checkpoint
scheduler - the affected model snapshots plus a record marking the journal entry committed. A torn
write (the app killed mid-flush) always leaves a replayable pending record rather than a corrupted
snapshot, since the two storage batches are never interleaved with a partial snapshot in between.

At boot, deferred definition validation runs first (see
[getting-started.md](./getting-started.md#bootdboptions--suspenddb)), then journal replay
re-applies every pending record left over from the last session (the recovery half of WAL), then a
`collectGarbage()` sweep reclaims anything that replay left unreachable, foreign storage keys
(outside the library's `dbl:` namespace - pre-migration leftovers) are cleared, and declared model
maintenance runs last - together, the boot compaction pass that brings persisted state back to
exactly what a live session would have produced.

`flushPersistence(): void` forces a checkpoint flush now - pending model snapshots hit storage in
one batch. `suspendDb()` calls it as part of the recommended background/teardown sequence; call it
directly only for a different flush timing need.

```ts
import { flushPersistence } from '@noma4i/react-native-dblayer';

flushPersistence();
```

## `Model.poller(name, config)`

A refcounted, non-React status poller scoped to a model, for server-side async processing
(image/video transcoding, moderation, batch jobs) where a row needs periodic re-fetching until a
terminal state is reached.

```ts
const messagePoller = MessageModel.poller('delivery-status', {
  document: MessageStatusDocument,
  vars: id => ({ messageId: id }),
  apply: (id, data) => MessageModel.patch(id, { deliveryStatus: data.messageStatus.status }),
  classify: data => {
    if (data.messageStatus.status === 'delivered') return 'ready';
    if (data.messageStatus.status === 'failed') return 'failed';
    return null;
  },
  intervalMs: 3000,
  maxAttempts: 20
});

const detach = messagePoller.attach(messageId); // starts polling; call on unmount to stop
const phase = messagePoller.usePhase(messageId);
```

| Config          | Signature essentials                        | Behavior                                                                                           |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `document`       | GraphQL document                                | Query document fetched per id over the configured transport, in place of a bare `fetch` function. |
| `vars`           | `(id) => Record<string, unknown>`                | Derive query variables from the polled id. Defaults to `{ id }`.                                  |
| `apply`          | `(id, result) => void`                           | Writes fetched data back into the model.                                                          |
| `classify`       | `(result) => 'ready' \| 'failed' \| null`        | Classifies terminal success/failure; `null` keeps polling.                                        |
| `onSessionStop`  | `(id, reason) => void`                           | Optional lifecycle callback for terminal payloads, exhausted budgets, and active-session detach.  |
| `intervalMs`     | `number`                                          | Interval between scheduled status refreshes.                                                      |
| `maxAttempts`    | `number`                                          | Maximum fetch attempts before a non-terminal session stops.                                       |

Fetch failures log as `<modelId>:<name>` and consume an attempt like any other failed poll.
`onSessionStop` receives `'terminal-payload'` for ready/failed classification, `'budget-exhausted'`
at `maxAttempts`, and `'stopped'` when the last ref detaches an active session. Callback errors are
logged and do not break polling.

| Method        | Signature essentials                        | Behavior                                                                                             |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `attach`       | `(id) => detach`                                | Starts or refs a session; the returned detach decrements refs and removes the last detached session. |
| `subscribe`    | `(id, listener) => unsubscribe`                 | Observes phase/attempt snapshots for one id without adding refs or starting polling.                  |
| `refresh`      | `(id, { resetBudget? }) => Promise<void>`        | Runs an immediate fetch; `resetBudget` clears attempts and restarts terminal or stalled state.        |
| `isPolling`    | `(id) => boolean`                                | True while an attached polling session has an active interval.                                        |
| `getPhase`     | `(id) => ModelStatusPollerPhase`                 | Returns the stable idle/polling/ready/failed/stalled snapshot.                                        |
| `usePhase`     | `(id) => ModelStatusPollerPhase`                 | Reactively reads only that id's phase and attempts.                                                   |

`classify` is the only terminal classifier. It returns `'ready'` or `'failed'` for a terminal
payload and `null` to keep polling. The phase machine is:

| Phase      | Reason                | Meaning                                             |
| ------------ | ------------------------ | ---------------------------------------------------- |
| `idle`      | omitted or `stopped`     | Never attached, reset, or already detached.         |
| `polling`   | omitted                  | Active, with attempt budget remaining.              |
| `ready`     | `terminal-payload`       | `classify` reported successful completion.          |
| `failed`    | `terminal-payload`       | `classify` reported terminal failure.               |
| `stalled`   | `budget-exhausted`       | `maxAttempts` completed without a terminal payload. |

Subscribers are notified only when their id's phase, reason, or attempts change. Last detach
retains an idle snapshot with reason `stopped`; runtime reset clears every snapshot to idle with
zero attempts and cancels every timer. The returned controller avoids overlapping fetches per id.

## `reconcileOptimisticRows(model, nodes, options)`

Matches incoming server nodes against optimistic local rows and commits the best match.

```ts
import { reconcileOptimisticRows } from '@noma4i/react-native-dblayer';
```

| Option               | Type                                               | Description                                                             |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `resolveCandidates`   | `(node) => rows` or `{ fields }` / `{ fieldMap }`       | Candidate source. The shorthand uses `model.getWhere(...)`.               |
| `isCandidate`         | `(candidate, node) => boolean`                          | Extra predicate. Temp ids from `isTempId(candidate.id)` always qualify.   |
| `match`               | `(candidate, node) => boolean`                          | Domain content match.                                                     |
| `createdAtWindowMs`   | `number`                                                | Optional maximum absolute `createdAt` delta.                              |
| `commit`              | `(tempId, node) => void`                                | Called for matched nodes.                                                 |

For each node, if `model.get(node.id)` already exists, the node is skipped. Otherwise the helper
finds matching candidates, chooses the one with the smallest absolute `createdAt` delta, calls
`commit(candidate.id, node)`, and omits it from the return value. The return value is the unmatched
server nodes.

## Row waiters

```ts
import { patchWhenRowExists, waitForRow } from '@noma4i/react-native-dblayer';
```

### `patchWhenRowExists(model, id, patch, { ttlMs })`

Applies a partial patch immediately if `model.get(id)` exists. Otherwise it queues the patch on the
commit bus and applies it, in registration order, the moment a write makes the row exist. `patch`
may be a partial object or `(row) => partial`. TTL expiry drops the queued patch without applying it.

### `waitForRow(model, id, { timeoutMs, signal? })`

Resolves immediately with `model.get(id)` when present. Otherwise it subscribes to the commit bus and resolves
with the row when it appears, or `undefined` on timeout/abort. Every exit path removes the timer and subscription.

## `mergeOptimisticMedia(optimistic, server)`

Merges server media with optimistic local media fields. Server values win except for local preview/cover/blur data
that the server has not populated yet. Use it from mutation commit paths that must preserve visible media continuity
while the backend finishes processing.

## `createThrottledSingleFlight(fn, options)`

Returns a function that coalesces concurrent calls and suppresses calls inside the post-success interval.

| Case                                                                | Result                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| A call is already in flight                                          | Returns the same in-flight promise.                          |
| Previous successful call completed less than `minIntervalMs` ago     | Returns `Promise.resolve(undefined)`.                         |
| `isForced(...args)` is true, or first arg has `{ force: true }`      | Bypasses interval suppression.                                 |
| `fn` rejects or throws                                               | Resolves `undefined`; the success timestamp is not advanced.  |

## Array and nested-object patchers

`createKeyedArrayPatcher(shape, { key })` returns immutable helpers for array-of-shape sub-rows:

| Method     | Parameters            | Behavior                                                                                                                                             |
| ----------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsert`   | `(rows, input)`         | Normalizes `input` with `shape`, removes an existing row with the same `key`, then appends the normalized row. Nullish `rows` are treated as `[]`. |
| `remove`   | `(rows, keyValue)`      | Removes rows whose `key` equals `keyValue`. Nullish `rows` are treated as `[]`.                                                                     |

`createIdArrayPatcher()` returns immutable helpers for id arrays:

| Method     | Parameters                            | Behavior                                                                                |
| ----------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `upsert`   | `(ids, id, 'prepend' \| 'append')`       | Dedupes `id` and inserts it at the requested edge. Nullish `ids` are treated as `[]`.    |
| `remove`   | `(ids, id)`                              | Removes `id`. Nullish `ids` are treated as `[]`.                                          |

`createNestedObjectPatcher(model, field, transform)` creates `(id, ...args) => boolean`:

| Parameter    | Description                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `model`      | Model used to read and patch the containing row.                                                          |
| `field`      | Nested object field to patch.                                                                              |
| `transform`  | Function that receives the current nested object and caller args, then returns a shallow partial update. |

The patcher reads the row, returns `false` when `row[field]` is `null` or missing, and otherwise patches
`{ [field]: { ...current, ...transform(current, ...args) } }`.

## `createSingletonStatics(model, recordId, defaults)`

Builds statics for one-row models:

| Static                                 | Behavior                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `recordId`                               | The singleton id.                                                                                                   |
| `defaults`                               | The default row returned by `useCurrent()` before insertion.                                                        |
| `current()`                              | Snapshot read by `recordId`.                                                                                        |
| `useCurrent()`                           | Reactive read by `recordId`, falling back to `defaults`.                                                            |
| `upsertCurrent(input)`                   | Patches existing row or inserts `{ ...defaults, ...input, id: recordId }`; ignores `input.id`.                      |
| `patchClamped(field, delta, min = 0)`    | Adds `delta` to a numeric field and clamps at `min`. Returns `false` when the row is missing or `delta` is zero.   |

## Scalar and id utility helpers

Small scalar/id helpers, standalone or used internally by the schema and mutation DSLs.

| Export              | Signature                                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateTempId`    | `(prefix?: string) => string`                             | Generates a stable-format optimistic temporary id: `temp[-prefix]-<timestamp>-<counter>`. Ids generated within the same millisecond share the timestamp but get a strictly increasing counter, so ids stay unique and sortable under rapid-fire calls. Used internally by `Model.mutation`'s optimistic insert (see [mutations.md](./mutations.md#optimistic-write-variants)); also useful for building your own temp ids outside a mutation. |
| `isTempId`          | `(id: string \| null \| undefined) => boolean`             | Returns `true` for an id generated by `generateTempId` (starts with `temp-`).                                                                                                                                                                                                                                                                                                                                    |
| `isIncomingNewer`   | `(existingUpdatedAt, incomingUpdatedAt) => boolean`         | The newer-wins acceptance gate: returns `true` when an incoming `updatedAt` is newer than or equal to the existing one. Nullish timestamps are permissive - both nullish accepts, only-existing-nullish accepts, only-incoming-nullish rejects (an incoming row with no timestamp cannot prove it is newer). Drop it straight into `merge.shouldOverwrite` (see [models.md](./models.md#definemodelconfig)). |
| `stringifyNullish`  | `(v: unknown) => string \| null \| undefined`               | `String(v)`, preserving explicit `null`/`undefined` as-is instead of stringifying them. Does not filter empty strings.                                                                                                                                                                                                                                                                                            |
| `pickDefined`       | `(source, keys) => Partial<Pick<TSource, TKey>>`            | Picks the listed keys whose values are not `undefined`; explicit `null` values are kept.                                                                                                                                                                                                                                                                                                                          |
| `pickPresent`       | `(source, keys) => Partial<...>`                            | Picks the listed keys whose values are neither `null` nor `undefined`.                                                                                                                                                                                                                                                                                                                                            |

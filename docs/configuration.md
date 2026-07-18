# Configuration

Configure the library once, at app start, before any model, query, or mutation runs.

## `configureDb(options)`

One call that wires every injected seam (transport, storage, query client, logger) and the
package-wide defaults. Calling it again advances the runtime generation, discards cached
apply/operation runtimes, and re-applies the transport/logger.

```ts
import { configureDb } from '@noma4i/react-native-dblayer';
import { apolloClient } from './apollo';
import { queryClient } from './queryClient';

configureDb({
  transport: {
    query: op => apolloClient.query({ query: op.query, variables: op.variables, fetchPolicy: 'no-cache' }).then(r => ({ data: r.data })),
    mutation: op => apolloClient.mutate({ mutation: op.mutation, variables: op.variables }).then(r => ({ data: r.data }))
  },
  queryClient,
  defaults: { staleTime: 30_000, pageSize: 20, onSyncError: (error, ctx) => reportSyncError(error, ctx) }
  // storage defaults to mmkvStoragePlane(), logger to no-op.
});
```

Most apps should call `bootDb(options)` instead of `configureDb` directly - it wraps this call with
the recommended startup sequence. `configureDb` stays exported for callers with a different startup
sequencing need.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `transport` | `DbTransport` | **required** | GraphQL transport (`query`/`mutation`/optional `subscribe`) used by `Model.query`/`Model.mutation`/subscription runtimes. See Transport seam below. |
| `storage` | `StoragePlane` | `mmkvStoragePlane()` | Synchronous key/value seam for persistence. See Storage seam below. |
| `queryClient` | `QueryClient` | `undefined` | TanStack Query client shared with `Model.query`'s hooks and the imperative `getDbQueryClient()`. |
| `logger` | `DbLogger` | no-op | Package logger seam: `{ debug, error }`. |
| `defaults` | `DbDefaults` | `{}` | Package-wide freshness/pagination/error-observation defaults. See below. |

### `DbDefaults`

| Field | Type | Description |
| --- | --- | --- |
| `staleTime` | `number` (ms) | Package-wide default `staleTime` for `Model.query`/`defineFetch` results that omit their own. |
| `emptyStaleTime` | `number` (ms) | Package-wide default `emptyStaleTime` for `Model.query` results that omit their own. |
| `gcTime` | `number` (ms) | Package-wide default TanStack Query cache `gcTime` for results that omit their own. |
| `pageSize` | `number` | Package-wide default window size for `ScopeHandle.useWindow`/`Model.view`'s `useWindow` when its own `pageSize` is omitted. |
| `persistence.checkpointDelayMs` / `persistence.maxPendingPlans` | `number` | Checkpoint flush tuning: how long snapshots wait, and how many pending plans accumulate, before a batched flush leaves the hot path. |
| `inSessionGc` | `false \| { threshold?, debounceMs? }` | ON by default (`threshold: 500`, `debounceMs: 1000`) - see [In-session GC trigger](#in-session-gc-trigger) below. `false` disables it entirely. |
| `onSyncError` | `(error: Error, ctx) => void` | Observes contained pipeline failures without changing their control flow. See the policy table below. |

### `onSyncError` policy

`onSyncError` is called for a caught failure in exactly one of three independent pipelines. It
never changes whether the failure also surfaces through its normal channel (a query's `error`
field, a mutation's thrown rejection, or a dropped ingest event) - it is a side observation, not
an error handler.

| `ctx.source` | Raised by | Also surfaces as |
| --- | --- | --- |
| `'query'` | A `Model.query`/`defineFetch` transport failure. | The status surface's `error` field / `FetchResult.error` (see [queries.md](./queries.md#error-surfacing)). |
| `'mutation'` | A `Model.mutation`/`defineCommand` run that threw, after rollback completed. | The rejected `run(input)`/`mutateAsync(input)` promise (see [mutations.md](./mutations.md#error-policy)). |
| `'ingest'` | A `Model.ingest` handler or its resulting plan apply that threw. | Nothing else - the event is dropped. |

`ctx` also carries `model`/`scope`/`key`/`event` where applicable, identifying which model or
document raised the failure. A throw inside `onSyncError` itself is caught and logged through the
configured `DbLogger`, never re-thrown into the pipeline that reported it.

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
call starts a fresh one. Set `inSessionGc: false` to disable the trigger entirely - `bootDb`'s
startup sweep and any manual `collectGarbage()` call are unaffected either way.

## `bootDb(options)` / `suspendDb()`

The recommended app-lifecycle pair. `bootDb` wraps `configureDb` with the startup sequence a real
app needs; `suspendDb` wraps the matching background/teardown sequence. `configureDb`,
`replayJournal`, `collectGarbage`, and `purgeForeignStorageKeys` all stay exported individually as
composable primitives for apps with different sequencing needs - `bootDb`/`suspendDb` are the
recommended path for the common case.

```ts
import { bootDb, suspendDb } from '@noma4i/react-native-dblayer';
import './models'; // import every model module FIRST so its apply target is registered

async function start() {
  const { replayed, gc, maintenance } = await bootDb({ transport, queryClient });
  console.log(`replayed ${replayed} journal records, evicted`, gc.evicted);
  console.log('ran maintenance', maintenance);
}

// On app background / before logout teardown:
suspendDb();
```

`bootDb(options)` takes the exact same options as `configureDb`, and runs, in order:
`configureDb(options)`, deferred definition validation (see below), `replayJournal()` (recovers
WAL-only writes from a crash), `collectGarbage()` (reclaims rows left unreachable by that replay),
`purgeForeignStorageKeys()` (clears pre-migration/foreign storage keys), then every declared
`ModelConfig.maintenance` task (see [models.md](./models.md#maintenance)). Every model module MUST
be imported before calling it - `replayJournal` throws on a journal record whose model has no
registered apply target, and `bootDb` does not catch or swallow any step's error; a silent partial
boot is worse than a startup crash. Returns `{ replayed, gc, maintenance }`: the replayed journal
record count, the `collectGarbage` report for the post-replay sweep, and one `MaintenanceReport`
(`{ model, task: 'maxRowsPerScope', affected }`) per declared maintenance task across every model.

**Deferred definition validation.** Some definitions cannot be fully checked until every model
module has been imported - `bootDb` runs these checks right after `configureDb`, before
`replayJournal`, so a bad definition fails loudly at startup instead of surfacing later as a
runtime mutation error. Today's one check: an optimistic `method: 'destroy'` on a model with a
`hasMany` `dependent: 'destroy'` relation throws `<modelId>: optimistic destroy is not supported on
models with dependent cascades - rollback cannot restore cascaded children`, since such a cascade
cannot be rolled back if the network call fails. The same guard also fires at the mutation's actual
`run()` call time regardless of whether `bootDb` ran - the boot-time copy exists purely to fail at
startup instead of on first use.

`suspendDb()` runs `flushPersistence()` (write pending checkpoint snapshots now) then
`collectGarbage()` (reclaim rows that became unreachable since the last sweep). Safe to call
repeatedly, and safe to call before `configureDb` has run - it only flushes and reclaims, it never
clears state; a full wipe still goes through `resetRuntime`'s kill-switch.

## Composable primitives

`bootDb`/`suspendDb` cover the common startup/teardown sequence; call these directly only for a
different sequencing need.

| Function | Signature | Description |
| --- | --- | --- |
| `replayJournal` | `() => number` | Idempotently re-applies journal records not yet covered by each model's persisted applied-epoch marker. Call ONCE at startup, after `configureDb` and after every model module has been imported. Returns the replayed record count. |
| `collectGarbage` | `() => GcReport` | Reachability sweep over every registered model. Roots: scope members, `gc: 'exempt'` model rows, pending optimistic operations, and every mounted reader (`use.row` roots that row, a model-wide reader roots the whole model, a scope reader roots its members). Edges: `belongsTo`/`references` of live rows. Unreached rows are evicted (no tombstones - a later write resurrects them cleanly, see [models.md](./models.md#writes)), dead scope entries detached, empty scope keys removed, opt-in idle scopes dropped (`maintenance.dropIdleScopesAfterMs`, see [models.md](./models.md#maintenance)), then persistence flushes. Safe to call during in-session UI rendering - a sweep never evicts a row any mounted reader is currently reading. Returns `{ evicted, scopesRemoved }`, both keyed by model id. |
| `purgeForeignStorageKeys` | `() => number` | Removes storage keys outside the library's `dbl:` namespace - startup housekeeping that clears pre-migration leftovers from the dedicated storage instance. Idempotent. Returns the removed key count. |
| `flushPersistence` | `() => void` | Forces a checkpoint flush now - pending model snapshots hit storage in one batch. |

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

## Storage seam

```ts
import type { StoragePlane } from '@noma4i/react-native-dblayer';
import { mmkvStoragePlane } from '@noma4i/react-native-dblayer';

const storage: StoragePlane = mmkvStoragePlane(); // default; pass a custom StoragePlane to configureDb to replace it
```

`StoragePlane` is the atomic-enough synchronous seam every state plane persists through:

| Member | Signature | Description |
| --- | --- | --- |
| `get` | `(key: string) => string \| undefined` | Read one key; `undefined` when missing. |
| `set` | `(entries: Array<{ key, value: string \| null }>) => void` | Apply entries in order; a `null` value removes the key, any other value writes it. |
| `keys` | `(prefix: string) => string[]` | List every stored key starting with `prefix`. |

`mmkvStoragePlane()` builds a `StoragePlane` backed by the configured MMKV storage adapter,
resolved lazily on every call so it always reads whichever adapter is configured at call time. The
underlying MMKV instance id predates v6 and is frozen: it is never renamed, since doing so would
orphan every row already persisted on a user's device.

## Transport seam

```ts
import { getDbTransport, setDbTransport } from '@noma4i/react-native-dblayer';

setDbTransport(nextTransport); // swap after initial configuration, e.g. re-authenticating
getDbTransport(); // the transport passed to configureDb/setDbTransport; throws if none configured
```

The library never talks to the network itself - every query, mutation, and subscription call goes
through the configured `DbTransport`. `setDbTransport`/`getDbTransport` are normally unnecessary:
`configureDb({ transport })` sets it once. Call `setDbTransport` directly only to swap the
transport after initial configuration.

### `DbTransport`

| Member | Signature | Description |
| --- | --- | --- |
| `query` | `(op) => Promise<{ data }>` | Execute a GraphQL query. |
| `mutation` | `(op) => Promise<{ data }>` | Execute a GraphQL mutation. |
| `subscribe` | `(options, handlers) => () => void` | Optional. Subscribe to a GraphQL document, pushing response `data` to `handlers.next`/`handlers.error`. Required only to activate `createDbSubscriptionRuntime`. Returns an unsubscribe callback. Transport-level reconnect and observer resubscription are transparent to callers of this seam. |

`op` carries `query`/`mutation` (the document) and `variables`, plus any client-specific extras
(`fetchPolicy`, `context`, ...) your adapter reads off it - `DbQueryOperation`/`DbMutationOperation`
are `& Record<string, unknown>`.

## Subscription runtime

```ts
import { createDbSubscriptionRuntime } from '@noma4i/react-native-dblayer';

const messageIngest = MessageModel.ingest({
  messageCreated: { handler: payload => ({ upsert: payload.message, operationId: payload.clientOperationId }) },
  messageDeleted: { handler: payload => ({ destroy: payload.id, invalidate: true }) }
});

const subscriptions = createDbSubscriptionRuntime(messageIngest.entries);

subscriptions.setActive(true);  // requires transport.subscribe
// subscriptions.stop();        // final teardown
```

Subscription handling splits into two layers: **declaration** (what an event does to a model -
`Model.ingest`, documented in [models.md](./models.md#modelingestentries)) and **runtime** (how
declared entries subscribe to the transport and dispatch payloads - documented here).

### `createDbSubscriptionRuntime(entries)`

Runs a plain subscription runtime over the configured `DbTransport`. Takes a `Model.ingest(...)`
call's `entries`, or a hand-built list of `defineDbSubscriptionEntry` entries. Returns a
controller: `setActive(active)` subscribes/unsubscribes every entry (first activation requires
`transport.subscribe`); `isActive()` reads the runtime-wide flag; `dispatch(key, payload)` manually
injects a payload into the same validate/debounce/handler pipeline transport events use (handy for
tests, and equivalent to calling `Model.ingest(...).apply(key, payload)` directly); `inspect()`
returns per-entry counters (`active`, `eventCount`, `lastEventAt`, `errorCount`); `stop()` is final
teardown for subscriptions and pending timers. A failed entry retries with exponential backoff (1s
up to 30s) while active.

### `defineDbSubscriptionEntry(entry)`

Defines one subscription entry whose key, variables, payload handler, and debounce key resolver are
inferred from a typed GraphQL document. `debounce?: { ms, keyOf? }` trailing-debounces `onData`;
omit `keyOf` to use one global bucket for the entry. Most apps never call this directly - it is the
primitive `Model.ingest`'s fused declarative form compiles down to.

### `createDbSubscriptionEffects(noopEffects)`

Creates an injectable effects channel for subscription entries that need to call into UI code
without importing it: entries call `channel.effects.onX(...)`, and the app injects real
implementations with `channel.configure(overrides)` when its effect owner mounts, calling
`channel.reset()` on teardown. The returned `effects` table and every wrapper keep one identity for
the channel's lifetime, so entries built once at module scope never need to rebind. `Model.ingest`'s
fused form's `effect: { name, when }` field wires into this channel.

## Persistence model

Every write compiles into a plan that persists as write-ahead log (WAL) plus checkpoints: the plan
writes exactly one pending journal record first, then - off the hot path, batched by the checkpoint
scheduler - the affected model snapshots plus a record marking the journal entry committed. A torn
write (the app killed mid-flush) always leaves a replayable pending record rather than a corrupted
snapshot, since the two storage batches are never interleaved with a partial snapshot in between.

At boot, deferred definition validation runs first (see [bootDb](#bootdboptions--suspenddb) above),
then `replayJournal()` re-applies every pending record left over from the last session (the
recovery half of WAL), then `bootDb`'s `collectGarbage()` reclaims anything that replay left
unreachable, `purgeForeignStorageKeys()` clears any non-`dbl:` keys, and declared model maintenance
runs last - together, the boot compaction pass that brings persisted state back to exactly what a
live session would have produced.

## React Query passthrough

DBLay owns the `@tanstack/react-query` version so a host app never needs its own dependency on it.

```ts
import { QueryClient, QueryClientProvider, focusManager, useQuery, useQueryClient } from '@noma4i/react-native-dblayer';

const queryClient = new QueryClient();
```

| Export | Re-exports | Notes |
| --- | --- | --- |
| `QueryClient` | `@tanstack/react-query`'s `QueryClient` | Pass an instance to `configureDb({ queryClient })`. |
| `QueryClientProvider` | `@tanstack/react-query`'s `QueryClientProvider` | Wrap the app so `Model.query`/`defineFetch` hooks can read the client from context. |
| `focusManager` | `@tanstack/react-query`'s `focusManager` | Wire app foreground/background events to TanStack Query's refetch-on-focus behavior. |
| `useQuery` | `@tanstack/react-query`'s `useQuery` | Available for direct use alongside `Model.query`/`defineFetch`. |
| `useQueryClient` | `@tanstack/react-query`'s `useQueryClient` | Reads the client from `QueryClientProvider` context. |

The query DSL still hides the Query cache from model storage: `Model.query` stores only page
metadata (cursor, count) in the Query cache, while rows live in the model's own planes -
`configureDb({ queryClient })` is used by imperative APIs (`getDbQueryClient()`, `invalidate`);
hooks keep reading the client from `QueryClientProvider` context regardless.

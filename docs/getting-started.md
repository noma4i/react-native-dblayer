# Getting started

How to wire the library into an app: register models, configure the runtime seams, boot, and tear
down.

## Contents

- [Boot sequence](#boot-sequence)
- [`configureDb(options)`](#configuredboptions)
- [`DbDefaults`](#dbdefaults)
- [`onSyncError` policy](#onsyncerror-policy)
- [`DbProvider`](#dbprovider)
- [`bootDb(options)` / `suspendDb()`](#bootdboptions--suspenddb)
- [Storage seam](#storage-seam)
- [Transport seam](#transport-seam)
- [Runtime prerequisites](#runtime-prerequisites)

## Boot sequence

Three steps, in this order, once per app process:

1. **Register every model module.** Import each `defineModel(...)` call site so it registers its
   apply target before anything reads or replays journal data - typically one `./models/index.ts`
   barrel that re-exports every model file, imported at the app's entry point.
2. **Call `configureDb(options)`** once, synchronously, before rendering `DbProvider` - it wires the
   transport/storage seams and package-wide defaults that `bootDb` and every model read need.
3. **Render `<DbProvider bootOptions={{ wipe }}>`** around the app subtree. On mount it runs
   `bootDb(bootOptions)` itself (journal replay, garbage collection, foreign-key cleanup, declared
   model maintenance), gates `children` until that completes, and wires app-foreground/background
   events to query refetch-on-focus and `suspendDb()`.

```ts
// models/index.ts
export * from './MessageModel';
export * from './ChatModel';
export * from './UserModel';
```

```ts
// App entry point, before the first render
import './models';
import { configureDb } from '@noma4i/react-native-dblayer';

configureDb({
  transport: {
    query: op => apolloClient.query({ query: op.query, variables: op.variables, fetchPolicy: 'no-cache' }).then(r => ({ data: r.data })),
    mutation: op => apolloClient.mutate({ mutation: op.mutation, variables: op.variables }).then(r => ({ data: r.data }))
  },
  defaults: { staleTime: 30_000, pageSize: 20, onSyncError: (error, ctx) => reportSyncError(error, ctx) }
  // storage defaults to mmkvStoragePlane(), logger to no-op.
});
```

```tsx
// Root component
import { DbProvider } from '@noma4i/react-native-dblayer';

export const Root = () => (
  <DbProvider bootOptions={{ wipe: shouldWipeForSchemaBump }}>
    <App />
  </DbProvider>
);
```

`configureDb` and `bootDb` stay individually exported as composable primitives for apps with a
different startup sequencing need - `configureDb` then `<DbProvider>` is the recommended path for
the common case, and covers the full sequence above without a manual `bootDb` call.

## `configureDb(options)`

One call that wires every injected seam (transport, storage, logger) and the package-wide
defaults. Calling it again advances the runtime generation, discards cached apply/operation
runtimes, clears the internally-owned `QueryClient`, and re-applies the transport/logger.

| Option      | Type           | Default              | Description                                                                                       |
| ----------- | -------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `transport` | `DbTransport`  | **required**          | GraphQL transport (`query`/`mutation`/optional `subscribe`) used by `Model.query`/`Model.mutation`/subscription runtimes. See [Transport seam](#transport-seam) below. |
| `storage`   | `StoragePlane` | `mmkvStoragePlane()`  | Synchronous key/value seam for persistence. See [Storage seam](#storage-seam) below.               |
| `logger`    | `DbLogger`     | no-op                 | Package logger seam: `{ debug, error }`.                                                           |
| `defaults`  | `DbDefaults`   | `{}`                  | Package-wide freshness/pagination/retry/error-observation defaults. See `DbDefaults` below.        |

`configureDb` owns a `@tanstack/react-query` `QueryClient` internally - it is never passed in and
never re-exported. `DbProvider` reads it through an internal accessor and wraps the app in the
matching `QueryClientProvider`; `Model.query`/`defineFetch` hooks read it from that context.

## `DbDefaults`

| Field                                                           | Type                                                    | Description                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `staleTime`                                                     | `number` (ms)                                            | Package-wide default `staleTime` for `Model.query`/`defineFetch` results that omit their own.                                          |
| `emptyStaleTime`                                                | `number` (ms)                                            | Package-wide default `emptyStaleTime` for `Model.query` results that omit their own.                                                   |
| `gcTime`                                                        | `number` (ms)                                            | Package-wide default TanStack Query cache `gcTime` for results that omit their own.                                                    |
| `pageSize`                                                      | `number`                                                  | Package-wide default window size for `ScopeHandle.useWindow`/`Model.view`'s `useWindow` when its own `pageSize` is omitted.            |
| `retry`                                                         | `{ query?: DbRetryPolicy; mutation?: DbRetryPolicy }`     | Retry policies for internally-owned query and mutation work. A policy with no `classify` disables retries for that half.                |
| `networkMode`                                                   | `'offlineFirst' \| 'online'`                             | TanStack Query network mode for internally-owned query and mutation work. Defaults to `'offlineFirst'`.                                |
| `refetchOnReconnect`                                            | `boolean`                                                 | Whether queries refetch after network reconnection. Defaults to `true`.                                                                 |
| `refetchOnMount`                                                | `boolean`                                                 | Whether stale queries refetch when their consumer mounts. Defaults to `true`.                                                           |
| `resumeStaleTime`                                               | `number \| null` (ms)                                     | On foreground resume, invalidates db queries older than this window. Active hooks refetch immediately; inactive entries refetch on mount. Defaults to `60000`; `null` disables it. |
| `persistence.checkpointDelayMs` / `persistence.maxPendingPlans` | `number`                                                  | Checkpoint flush tuning: how long snapshots wait, and how many pending plans accumulate, before a batched flush leaves the hot path.    |
| `inSessionGc`                                                   | `false \| { threshold?: number; debounceMs?: number }`    | ON by default (`threshold: 500`, `debounceMs: 1000`). See [runtime.md](./runtime.md#in-session-gc-trigger). `false` disables it entirely. |
| `onSyncError`                                                   | `(error: Error, ctx) => void`                             | Observes contained pipeline failures without changing their control flow. See the policy table below.                                  |

`DbRetryPolicy`: `{ classify?: (error) => 'network' | 'server' | 'retriable' | 'fatal', budgets?: Partial<Record<'network' | 'server' | 'retriable', number>>, backoff?: { baseMs, maxMs } }`
(defaults `baseMs: 1000`, `maxMs: 30000`, exponential in between). Omitting `classify` disables
retries entirely for that half; a `'fatal'` classification never retries regardless of budget.

Query and fetch `loadingState` exposes `isRetrying`, `retryAttempt`, and `isOffline`, so a screen
can render retry or offline state and call `refetch()` for a manual retry. See
[queries.md](./queries.md#loading-state) for the full state contract.

## `onSyncError` policy

`onSyncError` is called for a caught failure in exactly one of three independent pipelines. It
never changes whether the failure also surfaces through its normal channel (a query's `error`
field, a mutation's thrown rejection, or a dropped ingest event) - it is a side observation, not
an error handler.

| `ctx.source` | Raised by                                                                    | Also surfaces as                                                                                     |
| ------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `'query'`    | A `Model.query`/`defineFetch` transport failure.                              | The status surface's `error` field / `FetchResult.error` (see [queries.md](./queries.md#error-surfacing)). |
| `'mutation'` | A `Model.mutation`/`defineCommand` run that threw, after rollback completed.  | The rejected `run(input)`/`mutateAsync(input)` promise (see [mutations.md](./mutations.md#error-policy)). |
| `'ingest'`   | A `Model.ingest` handler or its resulting plan apply that threw.              | Nothing else - the event is dropped.                                                                     |

`ctx` also carries `model`/`scope`/`key`/`event` where applicable, identifying which model or
document raised the failure. A throw inside `onSyncError` itself is caught and logged through the
configured `DbLogger`, never re-thrown into the pipeline that reported it.

## `DbProvider`

```tsx
import { DbProvider } from '@noma4i/react-native-dblayer';

<DbProvider bootOptions={{ wipe: false }}>
  <App />
</DbProvider>;
```

The library-owned React provider: renders the internal `QueryClientProvider` unconditionally, and
renders `children` only once boot completes. On mount it calls `bootDb(bootOptions)` exactly once
(a re-render never re-triggers it) and gates `children` behind the resulting promise - render
nothing (or a splash screen conditioned on the same signal your app already uses) above it while
booting. It also wires `react-native`'s `AppState`: foreground sets TanStack Query's `focusManager`
active (enabling refetch-on-focus), and background sets it inactive and calls `suspendDb()`.

`bootOptions` is `BootDbOptions` (`{ wipe? }`) - see [`bootDb`](#bootdboptions--suspenddb) below.
`configureDb` must already have run before `DbProvider` mounts; `DbProvider` does not call it.

## `bootDb(options)` / `suspendDb()`

The recommended data-lifecycle pair, run for you by `DbProvider` and available standalone for a
custom boot sequence.

```ts
import { bootDb, suspendDb } from '@noma4i/react-native-dblayer';

async function start() {
  const { replayed, gc, maintenance } = await bootDb({ wipe: false });
  console.log(`replayed ${replayed} journal records, evicted`, gc.evicted);
  console.log('ran maintenance', maintenance);
}

// On app background / before logout teardown:
suspendDb();
```

`bootDb(options)` assumes `configureDb` already ran, and runs, in order: deferred definition
validation (see below), optionally `resetRuntime()` when `wipe: true`, journal replay (recovers
WAL-only writes from a crash), a `collectGarbage()` sweep (reclaims rows left unreachable by that
replay), foreign storage key cleanup, then every declared `ModelConfig.maintenance` task (see
[runtime.md](./runtime.md#maintenance)). Every model module MUST be imported before calling it -
replay throws on a journal record whose model has no registered apply target, and `bootDb` does not
catch or swallow any step's error; a silent partial boot is worse than a startup crash. Returns
`{ replayed, gc, maintenance }`: the replayed journal record count, the `collectGarbage` report for
the post-replay sweep (see [runtime.md](./runtime.md#garbage-collection)), and one
`MaintenanceReport` (`{ model, task: 'maxRowsPerScope', affected }`) per declared maintenance task
across every model.

Pass `wipe: true` to discard all persisted and in-memory library state before replay - the
`resetRuntime` kill-switch (see [runtime.md](./runtime.md#resetruntime-kill-switch)) runs after
deferred validation but before journal replay, so boot starts from an empty store. Use it for
consumer-side schema/cache-version bumps where stale persisted rows must not be rehydrated.

**Deferred definition validation.** Some definitions cannot be fully checked until every model
module has been imported - `bootDb` runs these checks first, so a bad definition fails loudly at
startup instead of surfacing later as a runtime mutation error. Today's one check: an optimistic
`method: 'destroy'` on a model with a `hasMany` `dependent: 'destroy'` relation throws
`<modelId>: optimistic destroy is not supported on models with dependent cascades - rollback cannot
restore cascaded children`, since such a cascade cannot be rolled back if the network call fails.
The same guard also fires at the mutation's actual `run()` call time regardless of whether `bootDb`
ran - the boot-time copy exists purely to fail at startup instead of on first use.

`suspendDb()` flushes pending checkpoint snapshots then runs a `collectGarbage()` sweep (skipped if
`configureDb` never ran). Safe to call repeatedly; it never clears state - a full wipe still goes
through `resetRuntime`'s kill-switch.

## Storage seam

```ts
import type { StoragePlane } from '@noma4i/react-native-dblayer';
import { mmkvStoragePlane } from '@noma4i/react-native-dblayer';

const storage: StoragePlane = mmkvStoragePlane(); // default; pass a custom StoragePlane to configureDb to replace it
```

`StoragePlane` is the atomic-enough synchronous seam every state plane persists through:

| Member | Signature                                                  | Description                                                                        |
| ------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `get`  | `(key: string) => string \| undefined`                       | Read one key; `undefined` when missing.                                             |
| `set`  | `(entries: Array<{ key, value: string \| null }>) => void`   | Apply entries in order; a `null` value removes the key, any other value writes it.  |
| `keys` | `(prefix: string) => string[]`                                | List every stored key starting with `prefix`.                                       |

`mmkvStoragePlane()` builds a `StoragePlane` backed by the configured MMKV storage adapter,
resolved lazily on every call so it always reads whichever adapter is configured at call time.

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

| Member      | Signature                             | Description                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`     | `(op) => Promise<{ data }>`              | Execute a GraphQL query.                                                                                                                                                                                                                              |
| `mutation`  | `(op) => Promise<{ data }>`              | Execute a GraphQL mutation.                                                                                                                                                                                                                            |
| `subscribe` | `(options, handlers) => () => void`      | Optional. Subscribe to a GraphQL document, pushing response `data` to `handlers.next`/`handlers.error`. Required only to activate `createDbSubscriptionRuntime` (see [ingest-live.md](./ingest-live.md)). Returns an unsubscribe callback.            |

`op` carries `query`/`mutation` (the document) and `variables`, plus any client-specific extras
(`fetchPolicy`, `context`, ...) your adapter reads off it - `DbQueryOperation`/`DbMutationOperation`
are `& Record<string, unknown>`.

## Runtime prerequisites

`react-native-mmkv` (`>=4.0.0`) is a peer dependency, required whenever the default storage plane
is used - pass a custom `StoragePlane` to `configureDb` to avoid it entirely. `react`, `react-native`,
`graphql`, and `@graphql-typed-document-node/core` are the remaining peer dependencies.

React Native/Hermes consumers MUST install `react-native-get-random-values` (for example, with
`yarn add react-native-get-random-values`) and import it before the library boots, as the first
import in the app entry. This is a transitive `@tanstack/db` runtime requirement verified on-device:
without the polyfill Hermes throws `No secure random number generator available`. If the React
Native version does not provide `crypto.randomUUID`, add the `crypto.getRandomValues`-based shim
from the canonical [`example/index.js`](../example/index.js) entry implementation.

```js
import 'react-native-get-random-values';
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  // Copy the getRandomValues-based shim body from example/index.js.
}
```

# Getting started

Import every model, configure the runtime once, then mount `DbProvider`.

```ts
import './db/models';
import { configureDb } from '@noma4i/react-native-dblayer';

configureDb({ transport });
```

```tsx
import { DbProvider } from '@noma4i/react-native-dblayer';

export const Root = () => (
  <DbProvider>
    <App />
  </DbProvider>
);
```

## `configureDb(options)`

| Option | Purpose |
| --- | --- |
| `transport` | Provides GraphQL query, mutation, and optional subscription execution. |
| `storage` | Replaces the built-in MMKV persistence plane. |
| `logger` | Receives contained debug and error events. |
| `defaults` | Sets package-wide freshness, pagination, retry, persistence, and error defaults. |
| `dataVersion` | Resets incompatible persisted package data when changed. |

Calling `configureDb` again advances the runtime generation, clears stale runtime handles, and
installs the new seams.

## `DbDefaults`

| Field | Purpose |
| --- | --- |
| `staleTime` | Sets default filled-result freshness. |
| `freshnessClasses` | Maps named freshness classes to milliseconds. |
| `emptyStaleTime` | Sets default empty-result freshness. |
| `pageSize` | Sets the default relation window size. |
| `retry` | Configures query and mutation retry policies. |
| `refetchOnMount` | Controls stale refetch on mount. |
| `resumeStaleTime` | Controls foreground invalidation age. |
| `resumeRefetch` | Bounds sequential foreground refetch chunks. |
| `persistence` | Configures checkpoint delay and pending-plan pressure. |
| `inSessionGc` | Configures or disables in-session garbage collection. |
| `onSyncError` | Observes contained query, mutation, and ingest failures. |

`DbRetryPolicy` uses `DbRetryClass` classification, retry budgets, and bounded exponential
backoff. Omitting classification disables automatic retry.

## `DbProvider`

`DbProviderProps` contains `children`. The provider owns the internal TanStack Query client, runs
boot recovery before rendering children, attaches foreground refresh, and flushes persistence and
cleanup work on background.

All model modules must be imported before mount. Boot validates declarations, applies the
`dataVersion` compatibility gate, replays the write-ahead journal, removes unreachable rows,
cleans foreign storage keys, and runs model maintenance.

## Storage seam

`StoragePlane` defines synchronous `get`, ordered `set`, and prefix `keys`. The built-in
implementation uses `react-native-mmkv`; callers can provide another implementation.

## Transport seam

`DbTransport` defines `query`, `mutation`, and optional `subscribe`. Each request returns typed
`data`; subscription setup returns an unsubscribe callback. `DbTransportError` carries retry
classification metadata without coupling the package to one GraphQL client.

Every GraphQL operation flows through this seam. The library never creates a network client.

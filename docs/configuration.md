# Configuration

Configure the library once, at app start, before any query or mutation runs.

## `configureDb(options)`

One call that wires every seam. Returns `void`. Call it once at app start, before any query or mutation runs.

```ts
import { configureDb } from '@noma4i/react-native-dblayer';
import { apolloClient } from './apollo';
import { queryClient } from './queryClient';

configureDb({
  transport: {
    query: (op) => apolloClient.query({ query: op.query, variables: op.variables, fetchPolicy: 'no-cache' }).then((r) => ({ data: r.data })),
    mutation: (op) => apolloClient.mutate({ mutation: op.mutation, variables: op.variables }).then((r) => ({ data: r.data })),
  },
  queryClient,
  // storage defaults to MMKV, logger to no-op, extract to no-op — all optional.
});
```

### `ConfigureDbOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `transport` | `DbTransport` | **required** — throws if never set | Your GraphQL client executor. See below. |
| `storage` | `StorageAdapter` | MMKV-backed adapter | Where collections persist. Omit to use the built-in MMKV adapter. |
| `logger` | `DbLogger` | no-op | Receives `debug`/`error` from the request/mutation runtimes. |
| `queryClient` | `QueryClient` | `null` | Used by imperative request helpers only. Hooks still read React context. |
| `extract.sink` | `DbExtractSink` | no-op | Applies a resolved extract payload into your collections (side-loads). |
| `extract.mutationResolver` | `DbMutationExtractResolver` | no-op | Turns a mutation's `extract` spec + server result into an extract payload for the sink. |

Each seam also has a standalone setter if you prefer granular control: `setDbTransport`, `setDbStorageAdapter`,
`setDbLogger`, `setDbExtractSink`, `setDbMutationExtractResolver`. `configureDb` just calls these.

## QueryClient seam

```ts
import {
  deriveDbKey,
  getDbQueryClient,
  invalidateDbRequests,
  refetchDbRequests,
  resetDbQueryRuntime,
} from '@noma4i/react-native-dblayer';

getDbQueryClient();                                      // QueryClient | null
await invalidateDbRequests(deriveDbKey(UserModel));      // prefix invalidation
await refetchDbRequests(deriveDbKey(UserModel, { id })); // awaitable refetch
await resetDbQueryRuntime();                             // cancelQueries(), then clear()
```

The configured client is only for imperative APIs. Query hooks keep using `useQueryClient()` from
`QueryClientProvider`.

## `DbTransport` — the GraphQL executor

The library never talks to the network itself; it calls your transport. There is **no default** — calling a query
or mutation before `transport` is configured throws.

```ts
type DbTransport = {
  query:    <TData, TVars>(op: DbQueryOperation<TData, TVars>)    => Promise<{ data: TData }>;
  mutation: <TData, TVars>(op: DbMutationOperation<TData, TVars>) => Promise<{ data: TData }>;
};
```

### `DbQueryOperation` / `DbMutationOperation`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `query` / `mutation` | `TypedDocumentNode<TData, TVars> \| DocumentNode` | **required** | The GraphQL document. |
| `variables` | `TVars` | `undefined` | Operation variables. |
| *(extra keys)* | `unknown` | — | The operation is `& Record<string, unknown>`, so you may pass client-specific extras (e.g. `fetchPolicy`, `context`) through and read them in your adapter. |

Your adapter must resolve to `{ data }`. Examples for common clients:

```ts
// Apollo
{ query: (op) => apollo.query({ query: op.query, variables: op.variables }).then((r) => ({ data: r.data })),
  mutation: (op) => apollo.mutate({ mutation: op.mutation, variables: op.variables }).then((r) => ({ data: r.data })) }

// urql
{ query: (op) => urql.query(op.query, op.variables).toPromise().then((r) => ({ data: r.data })),
  mutation: (op) => urql.mutation(op.mutation, op.variables).toPromise().then((r) => ({ data: r.data })) }

// graphql-request
{ query: (op) => gql.request(op.query, op.variables).then((data) => ({ data })),
  mutation: (op) => gql.request(op.mutation, op.variables).then((data) => ({ data })) }
```

## `StorageAdapter`

The persistence backend. The default is an MMKV write-back adapter (debounced disk writes, flush on background,
reads observe pending writes). Provide your own to target a different store.

| Member | Type | Description |
| --- | --- | --- |
| `getItem` | `(key: string) => string \| null` | Read a value. Must reflect pending writes. |
| `setItem` | `(key: string, value: string) => void` | Write a value. |
| `removeItem` | `(key: string) => void` | Delete a value. |
| `getAllKeys` | `() => string[]` | Enumerate keys (used by freshness pruning). |
| `clear` | `() => void` | Wipe all keys. |
| `eventApi` | `StorageEventApi` | Cross-context change events. A no-op `{ addEventListener, removeEventListener }` is fine on RN. |

The adapter must be **synchronous** (`getItem` returns a `string`, not a promise) — MMKV is. A minimal in-memory
adapter (also handy in tests):

```ts
import type { StorageAdapter } from '@noma4i/react-native-dblayer';

const map = new Map<string, string>();
const memoryStorage: StorageAdapter = {
  getItem: (k) => map.get(k) ?? null,
  setItem: (k, v) => { map.set(k, v); },
  removeItem: (k) => { map.delete(k); },
  getAllKeys: () => [...map.keys()],
  clear: () => map.clear(),
  eventApi: { addEventListener() {}, removeEventListener() {} },
};

configureDb({ transport, storage: memoryStorage });
```

## `DbLogger`

| Member | Type | Description |
| --- | --- | --- |
| `debug` | `(...args: unknown[]) => void` | Verbose lifecycle logs (e.g. `mutationFn start`). |
| `error` | `(...args: unknown[]) => void` | Errors from the request/mutation runtimes. |

Default is a no-op — nothing is logged until you inject a logger.

## Extract seam

Optional. Lets a query or mutation side-load related entities into other collections. It is two injected
functions so the library stays domain-agnostic:

| Function | Type | Role |
| --- | --- | --- |
| `DbExtractSink` | `(extractResult: unknown, source: string) => void` | Applies a resolved payload to collections. `source` is `'query'` or `'mutation'`. |
| `DbMutationExtractResolver` | `(extractSpec: unknown, result: unknown) => unknown` | Resolves a mutation's `extract` spec + server result into a payload for the sink. |

- A **query** config's `extract(({ data, selected }))` returns a payload directly; the runtime passes it to the
  sink with source `'query'`.
- A **mutation** config's `extract` is a spec; the runtime calls `mutationResolver(spec, result)` then the sink
  with source `'mutation'`.

Both default to no-ops, so a config's `extract` field simply does nothing until you wire these. Example — a query
that side-loads its author into `UserModel`, and mutations whose `extract` presets are resolved by your app:

```ts
import { configureDb, mergeSyncContract } from '@noma4i/react-native-dblayer';

configureDb({
  transport,
  extract: {
    // apply any resolved payload into collections
    sink: (payload, source) => {
      const p = payload as { users?: UserInput[] };
      if (p?.users?.length) UserModel.applyServerData(p.users, mergeSyncContract(source));
    },
    // turn a mutation's `extract` spec + server result into a payload for the sink
    mutationResolver: (spec, result) => resolveMutationExtract(spec, result), // your app's resolver
  },
});

// a query config then side-loads directly:
useDbSingleRequest({
  key: ['post', id], query: POST_QUERY, vars: { id }, select: (d) => d.post,
  sync: { model: PostModel, contract: 'post' },
  extract: ({ selected }) => ({ users: [selected.author] }), // -> sink -> UserModel
  read: { model: PostModel, id },
});
```

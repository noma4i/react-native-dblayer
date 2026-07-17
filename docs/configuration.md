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
| `extract.sink` | `DbExtractSink` | no-op | Applies a resolved extract payload into your collections (side-loads). Use `createExtractSink(...)` for declarative model/custom routing. |
| `extract.mutationResolver` | `DbMutationExtractResolver` | no-op | Turns a mutation's `extract` spec + server result into an extract payload for the sink. Use `createMutationExtractResolver(...)` for declarative presets. |

`configureDb` is the public seam owner. It wires those seams, then prunes stale fetch-state metadata using the
package freshness policy.

## `bootDb(options)` / `suspendDb()`

The recommended app-lifecycle pair. `bootDb` wraps `configureDb` with the startup sequence a real app needs;
`suspendDb` wraps the matching background/teardown sequence. `configureDb`, `replayJournal`, `collectGarbage`,
and `purgeForeignStorageKeys` all stay exported individually as composable primitives for apps with different
sequencing needs — `bootDb`/`suspendDb` are the recommended path for the common case.

```ts
import { bootDb, suspendDb } from '@noma4i/react-native-dblayer';
import './models'; // import every model module FIRST so its apply target is registered

async function start() {
  const { replayed, gc } = await bootDb({ transport, queryClient });
  console.log(`replayed ${replayed} journal records, evicted`, gc.evicted);
}

// On app background / before logout teardown:
suspendDb();
```

`bootDb(options)` takes the exact same options as `configureDb`, and runs, in order: `configureDb(options)`,
`replayJournal()` (recovers WAL-only writes from a crash), `collectGarbage()` (reclaims rows left unreachable
by that replay), `purgeForeignStorageKeys()` (clears pre-migration/foreign storage keys). Every model module
MUST be imported before calling it — `replayJournal` throws on a journal record whose model has no registered
apply target, and `bootDb` does not catch or swallow any step's error; a silent partial boot is worse than a
startup crash. Returns `{ replayed, gc }`: the replayed journal record count, and the `collectGarbage` report
for the post-replay sweep.

`suspendDb()` runs `flushPersistence()` (write pending checkpoint snapshots now) then `collectGarbage()`
(reclaim rows that became unreachable since the last sweep). Safe to call repeatedly, and safe to call before
`configureDb` has run. It only flushes and reclaims — it never clears state; a full wipe still goes through
`resetRuntime`'s kill-switch.

## QueryClient seam

```ts
import {
  invalidateDbRequests,
  resetDbQueryRuntime,
} from '@noma4i/react-native-dblayer';

UserModel.invalidate();                          // clear model freshness + invalidate model queries
UserModel.invalidate({ id });                    // scoped model invalidation
await invalidateDbRequests(['custom', 'key']);   // React Query invalidation for explicit keys
await resetDbQueryRuntime();                     // cancelQueries(), then clear()
```

The free `invalidateModel(model, scope?)` helper remains available for infrastructure that receives models as values;
application code should prefer the model-owned `Model.invalidate(scope?)` form.

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
- `extractSource` on a query, mutation, or command config overrides the source label passed to the sink while keeping
  the same resolver/sink mechanics.

Both default to no-ops, so a config's `extract` field simply does nothing until you wire these. The package includes
two factories for the common declarative shape:

| Helper | Input | Output |
| --- | --- | --- |
| `createMutationExtractResolver(presetTable)` | `{ presetKey: { read, sink, many? } }` | Existing `DbMutationExtractResolver` seam. |
| `createExtractSink(sinkTable)` | `{ extractKey: Model \| (payloads, source) => void }` | Existing `DbExtractSink` seam. |
| `liftExtractNodes(value)` | `unknown \| unknown[] \| null \| undefined` | Public helper used by the sink to drop nullish values and return an array. |

`createMutationExtractResolver` walks the preset table in declaration order. The `result` argument is the mutation
`resultField` payload, not the full GraphQL response envelope. A mutation `extract` spec can use `true` to call the
table's default `read(result)`, a string shorthand such as `read: 'user'`, or a selector function to override it.
Resolved nodes are lifted to arrays by default; set `many: false` for singleton payloads such as a wallet patch.
`null`, `undefined`, and empty arrays are dropped; if every preset is empty, the resolver returns `undefined`.

`createExtractSink` walks sink keys in declaration order and applies only non-empty payloads. Model entries receive
`Model.applyServerData(castNodes(payloads), mergeSyncContract(source))`; custom functions receive lifted
`(payloads, source)` arrays. Declaration order is part of the contract, so put dependency sinks first, for example
`users` before `messages`.

Example — a query that side-loads its author into `UserModel`, and mutations whose `extract` presets are resolved
by a table:

```ts
import { configureDb, createExtractSink, createMutationExtractResolver } from '@noma4i/react-native-dblayer';

const mutationResolver = createMutationExtractResolver({
  user: { sink: 'users', read: 'user' },
  message: { sink: 'messages', read: (result) => result.message },
  wallet: { sink: 'wallets', read: (result) => result.wallet, many: false },
  transaction: { sink: 'transactions', read: (result) => result.transaction },
});

const sink = createExtractSink({
  users: UserModel,
  messages: MessageModel,
  wallets: WalletModel,
  transactions: WalletTransactionModel,
});

configureDb({
  transport,
  extract: {
    sink,
    mutationResolver,
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

An app with chat side-loads can keep domain transforms inside the table readers:

```ts
const mutationResolver = createMutationExtractResolver({
  user: { sink: 'users', read: (result) => result.user },
  chatLastMessage: { sink: 'chatLastMessages', read: (result) => buildChatLastMessageSyncEntry(result.chat.id, result.chat.lastMessage) },
  wallet: { sink: 'wallets', read: (result) => result.wallet, many: false },
  transaction: { sink: 'transactions', read: (result) => result.transaction },
  message: { sink: 'messages', read: (result) => result.message },
  chat: { sink: 'chats', read: (result) => result.chat },
  moment: { sink: 'moments', read: (result) => result.moment },
});

const sink = createExtractSink({
  users: UserModel,
  chatLastMessages: syncChatLastMessages,
  wallets: WalletModel,
  transactions: WalletTransactionModel,
  messages: MessageModel,
  chats: ChatModel,
  moments: MomentModel,
});
```

Extraction is two-pass: first the query/mutation config resolves an extract payload, then the sink table applies that
payload in declaration order. The sink merges repeated payload keys before applying a key. Put dependency sinks first,
then dependent sinks. If two extract sources emit `users`, the sink receives one lifted user payload array for that key
and writes it once with `mergeSyncContract(source)`.

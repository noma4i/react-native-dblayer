# react-native-dblayer

**A local-first data layer for GraphQL apps on React Native.** You write GraphQL operations; the library runs them
through your client, normalizes the results into persistent, reactive collections, and gives your components
type-safe reactive reads and optimistic mutations. Your UI renders from local collections — never straight from the
network.

Built on [TanStack DB](https://tanstack.com/db). Your GraphQL client, storage, and logging are injected, so the
engine stays decoupled from your app.

> **Full API reference:** [`docs/`](./docs/README.md) — every option, type, default, and example.

## How it works

```
GraphQL operation ──▶ your client ──▶ normalize ──▶ persistent collection ──▶ reactive UI
   (TypedDocumentNode)   (injected)    (per model)      (MMKV-backed)         (re-renders)
```

1. You **define models** — each normalizes a GraphQL shape into a persistent collection.
2. You **run queries** with the request DSL — the response is written into a collection.
3. Your **components read** from collections with reactive hooks; they re-render when rows change (from a refetch,
   a mutation, or a subscription you feed in).
4. You **mutate** optimistically — write locally, reconcile with the server, roll back on error.

## Highlights

- **GraphQL-native & type-safe.** Operations are `TypedDocumentNode`s, so response and variable types are inferred
  from the document. Any GraphQL client works — you inject the executor.
- **Local-first & reactive.** The network is a sync source, not the source of truth. Components read from
  collections and re-render on change.
- **Optimistic mutations.** Write, reconcile, and roll back — all in one transaction.
- **Persistent.** Collections survive restarts, MMKV-backed out of the box.
- **Freshness-aware.** Per-scope stale tracking, so you fetch only when data is actually stale.

## Install

Not published to npm yet — install straight from git:

```sh
yarn add @noma4i/react-native-dblayer@git+https://github.com/noma4i/react-native-dblayer.git
```

Pin a branch or commit by appending `#<branch-or-commit>` to the URL. Peer dependencies (you already have most in an
RN app): `react`, `react-native`, `react-native-mmkv`, `@tanstack/db`, `@tanstack/react-db`,
`@tanstack/react-query`, `graphql`, `@graphql-typed-document-node/core`.

## 1. Configure

Configure once at app start. Only `transport` (your GraphQL client) is required; storage defaults to MMKV. Wrap your
app in a `@tanstack/react-query` `QueryClientProvider` — the request/mutation DSL runs on top of it.

```ts
import { configureDb } from '@noma4i/react-native-dblayer';
import { queryClient } from './queryClient';

configureDb({
  transport: {
    query: (op) => apollo.query({ query: op.query, variables: op.variables, fetchPolicy: 'no-cache' }).then((r) => ({ data: r.data })),
    mutation: (op) => apollo.mutate({ mutation: op.mutation, variables: op.variables }).then((r) => ({ data: r.data })),
  },
  queryClient, // enables imperative invalidate/refetch/reset helpers
  trackSink: (event) => analytics.track(event.name, event.payload),
  // storage?: default MMKV · logger?: default no-op · extract?: default no-op · trackSink?: default no-op
});
```

→ **Reference:** [Configuration](./docs/configuration.md) — `configureDb`, transport/storage/logger/extract/track seams,
and adapters for Apollo / urql / graphql-request.

## 2. Define a model

A model describes how raw server payloads become persistent rows. The recommended path is declarative `fields`:
the package generates the normalizer, keeps undefined fields sparse, and derives the stored/input types from the
model itself.

```ts
import { compositeId, defineModel, f, type ModelInput, type ModelStored } from '@noma4i/react-native-dblayer';

export const UserModel = defineModel({
  name: 'UserModel',
  id: 'users',
  fields: {
    uuid: f.str(),
    fullName: f.str(),
    age: f.num().nullable(),
    coverUrl: f.str().nullDefault(),
    roles: f.array(f.str()).default(() => []),
    countryName: f.custom((u) => (u as { country?: { name?: string } }).country?.name).nullable(),
  },
});

export type UserData = ModelStored<typeof UserModel>;
export type UserInput = ModelInput<typeof UserModel>;
```

Use `rowId`, `guard`, `compositeId`, and `sideload` for common model-level sync rules:

```ts
export const SimilarMomentModel = defineModel({
  name: 'SimilarMomentModel',
  id: 'similar-moments',
  rowId: compositeId('momentId', 'similarMomentId'),
  guard: (row) => (row as { hidden?: boolean }).hidden !== true,
  fields: {
    momentId: f.id(),
    similarMomentId: f.id(),
    score: f.num().nullable(),
  },
  sideload: [{ model: 'UserModel', pluck: (row) => (row as any).user }],
});
```

For irreducibly custom mappings, keep using `normalize`; shapes can still be reused with `readShape` inside that
escape hatch.

Fields models also expose `buildStored(partial)` for optimistic rows. Explicit keys win, `.default(value | () => value)`
fills factory-time defaults, nullable fields become `null`, and optional fields are omitted. `.default` does not affect
normalization; `.nullDefault()` remains the read-time missing-to-null modifier.

→ **Reference:** [Models](./docs/models.md) — `defineModel` options and the full `CollectionModel` read/write API.

## 3. Fetch data

`useDbSingleRequest` runs a query, writes the result into a model, and returns the reactive read plus loading state.

```tsx
import { useDbSingleRequest } from '@noma4i/react-native-dblayer';

function UserCard({ id }: { id: string }) {
  const { data: user, loadingState } = useDbSingleRequest({
    query: USER_QUERY,                            // TypedDocumentNode -> types inferred
    vars: { id },
    select: (d) => d.user,
    sync: { model: UserModel, contract: 'user' }, // where the response is written
    read: { model: UserModel, id },               // what the UI reads back, reactively
  });

  if (loadingState.showSkeleton) return <ActivityIndicator />;
  return <Text>{user?.name}</Text>;
}
```

Once a row is in a collection, any component reads it reactively — no refetch:

```tsx
function OnlineDot({ id }: { id: string }) {
  const user = UserModel.find(id); // re-renders when the row changes
  return user?.isOnline ? <Dot /> : null;
}

function AdminList() {
  const admins = UserModel.where(
    { role: 'admin' },
    { orderBy: { field: 'name', direction: 'asc' } }
  ); // reactive list
  return <FlatList data={admins} keyExtractor={(u) => u.id} renderItem={/* ... */} />;
}
```

Cursor-paginated connections use `useDbInfiniteRequest` (`data`, `loadMore`, `hasNextPage`, ...).

→ **Reference:** [Queries](./docs/queries.md) — `useDbSingleRequest` / `useDbInfiniteRequest` config, direct
`runDbQueryDirect` execution, `loadingState`, and return shapes.

## 4. Change data

`useDbMutation` runs the optimistic write, the GraphQL mutation, and the server write-through in **one
transaction** — any error rolls back every local change.

```tsx
import { useDbMutation } from '@noma4i/react-native-dblayer';

function useSendMessage() {
  return useDbMutation({
    key: () => ['sendMessage'],
    logPrefix: 'sendMessage',
    mutation: SEND_MESSAGE,
    resultField: 'sendMessage',
    optimistic: {
      model: MessageModel,
      tempIdPrefix: 'msg',
      buildStored: ({ input, tempId }) => MessageModel.buildStored({ id: tempId, ...input, pending: true }),
      selectServerNode: (data) => data,
    },
    track: {
      start: (input) => ({ name: 'message_send_initiated', payload: { chatId: input.chatId, hasMedia: !!input.file } }),
      success: (_data, input) => ({ name: 'message_sent', payload: { chatId: input.chatId, hasMedia: !!input.file } }),
      error: (error, input) => ({ name: 'message_send_failed', payload: { chatId: input.chatId, error: error.message } }),
    },
  });
}
```

For simple updates/deletes, declare `method: 'patch' | 'destroy'` with `selectId` (and `selectPatch`) instead of
`onMutate`. `useCommand` covers fire-and-forget commands, including the same `track` start/success/error sink.
Outside React, use `runDbMutationDirect` and `runDbCommandDirect` for the same mutation and command configs.

→ **Reference:** [Mutations](./docs/mutations.md) — `useDbMutation` variants (custom / patch / destroy), lifecycle,
`useCommand`, `runDbCommandDirect`, `runDbMutationDirect`.

## 5. Read & write directly

Every model exposes reactive hooks and synchronous snapshots:

| Reactive (hooks, re-render) | Snapshot (synchronous, anywhere) |
| --- | --- |
| `Model.find(id)` / `all()` / `where(f, opts?)` / `first(f?, opts?)` / `byIds(ids)` / `count(f?)` | `Model.get(id)` / `getAll()` / `getWhere(f)` / `getFirst(f?, opts?)` |

```ts
UserModel.applyServerData(rows, { mode: 'merge', source: 'users' }); // sync (merge | replace)
UserModel.patch(id, { name: 'New name' });
UserModel.patch(id, pickDefined(input, ['name', 'description'] as const));
UserModel.destroyWhere({ role: 'guest' });
UserModel.replaceRaw(tempId, serverRow);                              // optimistic -> server swap
```

→ **Reference:** [Models](./docs/models.md) — reads, writes, `SyncContract` (merge vs replace), and freshness.

## Freshness & storage

Every model records when each scope was last fetched (persisted across restarts), so the query DSL skips redundant
network calls — tune it with `staleTime`. Persistence is MMKV-backed by default; implement `StorageAdapter` and pass
`storage` to `configureDb` for a different backend.

→ **Reference:** freshness in [Models](./docs/models.md#collectionmodel--freshness), storage +
`StorageAdapter` in [Configuration](./docs/configuration.md#storageadapter).

## API reference

Full, parameter-by-parameter reference lives in [`docs/`](./docs/README.md):
[Configuration](./docs/configuration.md) · [Models](./docs/models.md) · [Queries](./docs/queries.md) ·
[Mutations](./docs/mutations.md) · [Runtime primitives](./docs/runtime-primitives.md).

## License

MIT © Alexander Tsirel

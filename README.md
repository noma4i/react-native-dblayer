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
  // storage?: default MMKV · logger?: default no-op · extract?: default no-op
});
```

→ **Reference:** [Configuration](./docs/configuration.md) — `configureDb`, transport/storage/logger/extract seams,
and adapters for Apollo / urql / graphql-request.

## 2. Define a model

A model normalizes a shape into a persistent collection. Domain logic stays in your queries and mutations, never in
the model.

```ts
import { defineModel } from '@noma4i/react-native-dblayer';

export const UserModel = defineModel<UserInput, User>({
  name: 'UserModel',
  id: 'users',
  normalize: (u) => ({ id: u.id, name: u.name, role: u.role, updatedAt: u.updatedAt }),
});
```

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

Cursor-paginated connections use `useDbInfiniteRequest` (`items`, `loadMore`, `hasNextPage`, …).

→ **Reference:** [Queries](./docs/queries.md) — `useDbSingleRequest` / `useDbInfiniteRequest` config, `loadingState`,
and return shapes.

## 4. Change data

`useDbMutation` runs the optimistic write, the GraphQL mutation, and the server write-through in **one
transaction** — any error rolls back every local change.

```tsx
import { useDbMutation, generateTempId } from '@noma4i/react-native-dblayer';

function useSendMessage() {
  return useDbMutation({
    key: () => ['sendMessage'],
    logPrefix: 'sendMessage',
    mutation: SEND_MESSAGE,
    resultField: 'sendMessage',
    onMutate: (input) => {
      const temp = { id: generateTempId('msg'), ...input, pending: true };
      MessageModel.insertStored(temp);          // shows instantly
      return { tempId: temp.id };
    },
    onCommit: (data, _input, ctx) => {
      if (data) MessageModel.replaceRaw(ctx.tempId, data); // swap temp -> server row
    },
  });
}
```

For simple updates/deletes, declare `method: 'patch' | 'destroy'` with `selectId` (and `selectPatch`) instead of
`onMutate`. `useCommand` covers fire-and-forget commands.

→ **Reference:** [Mutations](./docs/mutations.md) — `useDbMutation` variants (custom / patch / destroy), lifecycle,
`useCommand`, `runDbMutationDirect`.

## 5. Read & write directly

Every model exposes reactive hooks and synchronous snapshots:

| Reactive (hooks, re-render) | Snapshot (synchronous, anywhere) |
| --- | --- |
| `Model.find(id)` / `all()` / `where(f, opts?)` / `first(f?, opts?)` / `byIds(ids)` / `count(f?)` | `Model.get(id)` / `getAll()` / `getWhere(f)` / `getFirstWhere(f?, opts?)` / `getFirst(f?, opts?)` |

```ts
UserModel.applyServerData(rows, { mode: 'merge', source: 'users' }); // sync (merge | replace)
UserModel.patch(id, { name: 'New name' });
UserModel.destroyWhere({ role: 'guest' });
UserModel.replaceRaw(tempId, serverRow);                              // optimistic -> server swap
```

→ **Reference:** [Models](./docs/models.md) — reads, writes, `SyncContract` (merge vs replace), and freshness.

## 6. ActiveRecord DSL

A chainable, ergonomic layer over any model.

```tsx
import { query, useInstance } from '@noma4i/react-native-dblayer';

const count = query(UserModel).where({ role: 'admin' }).count(); // reactive hook

function UserRow({ id }: { id: string }) {
  const user = useInstance(UserModel, id);                        // Readonly<User> + update/delete
  return user ? <Button title={user.name} onPress={() => user.update({ role: 'admin' })} /> : null;
}

query(UserModel).where({ active: false }).update({ archived: true }); // bulk, anywhere
query(UserModel).where({ role: 'guest' }).delete();
```

→ **Reference:** [ActiveRecord](./docs/active-record.md) — `query` / `ModelRelation`, `instance` / `useInstance` /
`ModelInstance`.

## Freshness & storage

Every model records when each scope was last fetched (persisted across restarts), so the query DSL skips redundant
network calls — tune it with `staleTime`. Persistence is MMKV-backed by default; implement `StorageAdapter` and pass
`storage` to `configureDb` for a different backend.

→ **Reference:** freshness in [Models](./docs/models.md#collectionmodel--freshness), storage +
`StorageAdapter` in [Configuration](./docs/configuration.md#storageadapter).

## API reference

Full, parameter-by-parameter reference lives in [`docs/`](./docs/README.md):
[Configuration](./docs/configuration.md) · [Models](./docs/models.md) · [Queries](./docs/queries.md) ·
[Mutations](./docs/mutations.md) · [ActiveRecord](./docs/active-record.md).

## License

MIT © Alexander Tsirel

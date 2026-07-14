# react-native-dblayer

`@noma4i/react-native-dblayer` is a local-first GraphQL data layer for React Native.
v6 stores canonical rows in EntityState, records scope membership separately, and sends every
write through one journalled apply pipeline.

## Configure

```ts
configureDb({ transport, queryClient });
```

`transport` provides `query` and `mutation`. Storage defaults to MMKV and can be replaced with
a `StoragePlane`. Call `setAccountPartition(accountId)` after authentication and `resetRuntime()`
on logout.

## Models and scopes

```ts
const ChatModel = defineModel({
  id: 'chats',
  name: 'ChatModel',
  fields: ChatSchema.fields,
  scopes: {
    list: scope({ by: { statusFilter: 'status' }, kind: 'membership' })
  }
});
```

Models expose snapshots (`get`, `getWhere`) and reactive reads under `use` (`row`, `field`,
`first`, `where`, `byIds`, `count`). Scope handles expose `use`, `useWindow`, `useCount`, and
`read`.

## Queries and mutations

```ts
const chats = defineQuery({
  document: ChatsDocument,
  vars: scope => ({ status: scope.statusFilter }),
  page: data => data.chats,
  into: ChatModel.scopes.list,
  coverage: 'page'
});

const sendMessage = defineMutation({
  document: SendMessageDocument,
  result: 'sendMessage',
  optimistic: {
    model: MessageModel,
    build: (input, ctx) => ({ id: ctx.tempId, body: input.body }),
    selectServerNode: data => data.sendMessage
  }
});
```

`defineQuery` uses React Query for transport and cache. Its selected response is compiled into
the model or scope apply path. `defineMutation().use()` and `.run()` share optimistic application,
server commit, and rollback. Subscription payloads use `defineIngest` and produce the same model
writes.

## Guarantees

- A complete membership response detaches missing entries and never destroys canonical rows.
- Page and delta responses add or update membership without detaching existing entries.
- Explicit destroy is the only entity deletion authority.

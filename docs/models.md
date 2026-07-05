# Models

A model is a persistent, reactive collection plus a normalizer. Define one per entity.

## `defineModel(config)`

```ts
import { defineModel } from '@noma4i/react-native-dblayer';

type UserInput = { id: string; name: string; role?: string; updatedAt?: string };
type User = { id: string; name: string; role?: string; isOnline?: boolean; updatedAt?: string };

export const UserModel = defineModel<UserInput, User>({
  name: 'UserModel',
  id: 'users',
  normalize: (u) => ({ id: u.id, name: u.name, role: u.role, updatedAt: u.updatedAt }),
});
```

Returns a `CollectionModel<UserInput, User>`. `UserInput` is what you write in (often a GraphQL type); `User` is
what is stored.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | **required** | Unique model name. Runtime-registry key and log tag. |
| `id` | `string` | **required** | Collection id + storage-key prefix (e.g. `'users'`). Unique per app. |
| `normalize` | `(input: TInput) => (Partial<TStored> & { id: string }) \| null` | **required** | Map an input to a stored row. Return `null` to drop it. Must produce a `string` `id`. |
| `staleTime` | `number` (ms) | `0` | How long a fetched scope stays fresh. `0` = always stale. Drives `shouldSkipInitialFetch`. |
| `merge.dedupeWindowMs` | `number` (ms) | `0` | Skip a merge batch identical to the previous one within this window. `0` = no dedupe. |
| `merge.shouldOverwrite` | `(existing, incoming) => boolean` | `—` | Force-accept a merge the timestamp gate would reject. |
| `replace.shouldOverwrite` | `(existing, incoming) => boolean` | `—` | Same, for replace writes. |
| `defaultSort` | `{ field: keyof TStored; direction: 'asc' \| 'desc' }` | `—` (insertion order) | Sort applied by the reactive `all()`. |

The stored type must extend `{ id: string; updatedAt?: string | null }`. `updatedAt` (ISO) enables the newer-wins
gate; omit it and every incoming write is accepted.

### Examples

A model with a dedupe window and a default sort:

```ts
export const MessageModel = defineModel<MessageInput, Message>({
  name: 'MessageModel',
  id: 'messages',
  normalize: (m) => ({ id: m.id, chatId: m.chatId, body: m.body, createdAt: m.createdAt, updatedAt: m.updatedAt }),
  merge: { dedupeWindowMs: 200 },                       // ignore duplicate bursts
  defaultSort: { field: 'createdAt', direction: 'asc' }, // all() returns oldest-first
});
```

A singleton "always take the server copy" model via `shouldOverwrite`:

```ts
export const CurrentUserModel = defineModel<MyProfileInput, MyProfile>({
  name: 'CurrentUserModel',
  id: 'current-user',
  normalize: (p) => ({ id: p.id, name: p.name, plan: p.plan, updatedAt: p.updatedAt }),
  replace: { shouldOverwrite: () => true }, // server profile always wins, even on equal timestamps
});
```

A join-row model that must overwrite on position change (not just newer timestamp):

```ts
const positionChanged = (a: FeedRow, b: Partial<FeedRow>) => a.sequence !== b.sequence;

export const FeedModel = defineModel<FeedEdge, FeedRow>({
  name: 'FeedModel',
  id: 'feed',
  normalize: (e) => ({ id: e.node.id, sequence: e.sequence, momentId: e.node.id }),
  merge: { shouldOverwrite: positionChanged },
  replace: { shouldOverwrite: positionChanged },
});
```

## `CollectionModel` — read

### Reactive (hooks — re-render on change)

| Method | Signature | Returns |
| --- | --- | --- |
| `find` | `(id: string \| null \| undefined)` | the row, or `undefined` |
| `all` | `()` | all rows (applies `defaultSort`) |
| `where` | `(filter: Partial<TStored>)` | rows matching every field in `filter` |
| `byIds` | `(ids: string[])` | rows for those ids |
| `count` | `(filter?: Partial<TStored>)` | number of rows (optionally filtered) |

```tsx
function ChatBadge({ chatId }: { chatId: string }) {
  const unread = MessageModel.count({ chatId, read: false }); // live count
  return unread > 0 ? <Badge value={unread} /> : null;
}

function AdminList() {
  const admins = UserModel.where({ role: 'admin' }); // re-renders as rows change
  return <FlatList data={admins} keyExtractor={(u) => u.id} renderItem={({ item }) => <Text>{item.name}</Text>} />;
}
```

### Snapshot (synchronous — safe anywhere)

| Method | Signature | Returns |
| --- | --- | --- |
| `get` | `(id: string \| null \| undefined)` | the row, or `undefined` |
| `getAll` | `()` | all rows |
| `getWhere` | `(filter: Partial<TStored>)` | matching rows |
| `getFirstWhere` | `(filter: Partial<TStored>)` | first matching row, or `undefined` |

```ts
// in a subscription handler or event callback (no hooks allowed here):
function onIncoming(message: MessageInput) {
  const existing = MessageModel.get(message.id);
  if (!existing) MessageModel.applyServerData([message], mergeSyncContract('subscription'));
}
```

A `filter` is a `Partial<TStored>`: a row matches when it equals the filter on every provided field (`undefined`
fields are ignored). Use `null` to match a null column.

## `CollectionModel` — write

| Method | Signature | Returns | Notes |
| --- | --- | --- | --- |
| `applyServerData` | `(items, contract: SyncContract)` | `MergeResult \| ReplaceResult` | The main sync path. |
| `patch` | `(id, updates: Partial<TStored>)` | `boolean` | Shallow-update. `false` if absent or the gate rejects. |
| `destroy` | `(id)` | `boolean` | Delete one row. |
| `destroyMany` | `(ids: string[])` | `number` | Delete many; returns count. |
| `destroyWhere` | `(filter: Partial<TStored>)` | `number` | Delete matching; throws on empty filter (use `clearScope`). |
| `replaceRaw` | `(oldId: string, item: TInput)` | `boolean` | Atomically delete `oldId`, insert normalized `item`. |
| `insertStored` | `(item: TStored)` | `void` | Insert an already-stored-shaped row. |
| `clearScope` | `()` | `void` | Delete every row + clear freshness. |

```ts
import { mergeSyncContract, replaceSyncContract, generateTempId } from '@noma4i/react-native-dblayer';

// Merge a page of users (upsert-if-newer):
UserModel.applyServerData(users, mergeSyncContract('usersQuery'));

// Replace the whole collection (drop rows the server no longer returns):
UserModel.applyServerData(users, replaceSyncContract('usersQuery'));

// Scoped replace — only touch this chat's messages:
MessageModel.applyServerData(pageMessages, {
  ...replaceSyncContract('chatThread', { chatId }),
  _scopeFilter: (row) => (row as Message).chatId === chatId,
});

// Optimistic insert, then swap for the server row:
const temp = { id: generateTempId('msg'), chatId, body, pending: true };
MessageModel.insertStored(temp);                 // shows instantly
// ...after the mutation resolves:
MessageModel.replaceRaw(temp.id, serverMessage); // temp id gone, server row in

// Direct edits:
UserModel.patch(userId, { isOnline: true });
UserModel.destroyWhere({ role: 'guest' });
```

### `SyncContract`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `'merge' \| 'replace'` | **required** | Write strategy. |
| `source` | `string` | `—` | Label for freshness/debugging. |
| `scope` | `unknown` | `—` | Opaque scope tag. |
| `_scopeFilter` | `(item) => boolean` | `—` | Scoped replace: only rows passing this may be deleted. Required for `replace` + `scope`. |
| `_freshnessFilter` | `Record<string, unknown>` | `—` | Record freshness for a specific scope instead of the root. |

- **merge** — insert new; update existing only when incoming is newer (`updatedAt` gate) unless `shouldOverwrite`.
  Only defined fields overwrite. Honors `dedupeWindowMs`.
- **replace** — upsert every incoming row, delete rows not in the incoming set (optionally limited to
  `_scopeFilter`). Returns `{ merged, deleted }`.

## `CollectionModel` — freshness

| Method | Signature | Description |
| --- | --- | --- |
| `markFetched` | `(filter?, state?: { empty?: boolean; pageInfo? })` | Stamp a scope as fetched now. |
| `getFetchState` | `(filter?)` | `{ touchedAt, empty, pageInfo } \| null`. |
| `clearFetchState` | `(filter?)` | Forget a scope's freshness. |
| `shouldSkipInitialFetch` | `(filter?, maxAgeMs = staleTime)` | `true` when the scope has data (or is known-empty) and is not stale. |

```ts
// Manual fetch that respects freshness (the query DSL does this for you):
async function loadUsers() {
  if (UserModel.shouldSkipInitialFetch()) return; // fresh enough, skip network
  const users = await api.fetchUsers();
  UserModel.applyServerData(users, mergeSyncContract('users'));
  UserModel.markFetched(undefined, { empty: users.length === 0 });
}
```

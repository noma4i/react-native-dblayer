# Models

A model is a persistent, reactive collection plus a generated or custom normalizer. Define one per entity.

## `defineModel(config)`

The recommended API is the declarative `fields` form. It generates the model normalizer, keeps sparse fields sparse
(`undefined` means "do not write this key"), and lets you derive row types from the model.

```ts
import { defineModel, f, type ModelInput, type ModelStored } from '@noma4i/react-native-dblayer';

export const UserModel = defineModel({
  name: 'UserModel',
  id: 'users',
  fields: {
    uuid: f.str(),
    fullName: f.str(),
    age: f.num().nullable(),
    coverUrl: f.str().nullDefault(),
    countryName: f.custom((u) => (u as { country?: { name?: string } }).country?.name).nullable(),
    updatedAt: f.str().nullable().optional(),
  },
});

export type UserData = ModelStored<typeof UserModel>;
export type UserInput = ModelInput<typeof UserModel>;
```

Returns a `CollectionModel<unknown, UserData>`. Raw server payloads can be passed directly to `applyServerData`;
field readers are defensive and skip malformed values. `UserInput` is a sparse write shape:
`Partial<UserData> & { id: string }`.

The legacy normalize form remains supported as an escape hatch:

```ts
export const MessageModel = defineModel<MessageInput, Message>({
  name: 'MessageModel',
  id: 'messages',
  normalize: (m) => ({ id: m.id, chatId: m.chatId, body: m.body, updatedAt: m.updatedAt }),
});
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | **required** | Unique model name. Runtime-registry key and log tag. |
| `id` | `string` | **required** | Collection id + storage-key prefix (e.g. `'users'`). Unique per app. |
| `fields` | `Record<string, FieldSpec>` | recommended | Declarative field map used to generate `normalize`. Do not declare `id`; use `rowId` or input `id`. |
| `rowId` | `(input) => string \| null \| undefined` | `input.id` via `toStr` | Custom row id resolver for fields models. `null`, `undefined`, or `''` drops the row. |
| `guard` | `(input) => boolean` | `—` | Return `false` to drop an input before field reads. |
| `sideload` | `SideloadSpec[]` | `—` | Sync nested payloads into registry-named target models before writing this model. |
| `relations` | `() => ModelRelationsConfig` | `—` | Lazy model relations used by explicit cascade destroy paths. |
| `normalize` | `(input: TInput) => (Partial<TStored> & { id: string }) \| null` | escape hatch | Custom mapper for irreducibly custom rows. Return `null` to drop it. |
| `staleTime` | `number` (ms) | `0` | How long a fetched scope stays fresh. `0` = always stale. Drives `shouldSkipInitialFetch`. |
| `emptyStaleTime` | `number` (ms) | `0` | How long a known-empty fetched scope may skip. `0` = known-empty scopes never skip. |
| `merge.dedupeWindowMs` | `number` (ms) | `0` | Skip a merge batch identical to the previous one within this window. `0` = no dedupe. |
| `merge.shouldOverwrite` | `(existing, incoming) => boolean` | `—` | Force-accept a merge the timestamp gate would reject. |
| `replace.shouldOverwrite` | `(existing, incoming) => boolean` | `—` | Same, for replace writes. |
| `defaultSort` | `{ field: keyof TStored; direction: 'asc' \| 'desc' }` | `—` (insertion order) | Sort applied by the reactive `all()`. |

The stored type must extend `{ id: string; updatedAt?: string | null }`. `updatedAt` (ISO) enables the newer-wins
gate; omit it and every incoming write is accepted.

### Field builders

| Builder | Stored value | Notes |
| --- | --- | --- |
| `f.str()` | `string` | Reads only strings. |
| `f.num()` | `number` | Reads only numbers. |
| `f.bool()` | `boolean` | Reads only booleans. |
| `f.id()` | `string` | Coerces string/number ids to string. |
| `f.enum<T>()` | `T` | Typed passthrough for GraphQL enums; no runtime validation. |
| `f.raw<T>()` | `T` | Passthrough for arrays or JSON blobs. |
| `f.custom(read)` | `TOut` | Read from the whole input item. |
| `f.object(shape)` | nested object | Reads a nested shape. |
| `f.array(shapeOrField)` | array | Drops elements that read as `undefined` or `null`. |

Every field supports:

| Modifier | Effect |
| --- | --- |
| `.nullable()` | Preserves explicit `null`; stored type becomes `T \| null`. |
| `.optional()` | Stored key becomes optional. |
| `.nullDefault()` | Maps missing/undefined source to `null`; stored type becomes `T \| null`. |
| `.default(value \| () => value)` | Factory-time default used by `buildStored`; lazy form avoids shared references. |
| `.from(selector)` | Reads from selector output instead of `input[key]`. |

`.default` and `.nullDefault()` are independent. A field may use both: `normalize()` still follows `.nullDefault()`,
while `buildStored()` uses `.default` first when the caller omits the key. Defaults are typed against the field output
value, not the nullable wrapper.

### Shapes

Shapes are reusable nested field groups. They can be used through `f.object`, `f.array`, or directly via
`readShape` / `readShapeOrThrow` inside a custom `normalize`.

```ts
import { defineShape, f, readShapeOrThrow } from '@noma4i/react-native-dblayer';

const mediaShape = defineShape<{ url?: unknown; coverUrl?: unknown; width?: unknown; height?: unknown }>()({
  url: f.str(),
  coverUrl: f.str().nullDefault(),
  width: f.num().nullDefault(),
  height: f.num().nullDefault(),
});

export const MomentModel = defineModel({
  name: 'MomentModel',
  id: 'moments',
  fields: {
    title: f.str(),
    media: f.object(mediaShape).nullable(),
    attachments: f.array(mediaShape).optional(),
  },
});

export const MessageModel = defineModel<MessageInput, Message>({
  name: 'MessageModel',
  id: 'messages',
  normalize: (m) => ({
    id: m.id,
    body: m.body,
    media: m.media == null ? null : readShapeOrThrow(mediaShape, m.media, 'MessageModel.media'),
  }),
});
```

`readShape(shape, input)` returns `undefined` for non-object input. `readShapeOrThrow(shape, input, label)` uses the
same reader and throws `<label>: invalid shape payload` when the payload is unreadable.

### Row id, guard, and composite ids

Fields models default to `input.id` for the row id. Use `rowId` for composite rows and `guard` to drop inputs early.

```ts
import { compositeId, defineModel, f } from '@noma4i/react-native-dblayer';

export const SimilarMomentModel = defineModel({
  name: 'SimilarMomentModel',
  id: 'similar-moments',
  rowId: compositeId((row) => (row as any).momentId, (row) => (row as any).similarMomentId),
  guard: (row) => (row as { hidden?: boolean }).hidden !== true,
  fields: {
    momentId: f.id(),
    similarMomentId: f.id(),
    score: f.num().nullable(),
  },
});
```

### Sideload nested payloads

Use `sideload` when a parent payload carries nested entities that must be synced before the parent row. Targets are
looked up by model registry name, so model files do not need to import each other.

```ts
export const MomentModel = defineModel({
  name: 'MomentModel',
  id: 'moments',
  fields: {
    body: f.str(),
    authorId: f.id().from((row) => (row as any).author?.id),
  },
  sideload: [
    { model: 'UserModel', pluck: (row) => (row as any).author },
    { model: 'UserModel', pluck: (row) => (row as any).mentionedUsers, source: 'momentMentions' },
  ],
});
```

Sideloads always merge into the target model, run before the parent merge/replace, drop nullish plucked values, and
skip in-flight targets to prevent cycles. Missing target names throw with the list of registered models.

### Relations and cascade destroy

Use `relations` for domain ownership between models. The thunk is lazy so model files can reference each other without
eager circular-import failures.

```ts
import { belongsTo, defineModel, f, hasMany, hasManyThrough } from '@noma4i/react-native-dblayer';

export const MessageModel = defineModel({
  name: 'MessageModel',
  id: 'messages',
  fields: {
    chatId: f.id(),
    userId: f.id(),
    body: f.str(),
  },
  relations: () => ({
    user: belongsTo(UserModel, { foreignKey: 'userId', touch: true }),
  }),
});

export const ChatModel = defineModel({
  name: 'ChatModel',
  id: 'chats',
  fields: {
    userId: f.id(),
    title: f.str(),
  },
  relations: () => ({
    messages: hasMany(MessageModel, { foreignKey: 'chatId', dependent: 'destroy' }),
  }),
});

export const UserModel = defineModel({
  name: 'UserModel',
  id: 'users',
  fields: {
    name: f.str(),
  },
  relations: () => ({
    chats: hasMany(ChatModel, { foreignKey: 'userId', dependent: 'destroy' }),
    messages: hasManyThrough({ through: 'chats', source: 'messages' }),
  }),
});
```

`hasMany(childModel, { foreignKey, dependent: 'destroy' })` requires `foreignKey` to be a string field on the child
stored row. Explicit destroy paths (`destroy`, `destroyMany`, `destroyWhere`, and utilities that call those methods)
resolve parent ids, destroy dependent children depth-first, then delete parent rows. Cascades recurse through child
relations. In cycles, re-entered models delete the matched rows but do not cascade their relations again.

Models with a `relations` thunk expose local query accessors under `model.related.<name>`:

| Relation | Accessor | Type | Behavior |
| --- | --- | --- |
| `hasMany` / `hasManyThrough` | `get(parentId)` | snapshot read | Returns child rows where the child foreign key equals `parentId`; `null`/`undefined` returns `[]`. |
| `hasMany` / `hasManyThrough` | `use(parentId)` | React hook | Reactive scoped child rows using the model live-query path; `null`/`undefined` returns a stable empty array without a bogus scope. |
| `hasMany` / `hasManyThrough` | `count(parentId)` | React hook | Reactive scoped count; `null`/`undefined` returns `0`. For through relations this is `use(parentId).length`. |
| `belongsTo` | `get(childId)` | snapshot read | Reads the child row, takes its `foreignKey` value, and returns the parent row; `null`/`undefined` or a missing parent id returns `undefined`. |
| `belongsTo` | `use(childId)` | React hook | Reactive on both the child row foreign-key value and the parent row. Nullish child ids return `undefined` without a bogus subscription. |

Rows returned by read paths on models with relations also expose `row.related.<name>` as a snapshot property getter:

```ts
const chats = UserModel.find(userId)?.related.chats;
const messages = ChatModel.get(chatId)?.related.messages;
const user = MessageModel.get(messageId)?.related.user;
const liveMessages = ChatModel.related.messages.use(chatId);
const liveUser = MessageModel.related.user.use(messageId);
```

| Form | Use when | Behavior |
| --- | --- | --- |
| `row.related.<name>` for `hasMany` / `hasManyThrough` | You already have a row from `get`, `find`, `where`, `all`, or related reads and need a snapshot of its children. | Calls the same snapshot path as `Model.related.<name>.get(row.id)` at property access time. Children inserted after the row object was obtained are visible on the next property access. |
| `row.related.<name>` for `belongsTo` | You already have a child row and need its parent snapshot. | Reads the child row's own `foreignKey` value and returns the parent row or `undefined`. |
| `Model.related.<name>.use(id)` | The related value itself must be reactive. | React hook; call unconditionally from a component or another hook. |

Row-level related values are not hooks and do not subscribe. This keeps `find(id)?.related.<name>` valid: making row-level children reactive would require conditional hook calls after a possibly undefined `find(id)` result. Reactive child reads stay on the model-level accessor.

The row `related` namespace is non-enumerable and lazy. It is absent from `Object.keys`, object spread, `JSON.stringify`, storage persistence, stable serialization, and field iteration. Models without a `relations` thunk leave rows untouched.

`hasManyThrough({ through, source })` is query-only. `through` must name a direct `hasMany` relation on the current
model, and `source` must name a direct `hasMany` relation on the through-child model. Through accessors first read the
through rows, collect their ids, then read source rows whose source foreign key is in that id set. Both levels are
reactive for `use`; row-level through properties use the same snapshot composition.

`belongsTo(parentModel, { foreignKey, touch })` is the inverse direction. `foreignKey` names a field on the current
child row that stores the parent id; missing or non-string values read as no parent. `dependent` is not accepted, and
`belongsTo` never participates in cascade destroy.

With `touch: true`, local child insert-style writes, `patch`, and `replaceRaw` bump an existing local parent row with
`updatedAt: new Date().toISOString()`. Server writes through `applyServerData` do not touch parents, because server
payloads are authoritative. Child destroy does not touch. Touch propagation stops after one level: a parent patch caused
by touch does not trigger that parent's own `belongsTo({ touch: true })` relations.

Related accessors are local reads only. They do not fetch network data, expose fetch state, or mark freshness scopes.
Network scoping stays in request configs and collection bindings.

`hasManyThrough` and `belongsTo` do not participate in cascade destroy. Cascades follow only direct
`hasMany(..., { dependent: 'destroy' })` relations; transitive deletes still happen through those direct relations.

Server replace-mode removals from `applyServerData(..., { mode: 'replace' })` do not cascade. Replace eviction is sync
bookkeeping, not a domain delete. Later merge/replace server payloads can recreate previously cascaded rows normally;
freshness metadata follows the incoming write contract.

### Examples

A model with a dedupe window and a default sort:

```ts
export const MessageModel = defineModel({
  name: 'MessageModel',
  id: 'messages',
  fields: {
    chatId: f.id(),
    body: f.str(),
    createdAt: f.str(),
    updatedAt: f.str().nullable().optional(),
  },
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
| `where` | `(filter: DbWhere<TStored>, options?: DbReadOptions<TStored>)` | rows matching `filter` |
| `byIds` | `(ids: string[])` | rows for those ids |
| `first` | `(filter?: DbWhere<TStored>, options?: { orderBy })` | first matching row, or `undefined` |
| `count` | `(filter?: DbWhere<TStored>)` | number of rows (optionally filtered) |

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
| `getWhere` | `(filter: DbWhere<TStored>)` | matching rows |
| `getFirstWhere` | `(filter?: DbWhere<TStored>, options?: { orderBy })` | first matching row, or `undefined` |
| `getFirst` | `(filter?: DbWhere<TStored>, options?: { orderBy })` | alias for `getFirstWhere` |

```ts
// in a subscription handler or event callback (no hooks allowed here):
function onIncoming(message: MessageInput) {
  const existing = MessageModel.get(message.id);
  if (!existing) MessageModel.applyServerData([message], mergeSyncContract('subscription'));
}
```

A `DbWhere<TStored>` can be a field equality map, `{ and: [...] }`, `{ or: [...] }`, or `{ not: ... }`.
`undefined` fields are ignored. Use `null` to match a null column.

```ts
const recentPrimary = ChatModel.where(
  { and: [{ status: 'primary' }, { or: [{ pinned: true }, { kind: 'system' }] }] },
  { orderBy: { field: 'lastActivityAt', direction: 'desc' }, limit: 25 }
);

const latestMessage = MessageModel.first(
  { chatId },
  { orderBy: { field: 'createdAt', direction: 'desc' } }
);
```

## `CollectionModel` — write

| Method | Signature | Returns | Notes |
| --- | --- | --- | --- |
| `buildStored` | `(partial)` | `TStored` | Fields models only. Pure stored-row factory; no normalize pass or write. |
| `applyServerData` | `(items, contract: SyncContract)` | `MergeResult \| ReplaceResult` | The main sync path. |
| `patch` | `(id, updates: Partial<TStored>)` | `boolean` | Shallow-update. `false` if absent or the gate rejects. |
| `destroy` | `(id)` | `boolean` | Delete one row. |
| `destroyMany` | `(ids: string[])` | `number` | Delete many; returns count. |
| `destroyWhere` | `(filter: Partial<TStored>)` | `number` | Delete matching; throws on empty filter (use `clearScope`). |
| `replaceRaw` | `(oldId: string, item: TInput)` | `boolean` | Atomically delete `oldId`, insert normalized `item`. |
| `insertStored` | `(item: TStored)` | `void` | Insert an already-stored-shaped row. |
| `clearScope` | `()` | `void` | Delete every row + clear freshness. |

`destroy`, `destroyMany`, and `destroyWhere` clear per-scope fetch-state records whose persisted freshness filter
matches at least one deleted row. Root fetch-state survives row destroys; `clearScope()` clears all rows and all
freshness for the model.

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

### Sparse patch helpers

Use `pickDefined(source, keys)` for patches where `undefined` means untouched and explicit `null` clears a value:

```ts
const patch = pickDefined(input, ['name', 'description', 'dob'] as const);
CurrentUserModel.patch(userId, patch);
```

Use `pickPresent(source, keys)` for the few fields where both `null` and `undefined` should be skipped. It is a
sibling helper instead of an options DSL because the package only needs the default and drop-null modes.

For fields models, prefer `buildStored` when an optimistic row needs the same defaults every time:

```ts
export const MessageModel = defineModel({
  name: 'MessageModel',
  id: 'messages',
  fields: {
    chatId: f.id(),
    body: f.str(),
    status: f.enum<'sending' | 'sent'>().default('sending'),
    createdAt: f.str(),
    editedAt: f.str().nullable(),
    attachments: f.array(f.raw<{ url: string }>()).default(() => []),
  },
});

const temp = MessageModel.buildStored({
  id: generateTempId('msg'),
  chatId,
  body,
  createdAt: new Date().toISOString(),
});
MessageModel.insertStored(temp);
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
| `shouldSkipInitialFetch` | `(filter?, maxAgeMs = staleTime, emptyMaxAgeMs = emptyStaleTime)` | `true` when the scope has data, or has opted-in known-empty freshness, and is not stale. |

```ts
// Manual fetch that respects freshness (the query DSL does this for you):
async function loadUsers() {
  if (UserModel.shouldSkipInitialFetch()) return; // fresh enough, skip network
  const users = await api.fetchUsers();
  UserModel.applyServerData(users, mergeSyncContract('users'));
  UserModel.markFetched(undefined, { empty: users.length === 0 });
}
```

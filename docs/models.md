# Models

`defineModel` builds a persistent, reactive collection: a durable row store, optional named
scopes, declarative relations, and a full read/write surface, all backed by the shared journalled
apply pipeline. This doc covers `defineModel` end-to-end. Field builders live in the `f` and
`defineShape` schema DSL (also covered here); query/mutation write destinations are covered in
[queries.md](./queries.md) and [mutations.md](./mutations.md).

Every example below shares one small domain: a `UserModel`, a `ChatModel`, and a `MessageModel`
that belongs to a chat and lives in a per-chat `thread` scope.

## `defineModel(config)`

```ts
import { belongsTo, defineModel, defineShape, f, scope } from '@noma4i/react-native-dblayer';

const MessageSchema = defineShape<MessageNode>()({
  id: f.id(),
  chatId: f.id(),
  text: f.str(),
  kind: f.enum<MessageKind>(),
  createdAt: f.str(),
  localEcho: f.bool().optional()
});

const MessageModel = defineModel({
  id: 'messages',
  name: 'MessageModel',
  fields: MessageSchema.fields,
  scopes: {
    thread: scope({ by: { chatId: 'chatId' }, sort: { field: 'createdAt', dir: 'asc' } })
  },
  relations: () => ({
    chat: belongsTo(ChatModel, {
      foreignKey: 'chatId',
      touch: (message, chat) => ({ lastMessageText: message.text }),
      counterCache: { field: 'unreadCount', filter: message => message.kind !== 'system' }
    })
  }),
  gc: 'exempt',
  merge: {
    shouldOverwrite: (existing, incoming) => isIncomingNewer(existing.updatedAt, incoming.updatedAt)
  },
  statics: model => ({
    forChat: (chatId: string) => model.getWhere({ chatId })
  })
});
```

### `ModelConfig`

| Option | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique model id. Namespaces storage keys, dependency tracking, and cross-model relation targets. |
| `name` | `string` | Human-readable name; prefixes normalize/apply error and log messages. |
| `fields` | field spec map | Field specs (built with `f.*`, typically via `defineShape`) that drive every normalize/build read. |
| `rowId` | `(input: unknown) => string` | Derive the row id from raw input. Defaults to `input.id`. Returning anything other than a non-empty string makes `normalize` throw `${name} requires id`. |
| `guard` | `(input: unknown) => boolean` | Row-level filter run before id resolution. Returning `false` throws `${name} rejected input`, handled the same way as an unresolved `rowId`. |
| `relations` | `() => Record<string, RelationDecl>` | Lazily-evaluated relation declarations (`belongsTo`/`hasMany`/`hasOne`/`references`). Evaluated once on first access, so relation targets defined later in the same module do not need to exist yet at `defineModel` call time. |
| `scopes` | `Record<string, ScopeSpec>` | Named `ScopeSpec` definitions built with `scope(...)`. Each entry becomes a `model.scopes.<name>` handle. |
| `gc` | `'exempt'` | Keeps this model's rows out of garbage-collection sweeps even when unreferenced by any scope. |
| `merge.shouldOverwrite` | `(existing, incoming) => boolean` | Acceptance gate for an incoming write when a row with the same id already exists. Return `false` to keep the existing row and drop the incoming one (e.g. an out-of-order or stale server echo). Omit to always accept incoming writes. |
| `statics` | `(model: ModelCore) => TExt` | Build extra static members merged onto the returned model. Receives the base model so statics can call back into `get`/`patch`/`use`/etc. Throws at `defineModel` time if a returned key collides with a base model key. |

`normalize`/`buildStored` read every configured field from raw input on every write; invalid rows
(a failed `guard`, an unresolved `rowId`, or a field that throws) are rejected and logged, never
thrown into the apply pipeline - a single bad row in a batch never fails the rest of the batch.

## Fields (`f`)

Field specs describe how one stored field is read from raw input. Build them with `f.*`, chain
modifiers, and group them into a reusable shape with `defineShape`.

| Builder | Reads | Stores |
| --- | --- | --- |
| `f.str()` | string values only | `string` |
| `f.num()` | number values only | `number` |
| `f.bool()` | boolean values only | `boolean` |
| `f.id()` | string or number ids, normalized to string; empty/nullish/non-scalar skipped | `string` |
| `f.enum<T>()` | any non-nullish value, passed through as `T` (no runtime validation) | `T` |
| `f.raw<T>()` | any non-nullish value, passed through as `T` (JSON blobs, arrays) | `T` |
| `f.custom(read)` | `read(input)` over the whole input object | the selector's return type |
| `f.object(shape)` | a nested object read through a `defineShape` shape | the shape's stored object type |
| `f.array(item)` | an array of shapes or scalar field specs; unreadable elements are dropped | an array of the item's stored type |

Every builder reads `input[key]` by default. Chain these modifiers to change presence, nullability,
or the read source:

| Modifier | Effect |
| --- | --- |
| `.nullable()` | Preserves an explicit `null` during normalize instead of skipping it. `buildStored` fills an omitted nullable field with `null` unless `.default(...)` is set. |
| `.optional()` | Lets normalize and `buildStored` omit this key entirely; no implicit value is filled in. |
| `.nullDefault()` | Converts a missing/undefined normalize input to `null` (implies `.nullable()` behavior). |
| `.default(value \| () => value)` | Provides a `buildStored`-only default for an omitted field; normalize is unaffected. The factory runs once per `buildStored` call. |
| `.from(selector)` | Reads this field from `selector(input)` instead of `input[key]`. |
| `.fromKey(key, source?)` | Reads an own property `key` off `input` (or `source(input)` when given), instead of the field's own key. |

```ts
const UserSchema = defineShape<UserNode>()({
  id: f.id(),
  name: f.str(),
  avatarUrl: f.str().nullable(),
  role: f.enum<UserRole>().default('member'),
  bio: f.str().optional()
});
```

`defineShape<TInput>()(fields)` brands a field map with its raw input type so it can be passed
straight to `defineModel({ fields })`, reused as a nested object field (`f.object(shape)`), or used
standalone:

| Function | Signature | Role |
| --- | --- | --- |
| `defineShape` | `<TInput>() => (fields) => DbShape` | Define a reusable field group for model fields, object fields, and array items. |
| `readShape` | `(shape, input) => TStored \| undefined` | Read an unknown payload through a shape; `undefined` when the payload is not an object. |
| `readShapeOrThrow` | `(shape, input, label) => TStored` | Same as `readShape`, throwing `${label}: invalid shape payload` on an unreadable input. |
| `projectShape` | `(shape, source, overrides?) => TStored` | Project a wider source object into a shape's field set, applying `overrides` last. |

`ModelInput<M>`, `ModelStored<M>`, and `InferShapeStored<TShape>` are the corresponding inference
types: `ModelStored<typeof MessageModel>` is the row type returned by every read on that model,
`ModelInput<typeof MessageModel>` is a partial row with a required `id` (the shape accepted by
`patch`/`replaceRaw`-style callers), and `InferShapeStored<typeof MessageSchema>` is the plain
object type a standalone `defineShape` shape reads into.

## Writes

| Method | Signature | Behavior |
| --- | --- | --- |
| `insertStored` | `(row: TStored) => void` | Normalize and upsert one row as an event write. |
| `insertStoredMany` | `(rows: TStored[]) => void` | Insert a batch as ONE plan - one journal record, one apply transaction, one commit publish. A `belongsTo` `counterCache` increments once by the batch's full count rather than once per row. |
| `patch` | `(id: string, patch: Partial<TStored>) => void` | Apply a partial update as an event write. No-ops if the row does not exist. |
| `destroy` | `(id: string) => void` | Destroy one row as an event write. Cascades to `hasMany` `dependent: 'destroy'` children in the same plan. |
| `destroyMany` | `(ids: string[]) => void` | Destroy several rows in one plan. |
| `replaceRaw` | `(oldId: string, next: unknown) => void` | Destroy `oldId` and insert `next` (which may resolve to a different id) as one plan, carrying `oldId`'s scope memberships onto the new row. Used to replace a temp row identity outside the standard mutation temp-id-replace path. |

`insertStored`/`insertStoredMany`/`patch`/`destroy`/`destroyMany`/`replaceRaw` are all **event**
writes: they run through `expandPlan`, so declared relation side effects (`touch`, `counterCache`,
`dependent: 'destroy'` cascades) and declarative scope membership (`scope({ by })`) apply in the
same transaction. Query/mutation server-response writes apply as **snapshot** writes instead
(verbatim, no relation expansion - server data already carries derived state); see
[queries.md](./queries.md) and [mutations.md](./mutations.md).

**Event-origin tombstone semantics.** `destroy` marks a tombstone for the destroyed id. A later
**snapshot** write for that same id (a query page or entity refresh that still contains the row,
e.g. a stale cached response) is silently dropped while the tombstone is live - a passive server
sync can never resurrect a row the app explicitly destroyed. An **event** write for that id
(`insertStored`, an ingest upsert, a mutation's optimistic insert or temp-id commit) is not subject
to the tombstone check and writes through normally - an explicit action can still recreate the row
under the same id. Garbage-collection eviction (`collectGarbage`, see
[configuration.md](./configuration.md)) never tombstones: an evicted row is simply absent, and any
later write (snapshot or event) resurrects it.

## Reads

Snapshot reads never subscribe; use them outside React or in the library/maintenance channel.
Reactive reads (`use.*`) subscribe to exactly the dependency they read.

| Read | Signature | Notes |
| --- | --- | --- |
| `get` | `(id) => TStored \| undefined` | Snapshot read of one row. |
| `getWhere` | `(where, opts?) => TStored[]` | Snapshot read filtered by a `DbWhere` predicate, with optional `orderBy`/`limit`. |
| `getAll` | `() => TStored[]` | Full snapshot. Library/maintenance channel - application code stays on scoped reads. |
| `use.row` | `(id, opts?) => TStored \| undefined` | Reactive read of one row; `opts.select` narrows the field dependency. |
| `use.field` | `(id, field) => TStored[K] \| undefined` | Reactive read of one field - nothing else re-renders it. |
| `use.first` | `(where?, opts?) => TStored \| undefined` | Reactive read of the first row matching `where`. |
| `use.where` | `(where, opts?) => TStored[]` | Reactive read of every row matching `where`. |
| `use.byIds` | `(ids: string[]) => TStored[]` | Reactive read of several rows by id, in the order given. |
| `use.count` | `(where?) => number` | Reactive count of matching rows. |
| `use.related` | `(id, relationName) => unknown` | Reactive read through a declared relation (see Relations below). |

`DbWhere<T>` is `Partial<T>` or a composed `{ and }` / `{ or }` / `{ not }` predicate tree.

## Scopes

A scope is a named, ordered subset of a model's rows, declared with `scope(spec)` and consumed
through `model.scopes.<name>`.

```ts
scopes: {
  thread: scope({
    by: { chatId: 'chatId' },
    sort: { field: 'createdAt', dir: 'asc' },
    retention: { maxRows: 500 }
  })
}
```

### `ScopeSpec`

| Field | Type | Description |
| --- | --- | --- |
| `by` | `Record<string, keyof TStored>` | Automatic membership mapping from scope-value fields to stored row fields (e.g. `{ chatId: 'chatId' }`). When set, a row's membership is derived from its field values on every event write - it joins the scope instance matching its current values and leaves any instance it no longer matches, in the same apply transaction as the write. Omit for scopes populated only by a `defineQuery` destination or direct `__apply` calls. |
| `sort` | `{ field, dir } \| { comparator } \| 'server-order'` | Member ordering: sort by a stored field (`asc`/`desc`), a custom row comparator, or `'server-order'` (default) - preserve the order rows were reconciled into the scope in, with no client-side resort. |
| `retention` | `{ maxRows: number }` | Membership cap enforced on first-page refetch (`resetOrder`) and `'complete'` coverage; trimmed ids fall to garbage collection. |

### `ScopeHandle`

| Member | Signature | Notes |
| --- | --- | --- |
| `use` | `(scopeValue) => TStored[]` | Reactive read of every row currently in the scope, in the scope's configured sort order. `null`/`undefined` reads as empty without subscribing. |
| `useWindow` | `(scopeValue, opts?) => { rows, totalCount, hasMore, loadMore }` | Reactive, render-windowed read: renders only the first `pageSize` rows locally (default from `configureDb`'s `defaults.pageSize`, else 20), growing on demand via the returned `loadMore()`. This is **local** window growth over rows already synced into the model - a different concept from a query's `fetchNextPage` (network pagination; see [queries.md](./queries.md)). A paginated list typically wires both: `fetchNextPage()` to fetch more rows from the server, `loadMore()` to reveal more of what is already local. The window resets to `pageSize` whenever `scopeValue`'s key changes. |
| `useCount` | `(scopeValue) => number` | Reactive count of rows currently in the scope. |
| `invalidate` | `(scopeValue?) => void` | Clears this scope's fetch-state and invalidates its derived React Query key(s). |
| `read` | `(scopeValue) => TStored[]` | Synchronous snapshot read of the scope's rows, in sort order; safe to call outside React. |

## Relations

Relations are declared lazily in `relations: () => ({ ... })` and resolved by `expandPlan` for
**event** plans only (imperative writes, mutations, ingest) - snapshot plans (query pages, entity
refreshes) apply verbatim, since server data already carries derived state.

| Builder | Direction | Side effects |
| --- | --- | --- |
| `belongsTo(model, { foreignKey, touch?, counterCache? })` | child -> parent | `touch` derives a partial parent update from the child and current parent view, folded per parent so several children in one plan compose (last patch per field wins), emitted as a `patch` op in the same plan. `counterCache` increments `field` on the parent when a NEW child first references it (filtered by `filter`, if given) and decrements on child destroy. |
| `hasMany(model, { foreignKey, dependent? })` | parent -> children | `dependent: 'destroy'` cascades a parent destroy to its live children in the same plan; omit for a query-only relation with no cascade. Optimistic destroy on the parent throws if this is set (a cascaded destroy cannot be rolled back). |
| `hasOne(model, { foreignKey, comparator? })` | parent -> one child | Query-only, read through `use.related` - not resolved by `expandPlan`. `comparator` picks the best-sorting child when several match; omit to use the first match in read order. |
| `references(model, { ids })` | GC-only edge | Not resolved by `expandPlan`. `ids(row)` extracts the referenced id(s); those rows are kept alive during garbage-collection sweeps (see [configuration.md](./configuration.md)). |

```ts
relations: () => ({
  chat: belongsTo(ChatModel, {
    foreignKey: 'chatId',
    touch: (message, chat) => ({ lastMessageText: message.text }),
    counterCache: { field: 'unreadCount', filter: message => message.kind !== 'system' }
  })
})

// on ChatModel:
relations: () => ({
  messages: hasMany(MessageModel, { foreignKey: 'chatId', dependent: 'destroy' }),
  lastMessage: hasOne(MessageModel, {
    foreignKey: 'chatId',
    comparator: (a, b) => Number(b.createdAt) - Number(a.createdAt)
  })
})
```

Read a relation reactively with `use.related(id, 'chat')` (`belongsTo`/`hasOne`) or
`use.related(id, 'messages')` (`hasMany`, returns an array).

## Reactivity guarantees

Every write compiles into one apply-pipeline transaction that publishes pinpoint notifications
keyed by `(model, id, fields)` for row/field reads and by `(model, scopeKey)` for scope reads.
A write is visible to readers in the same tick - there are no async hops, debounces, or
query-cache round-trips on the write path. A patch to one field notifies only readers of that
field; an unrelated row, an unrelated field on the same row, and a scope the write did not join or
leave never re-render. Array reads (`use.where`, `scope.use`) keep referential identity for every
untouched element, so a single-row patch never invalidates memoized siblings.

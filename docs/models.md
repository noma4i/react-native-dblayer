# Models

`defineModel` builds a persistent, reactive collection: a durable row store, optional named
scopes, declarative relations, and a full read/write surface, all backed by the shared journalled
apply pipeline. Every network-facing capability - queries, mutations, ephemeral fetches, status
polling, joined views, and subscription ingest - is a method on the model it belongs to
(`Model.query`, `Model.mutation`, `Model.fetch`, `Model.poller`, `Model.view`, `Model.ingest`).
There are no standalone `defineQuery`/`defineMutation`/`defineView`/`defineIngest` constructors.

This doc covers `defineModel` end-to-end - fields, writes, reads, scopes, relations, maintenance,
polling, views, and ingest. `Model.query`'s and `Model.mutation`'s full config surfaces have their
own doc pages: [queries.md](./queries.md) and [mutations.md](./mutations.md).

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
  maintenance: {
    maxRowsPerScope: [{ scopeField: 'chatId', limit: 500, compare: (a, b) => Number(b.createdAt) - Number(a.createdAt) }]
  },
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
| `name` | `string` | Human-readable name; prefixes normalize/apply error and log messages, and is the key `Model.ingest`'s fused custom handlers use to look up other models (see Ingest below). |
| `fields` | field spec map | Field specs (built with `f.*`, typically via `defineShape`) that drive every normalize/build read. |
| `rowId` | `(input: unknown) => string` | Derive the row id from raw input. Defaults to `input.id`. Returning anything other than a non-empty string makes `normalize` throw `${name} requires id`. |
| `guard` | `(input: unknown) => boolean` | Row-level filter run before id resolution. Returning `false` throws `${name} rejected input`, handled the same way as an unresolved `rowId`. |
| `relations` | `() => Record<string, RelationDecl>` | Lazily-evaluated relation declarations (`belongsTo`/`hasMany`/`hasOne`/`references`). Evaluated once on first access, so relation targets defined later in the same module do not need to exist yet at `defineModel` call time. |
| `scopes` | `Record<string, ScopeSpec>` | Named `ScopeSpec` definitions built with `scope(...)`. Each entry becomes a `model.scopes.<name>` handle. |
| `gc` | `'exempt'` | Keeps this model's rows out of garbage-collection sweeps even when unreferenced by any scope. |
| `maintenance` | `{ maxRowsPerScope? }` | Boot-time maintenance declarations, run by `bootDb`. See Maintenance below. |
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
same transaction. `Model.query`/`Model.mutation` server-response writes apply as **snapshot**
writes instead (verbatim, no relation expansion - server data already carries derived state); see
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

**Tombstone retention.** Tombstones are not kept forever - a per-model tombstone map decays on a
three-tier policy, checked on every checkpoint/flush cycle: any tombstone older than 24h is pruned
unconditionally; once a model's tombstone count exceeds 10,000, tombstones already older than a
10-minute minimum age are pruned oldest-first back down to that cap (the floor protects the
delete-before-create race window a fresh destroy needs, so cap pressure alone cannot cut it short);
if a burst pushes the count past 20,000 (twice the cap) in one tick, an overflow valve prunes
oldest-first straight down to the cap, ignoring the 10-minute floor entirely for the overflow - an
extreme burst is a bigger memory/storage risk than the narrow race window the floor exists to
protect. Decay runs for every model on each flush (`flushPersistence`/`suspendDb`/background
checkpoint), including a quiescent model with no new writes since the last flush - tombstones age
out even without fresh activity on that model.

## Reads

Snapshot reads never subscribe; use them outside React or in the library/maintenance channel.
Reactive reads (`use.*`) subscribe to exactly the dependency they read.

| Read | Signature | Notes |
| --- | --- | --- |
| `get` | `(id) => TStored \| undefined` | Snapshot read of one row. |
| `getWhere` | `(where, opts?) => TStored[]` | Snapshot read filtered by a `DbWhere` predicate, with optional `orderBy`/`limit`. |
| `getAll` | `() => TStored[]` | Full snapshot. Library/maintenance channel - application code stays on scoped reads. |
| `use.row` | `(id, opts?) => TStored \| undefined` | Reactive read of one row; `opts.select` narrows the field dependency, `opts.require` gates on field completeness (see below). |
| `use.field` | `(id, field) => TStored[K] \| undefined` | Reactive read of one field - nothing else re-renders it. |
| `use.first` | `(where?, opts?) => TStored \| undefined` | Reactive read of the first row matching `where`; `opts.require` gates on field completeness (see below). |
| `use.where` | `(where) => ModelReadBuilder<TStored>` | Chainable reactive/snapshot read builder. See below. |
| `use.byIds` | `(ids: string[]) => TStored[]` | Reactive read of several rows by id, in the order given. |
| `use.count` | `(where?) => number` | Reactive count of matching rows. |
| `use.related` | `(id, relationName) => unknown` | Reactive read through a declared relation (see Relations below). |

`DbWhere<T>` is `Partial<T>` or a composed `{ and }` / `{ or }` / `{ not }` predicate tree.

### `use.where` chainable builder

```ts
const recent = MessageModel.use.where({ chatId })
  .orderBy('createdAt', 'desc')
  .limit(20)
  .rows();                          // reactive; subscribes to this model

const snapshot = MessageModel.use.where({ chatId })
  .orderBy('createdAt', 'desc')
  .read();                          // synchronous snapshot; safe outside React
```

`use.where(criteria)` returns a `ModelReadBuilder<TStored>` instead of an array directly:

| Member | Signature | Notes |
| --- | --- | --- |
| `orderBy` | `(field, direction?) => ModelReadBuilder<TStored>` | Adds one ordering key (default `'asc'`); later calls become deterministic tie-break keys before the implicit id key. Returns a new builder - chain freely. |
| `limit` | `(count: number) => ModelReadBuilder<TStored>` | Keeps only the leading `count` rows after filtering and ordering. |
| `rows` | `() => TStored[]` | Reactive terminal - subscribes to this model. |
| `read` | `() => TStored[]` | Snapshot terminal - synchronous, safe outside React. |

Sorting is **NULLS LAST**: a row missing a sort field (`null` or `undefined` - both count as
missing) always sorts after rows that have a value for it, on every declared key, regardless of
`asc`/`desc`. Rows tied on every declared key (or when no `orderBy` is called) fall back to an
**implicit `id` tie-break** for a fully deterministic order. Calling `.rows()`/`.read()` with no
`orderBy` at all returns rows in natural storage order (only `limit` applied, no sort pass).
`use.where(null)` reads as empty without subscribing, consistent with every other nullable-scope
read in the DSL.

### Required fields

`use.row`, `use.first`, and the `use.where` builder's `.require(...)` stage all accept a set of
stored field names that must be **present** before a row is returned; an incomplete row reads as
absent instead of returning a partial value. Presence follows the same rule as everywhere else in
the DSL: `undefined` (the field was never written) is missing, `null` (an explicit stored null) is
present.

```ts
const contact = ContactModel.use.row(contactId, { require: ['bio', 'avatarUrl'] });
// contact: (TStored & { bio: string; avatarUrl: string | null }) | undefined

const recent = MessageModel.use.where({ chatId }).require('senderName').orderBy('createdAt', 'desc').rows();
// recent: Array<TStored & { senderName: string }>
```

| Surface | Signature | Behavior |
| --- | --- | --- |
| `use.row(id, { require })` | `(id, { require: K[] }) => RequiredFields<TStored, K> \| undefined` | `undefined` when the row is missing or any required field on it is missing. |
| `use.first(where, { require, ... })` | `(where, opts & { require: K[] }) => RequiredFields<TStored, K> \| undefined` | Same completeness gate applied to the first matching row - an incomplete leading row is skipped in favor of the next complete one. |
| `use.where(where).require(...fields)` | `(...K[]) => ModelReadBuilder<RequiredFields<TStored, K>>` | Filters the whole builder result to complete rows; combine with `.orderBy`/`.limit`/`.rows()`/`.read()` as usual. |

Each surface narrows the returned row type: every required key becomes non-optional -
`RequiredFields<TStored, K> = TStored & { [P in K]-?: Exclude<TStored[P], undefined> }` - so reading
`contact.bio` above needs no undefined-check (it can still be a real stored `null` if the field is
nullable).

Reactivity differs by surface. `use.row`'s dependency is the exact row plus its required (and
`select`ed) fields, so completing the last required field on that row produces exactly one
re-render, and writes to any other row or field never touch it. `use.first` and
`use.where(...).require(...)` run through the same model-scoped incremental read engine as every
other builder terminal: they recompute on writes to their own model (an unrelated model's writes
never trigger a re-render), and re-render only when the value they actually return changes - so
completing a row that becomes the new first match, or newly passes the builder's filter, still
yields exactly one render.

**Row-level only.** Scope and window reads (`ScopeHandle.use`/`useWindow`) have no `require` of
their own on the source row - a scope's membership and `totalCount` are defined by *unfiltered*
membership (see [Scopes](#scopes) below), and gating the source row itself would silently change
what "being in the scope" means. `Model.view`'s `include` DOES support `require` on *included*
related rows - see [`Model.view`](#modelviewname-config) below.

**Motivating example** - a chat list synced from a sparse feed extract carries only `id`/`name` for
each participant; a profile screen needs `bio`/`avatarUrl` too, which arrive later from a dedicated
detail fetch:

```ts
function ProfileScreen({ contactId }: { contactId: string }) {
  // Sparse rows from the feed extract have bio/avatarUrl as undefined until ContactModel.query
  // ('detail', ...) or an extract sink fills them in - the screen renders a skeleton until then.
  const contact = ContactModel.use.row(contactId, { require: ['bio', 'avatarUrl'] });
  if (!contact) return <ProfileSkeleton />;
  return <Profile bio={contact.bio} avatarUrl={contact.avatarUrl} />;
}
```

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
| `by` | `Record<string, keyof TStored>` | Automatic membership mapping from scope-value fields to stored row fields (e.g. `{ chatId: 'chatId' }`). When set, a row's membership is derived from its field values on every event write - it joins the scope instance matching its current values and leaves any instance it no longer matches, in the same apply transaction as the write. Omit for scopes populated only by a `Model.query` destination or direct `__apply` calls. |
| `sort` | `{ field, dir } \| { comparator } \| 'server-order'` | Member ordering: sort by a stored field (`asc`/`desc`), a custom row comparator, or `'server-order'` (default) - preserve the order rows were reconciled into the scope in, with no client-side resort. |
| `retention` | `{ maxRows: number }` | Membership cap enforced on first-page refetch (`resetOrder`) and `'complete'` coverage; trimmed ids fall to garbage collection. |

### `ScopeHandle`

| Member | Signature | Notes |
| --- | --- | --- |
| `use` | `(scopeValue) => TStored[]` | Reactive read of every row currently in the scope, in the scope's configured sort order. `null`/`undefined` reads as empty without subscribing. |
| `useWindow` | `(scopeValue, opts?) => { rows, totalCount, hasMore, fetchNextPage }` | Reactive, render-windowed read: renders only the first `pageSize` rows locally (default from `configureDb`'s `defaults.pageSize`, else 20), growing on demand via the returned `fetchNextPage()`. This is **local** window growth over rows already synced into the model - a different concept from a query's `fetchNextPage` (network pagination; see [queries.md](./queries.md)), even though both surfaces share the `fetchNextPage` name. A paginated list typically wires both: the query result's `fetchNextPage()` to fetch more rows from the server, `useWindow(...).fetchNextPage()` to reveal more of what is already local. The window resets to `pageSize` whenever `scopeValue`'s key changes. |
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
| `references(model, { ids })` | GC-only edge | Not resolved by `expandPlan`. `ids(row)` extracts the referenced id(s); those rows are kept alive during garbage-collection sweeps (see [configuration.md](./configuration.md)). Not supported as a `Model.view` include (see below). |

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

## Maintenance

```ts
maintenance: {
  maxRowsPerScope: [
    { scopeField: 'chatId', limit: 500, compare: (a, b) => Number(b.createdAt) - Number(a.createdAt) }
  ],
  dropIdleScopesAfterMs: 30 * 60 * 1000
}
```

| Field | Type | Description |
| --- | --- | --- |
| `maxRowsPerScope` | `Array<{ scopeField, limit, compare, protect? }>` | Groups rows by `scopeField`, keeps the first `limit` per group ordered by `compare` (newest/most-important first), and deletes the rest. `protect?: () => (row) => boolean` is evaluated at run time (may read other models) to exempt rows from the count. |
| `dropIdleScopesAfterMs` | `number` (ms) | Opt-in idle scope collection: a scope with no read in this window is removed on the next `collectGarbage()` sweep, and its rows then follow normal reachability (evicted too, unless another scope/reference/reader still roots them). Omit to keep every scope alive until it empties on its own. |

`maxRowsPerScope` tasks run once, at boot, as part of `bootDb` - not on every write. Temp-row
cleanup does not need a maintenance entry: it is already handled by the replay orphan sweep inside
`replayJournal`. Each declared model surfaces one `MaintenanceReport` per `maxRowsPerScope` task
(`{ model, task: 'maxRowsPerScope', affected }`) in `bootDb`'s return value; see
[configuration.md](./configuration.md#bootdboptions--suspenddb).

`dropIdleScopesAfterMs` is checked differently: every time `collectGarbage()` runs (at boot, in
`suspendDb`, from an in-session GC-trigger sweep, or a direct call) - not just once at startup. A
"read" is a mounted `use`/`useWindow`/`useCount` scope reader, or a `ScopeHandle.read(...)` snapshot
call - both stamp the scope's last-access time. A currently-mounted reactive reader always survives
regardless of that timestamp, since its live commit-bus subscription roots the scope directly. A
scope restored from storage at hydration also gets a fresh access timestamp, so a session restart
never makes an existing scope instantly idle-eligible before the app has had a chance to read it
again. Idle removal is reflected in `GcReport.scopesRemoved` alongside ordinary dead/empty scope
cleanup - the two are not counted separately.

## `Model.crud(sections)`

Composes conventional resource handles from one call: `model.crud({ list?, get?, create?, update?,
destroy? })`. Each PRESENT section builds one `Model.query`/`Model.mutation` handle under a fixed
conventional name (`'list'`/`'get'`/`'create'`/`'update'`/`'destroy'`), so keys and dedupe follow
the same conventions as calling `Model.query`/`Model.mutation` directly (see
[queries.md](./queries.md#modelqueryname-config) and
[mutations.md](./mutations.md#modelmutationname-config)). The returned object has exactly the
present keys, typed as the real `Model.query`/`Model.mutation` handles - omitting a section from
the call omits it from the return type too.

```ts
const todosCrud = TodoModel.crud({
  list: { document: TodosDocument, select: data => data.todos, into: TodoModel.scopes.active },
  create: {
    document: TodoCreateDocument,
    result: 'todoCreate',
    respond: (input: { text: string }, ctx) => ({ todoCreate: { id: ctx.tempId, text: input.text, done: false } }),
    selectServerNode: data => data.todoCreate,
    prependTo: { scope: TodoModel.scopes.active, value: () => ({}) }
  },
  update: { document: TodoUpdateDocument, result: 'todoUpdate' },
  destroy: { document: TodoDestroyDocument, result: 'todoDestroy' }
});

await todosCrud.create.run({ text: 'Buy milk' });
await todosCrud.update.run({ id: 'row-1', text: 'Buy milk and eggs' });
await todosCrud.destroy.run({ id: 'row-1' });
```

### Section conventions

| Section | Convention | Notes |
| --- | --- | --- |
| `list` | `model.query('list', section)` -> `<modelId>:list` | `into` is **required** - `crud` throws `` `${modelId}: crud list requires an explicit into scope` `` at call time if omitted. |
| `get` | `model.query('get', section)` -> `<modelId>:get` | `into` defaults to the model itself when omitted. |
| `create` | `model.mutation('create', section)` -> `<modelId>:create` | Requires `respond`, or `build` with `selectServerNode`, unless an explicit `optimistic` key is present - see below. `prependTo`/`appendTo` pass straight through to the conventional optimistic config. |
| `update` | `model.mutation('update', section)` -> `<modelId>:update` | Default optimistic: `{ method: 'patch', selectId: input => input.id, selectPatch: input => omit(input, ['id']) }`. |
| `destroy` | `model.mutation('destroy', section)` -> `<modelId>:destroy` | Default optimistic: `{ method: 'destroy', selectId: input => input.id }`. |

Every mutation section keeps `Model.mutation`'s conventional dedupe on by default (see
[mutations.md](./mutations.md#dedupe)) - `dedupe: false` in a section config opts out the same way
it would on a standalone `Model.mutation` call.

**`create`'s requirement.** `model.crud({ create: {...} })` throws
`` `${modelId}: crud create requires respond or build with selectServerNode` `` at call time unless
the section supplies `respond` (see the Respond variant in
[mutations.md](./mutations.md#optimistic-write-variants)), the `build`/`selectServerNode` pair (the
Insert variant, same section), or an explicit `optimistic` key of its own - the check is
presence-based, so an explicit `optimistic: undefined` still counts as present and skips it.

**Overriding the convention.** An explicit `optimistic` in any section (`create`/`update`/`destroy`)
replaces the conventional default ENTIRELY, not merged with it. `optimistic: false` disables the
local write for that section outright - the mutation runs with no optimistic step, same as omitting
`optimistic` on a standalone `Model.mutation` call.

**Typed `id` requirement.** `update`/`destroy` handles are typed to require
`input: { id: string } & Record<string, unknown>` regardless of the section's own config - passing
an input without `id` is a compile-time error on the conventional path, since the default
`selectId`/`selectPatch` closures read `input.id`.

## `Model.poller(name, config)`

A refcounted, non-React status poller scoped to this model, for server-side async processing
(image/video transcoding, moderation, batch jobs) where the row needs periodic re-fetching until a
terminal state is reached.

```ts
const messagePoller = MessageModel.poller('delivery-status', {
  document: MessageStatusDocument,
  vars: id => ({ messageId: id }),
  apply: (id, data) => MessageModel.patch(id, { deliveryStatus: data.messageStatus.status }),
  isTerminal: data => data.messageStatus.status === 'delivered' || data.messageStatus.status === 'failed',
  intervalMs: 3000,
  maxAttempts: 20
});

const detach = messagePoller.attach(messageId);   // starts polling; call on unmount to stop
```

`config` is the same shape `createModelStatusPoller` takes (`fetch` is wired for you from
`document`/`vars` over the configured transport), plus `document`/`vars` replacing `fetch`. Fetch
failures log as `<modelId>:<name>` and consume an attempt like any other failed poll. See
[runtime-primitives.md](./runtime-primitives.md#createmodelstatuspollerconfig) for the full
`ModelStatusPoller` surface (`attach`/`subscribe`/`refresh`/`isPolling`/`isSessionTerminal`).

## `Model.view(name, config)`

A reactive, pinpoint-notified projection that joins a model's scope with its declared relations (or
computed cross-model lookups) into one item shape - the read-side counterpart to declaring
relations for writes.

```ts
const threadView = MessageModel.view('withAuthor', {
  source: 'thread',                                   // a declared scope name, or a ScopeHandle
  include: {
    author: 'chat',                                    // a declared relation name
    reactions: [ReactionModel, message => message.id]   // computed: [targetModel, idResolver]
  },
  select: (message, included) => ({ ...message, author: included.author, reactions: included.reactions }),
  renderKeys: ['text', 'author']                        // preserve item identity while these stay equal
});

const items = threadView.use({ chatId });
const window = threadView.useWindow({ chatId }, { pageSize: 20 });
```

| Option | Type | Description |
| --- | --- | --- |
| `source` | `string \| ScopeHandle` | A declared scope name on this model, or an explicit `ScopeHandle`. |
| `include` | `Record<string, string \| [Model, (row) => string \| string[] \| null]>` | Per-alias include: a declared relation name (`belongsTo`/`hasMany`/`hasOne` only - `references` throws), or a computed `[targetModel, idResolver]` pair that resolves one or more ids off the source row against `targetModel`. `hasMany`/`hasOne` includes use a model-wide discovery dependency so newly-matching rows are found; unrelated target writes recompute the projection but preserve item identities (no re-render) when nothing the item displays actually changed. |
| `select` | `(row, included, ctx: { index }) => TItem` | Build one view item. Defaults to `{ ...row, ...included }`. |
| `renderKeys` | `string[]` | Preserve an item's reference across recomputes while every listed key stays equal - the same identity-stability contract as `useStableProjection`'s `renderKeys`. |

Returns a `ViewHandle`: `use(scopeValue) => TItem[]` and
`useWindow(scopeValue, opts?) => { rows, totalCount, hasMore, fetchNextPage }` - the same windowed
shape as `ScopeHandle.useWindow`. `Model.view` throws at call time if `source` names an unknown
scope or `include` names an unknown/unsupported relation.

### Required includes

An include may gate on field completeness with `require: string[]`, following the same
`undefined` = missing / `null` = present rule as row-level `require` (see
[Required fields](#required-fields) above). Two forms carry it:

- A declared relation written as an object instead of a bare string - the alias itself must equal
  the relation name: `include: { author: { require: ['fullName'] } }`. Only the plain-string form
  (`author: 'someOtherRelationName'`) can point an alias at a differently-named relation, and that
  form cannot carry `require`.
- A computed include written as `{ model, ids, require? }` instead of the `[model, idResolver]`
  tuple form.

```ts
const withAuthor = ChatModel.view('withAuthor', {
  source: 'feed',
  include: { author: { require: ['fullName'] } },        // alias 'author' == declared relation name
  select: (row, included) => ({ id: row.id, author: included.author })   // author: Author | null
});
```

An incomplete related row is **dropped** from an array-shaped result (a `hasMany` include, or a
`{ model, ids, require }` include whose `ids` resolver returns an array) and delivered as
**`null`** for a single-shaped result (`belongsTo`, `hasOne`, or an `ids` resolver that returns one
id) - `select` never sees a partial related row. Reactivity is pinpoint per item: when a required
field on a related row arrives, only the view items that included that row re-render - other items
keep their prior reference.

## `Model.ingest(entries)`

Declares model-owned subscription handling: one entry per event name, applying rows, guards,
effects, and custom logic together. `Model.ingest` returns
`{ entries, apply(key, payload) }` - `entries` feeds directly into
`createDbSubscriptionRuntime(entries)` (see
[configuration.md](./configuration.md#subscription-runtime)); `apply(key, payload)` dispatches a
payload through the same pipeline imperatively (tests, or a transport delivering events outside the
subscription runtime).

Each entry is one of two forms:

**Handler form** - the exact atomic apply pipeline (rows, destroys, and `extract` sinks apply with
relation side effects in one epoch; stale-version arbitration stays in `merge.shouldOverwrite`):

```ts
const messageIngest = MessageModel.ingest({
  messageCreated: { handler: payload => ({ upsert: payload.message, operationId: payload.clientOperationId }) },
  messageDeleted: { handler: payload => ({ destroy: payload.id, invalidate: true }) }
});
```

`handler(payload)` returns a declaration - `null` skips the event entirely:

| Field | Type | Description |
| --- | --- | --- |
| `upsert` | `unknown \| unknown[]` | Row(s) to write into this model as an event upsert. |
| `destroy` | `string \| string[]` | Id(s) to destroy. |
| `invalidate` | `boolean` | Invalidate the model's registered queries after applying. |
| `extract` | `ExtractSink[]` | Cross-model sideloads applied in the SAME transaction as the event rows. |
| `operationId` | `string \| null` | Echo guard: when this operation id already committed locally (via a `Model.mutation` run that sent the same id, see [mutations.md](./mutations.md#operationid-echo-wiring-with-modelingest)), the whole event is skipped. |

**Fused declarative form** - when `handler` is omitted, `Model.ingest` compiles the subscription
entry and the apply logic from one declaration:

```ts
const messageIngest = MessageModel.ingest({
  messageCreated: {
    document: MessageCreatedDocument,
    payload: data => data.messageCreated,
    apply: 'upsert',
    echoGuard: payload => payload.clientId === localClientId
  },
  messageRead: {
    document: MessageReadDocument,
    guard: 'existing',
    apply: (payload, tools) => tools.model.patch(payload.messageId, { readAt: payload.readAt })
  }
});
```

| Field | Type | Description |
| --- | --- | --- |
| `document` | subscription document | Subscription document passed to the configured transport. Required unless the entry is only ever driven through `apply(key, payload)`. |
| `payload` | `(data) => unknown` | Transform the raw transport payload before `guard`/`effect`/`apply` see it. |
| `apply` | `'upsert' \| 'destroy' \| (payload, tools) => void` | `'upsert'` (default) and `'destroy'` route through the exact handler-form pipeline above. A function gets `tools: { model, invalidate, operations, models }` for full custom logic - `models` is every `defineModel`, keyed by its `name`. |
| `guard` | `'existing' \| (payload) => boolean` | `'existing'` applies only when the row already exists (e.g. read receipts); a function is a custom acceptance predicate. |
| `echoGuard` | `(payload) => boolean` | Return `true` to skip an own-echo subscription payload (an alternative to the handler form's `operationId` guard). |
| `debounce` | `{ ms, keyOf? }` | Trailing debounce, delegated to the subscription runtime. |
| `effect` | `{ name, when: 'before' \| 'after' }` | Invoke a named effect injected via `createDbSubscriptionEffects` immediately before or after `apply`. |

## Reactivity guarantees

Every write compiles into one apply-pipeline transaction that publishes pinpoint notifications
keyed by `(model, id, fields)` for row/field reads and by `(model, scopeKey)` for scope reads.
A write is visible to readers in the same tick - there are no async hops, debounces, or
query-cache round-trips on the write path. A patch to one field notifies only readers of that
field; an unrelated row, an unrelated field on the same row, and a scope the write did not join or
leave never re-render. Array reads (`use.where(...).rows()`, `scope.use`) keep referential identity
for every untouched element, so a single-row patch never invalidates memoized siblings.

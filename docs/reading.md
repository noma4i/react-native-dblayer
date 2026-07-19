# Reading

Every read surface on a model and its scopes: snapshot reads, reactive row/field/relation reads,
the chainable `use.where` builder, `use.byIds`, projections (`select`/`renderKeys`) and their
identity guarantees, scope `use`/`useWindow`, `keepPrevious`, `use.pending`, and `Model.view`.
Network reads that write into these surfaces (`Model.query`, `defineFetch`) have their own doc
page: [queries.md](./queries.md).

## Contents

- [Snapshot vs reactive reads](#snapshot-vs-reactive-reads)
- [`use.where` chainable builder](#usewhere-chainable-builder)
- [Required fields](#required-fields)
- [Projections: `select` and `renderKeys`](#projections-select-and-renderkeys)
- [Scope reads](#scope-reads)
- [`Model.use.pending(id)`](#modelusependingid)
- [`Model.view(name, config)`](#modelviewname-config)
- [Reactivity guarantees](#reactivity-guarantees)

## Snapshot vs reactive reads

Snapshot reads never subscribe; use them outside React or in the library/maintenance channel.
Reactive reads (`use.*`) subscribe to exactly the dependency they read.

| Read          | Signature                                                                  | Notes                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `get`         | `(id) => TStored \| undefined`                                                | Snapshot read of one row.                                                                                                     |
| `getWhere`    | `(where, opts?) => TStored[]`                                                  | Snapshot read filtered by a `DbWhere` predicate, with optional `orderBy`/`limit`.                                            |
| `getAll`      | `() => TStored[]`                                                              | Full snapshot. Library/maintenance channel - application code stays on scoped reads.                                        |
| `use.pending` | `(id) => boolean`                                                              | True only while that exact row id belongs to an open optimistic operation; nullish ids return false without subscribing. See [below](#modelusependingid). |
| `use.row`     | `(id, opts?) => TStored \| TProjection \| undefined`                          | Reactive read of one row; `opts.select`/`opts.renderKeys` project (see [below](#projections-select-and-renderkeys)), `opts.require` gates on field completeness (see [Required fields](#required-fields)). |
| `use.field`   | `(id, field) => TStored[K] \| undefined`                                       | Reactive read of one field - nothing else re-renders it.                                                                     |
| `use.first`   | `(where?, opts?) => TStored \| TProjection \| undefined`                       | Reactive read of the first row matching `where`; same `select`/`renderKeys`/`require` options as `use.row`.                  |
| `use.where`   | `(where) => ModelReadBuilder<TStored>`                                         | Chainable reactive/snapshot read builder. See below.                                                                          |
| `use.byIds`   | `(ids, opts?) => { rows: TStored[] \| TProjection[]; byId: ReadonlyMap<string, TStored \| TProjection> }` | Reactive read of several rows by id: `rows` preserves input order, `byId` is an id-keyed lookup map. Nullish `ids` return an unsubscribed empty result (`{ rows: [], byId: <empty map> }`). |
| `use.count`   | `(where?) => number`                                                            | Reactive count of matching rows.                                                                                              |
| `use.related` | `(id, relationName, opts?) => unknown`                                          | Reactive read through a declared relation (see [models.md](./models.md#relations)); same `select`/`renderKeys` projection options. |

`DbWhere<T>` is `Partial<T>` or a composed `{ and }` / `{ or }` / `{ not }` predicate tree.

## `use.where` chainable builder

```ts
const recent = MessageModel.use.where({ chatId }).orderBy('createdAt', 'desc').limit(20).rows(); // reactive; subscribes to this model

const snapshot = MessageModel.use.where({ chatId }).orderBy('createdAt', 'desc').read(); // synchronous snapshot; safe outside React
```

`use.where(criteria)` returns a `ModelReadBuilder<TStored>` instead of an array directly:

| Member    | Signature                                            | Notes                                                                                                                                                      |
| --------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderBy` | `(field, direction?) => ModelReadBuilder<TStored>`       | Adds one ordering key (default `'asc'`); later calls become deterministic tie-break keys before the implicit id key. Returns a new builder - chain freely. |
| `limit`   | `(count: number) => ModelReadBuilder<TStored>`           | Keeps only the leading `count` rows after filtering and ordering.                                                                                          |
| `rows`    | `() => TStored[]`                                        | Reactive terminal - subscribes to this model.                                                                                                              |
| `read`    | `() => TStored[]`                                        | Snapshot terminal - synchronous, safe outside React.                                                                                                       |

Sorting is **NULLS LAST**: a row missing a sort field (`null` or `undefined` - both count as
missing) always sorts after rows that have a value for it, on every declared key, regardless of
`asc`/`desc`. Rows tied on every declared key (or when no `orderBy` is called) fall back to an
**implicit `id` tie-break** for a fully deterministic order. Calling `.rows()`/`.read()` with no
`orderBy` at all returns rows in natural storage order (only `limit` applied, no sort pass).
`use.where(null)` reads as empty without subscribing, consistent with every other nullable-scope
read in the DSL.

## Required fields

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

| Surface                               | Signature                                                                       | Behavior                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `use.row(id, { require })`             | `(id, { require: K[] }) => RequiredFields<TStored, K> \| undefined`                 | `undefined` when the row is missing or any required field on it is missing.                                                        |
| `use.first(where, { require, ... })`   | `(where, opts & { require: K[] }) => RequiredFields<TStored, K> \| undefined`        | Same completeness gate applied to the first matching row - an incomplete leading row is skipped in favor of the next complete one. |
| `use.where(where).require(...fields)`  | `(...K[]) => ModelReadBuilder<RequiredFields<TStored, K>>`                          | Filters the whole builder result to complete rows; combine with `.orderBy`/`.limit`/`.rows()`/`.read()` as usual.                  |

Each surface narrows the returned row type: every required key becomes non-optional -
`RequiredFields<TStored, K> = TStored & { [P in K]-?: Exclude<TStored[P], undefined> }` - so reading
`contact.bio` above needs no undefined-check (it can still be a real stored `null` if the field is
nullable).

Reactivity differs by surface. `use.row`'s dependency is the exact row plus its required (and
selected/`renderKeys`) fields, so completing the last required field on that row produces exactly
one re-render, and writes to any other row or field never touch it. `use.first` and
`use.where(...).require(...)` run through the same model-scoped incremental read engine as every
other builder terminal: they recompute on writes to their own model (an unrelated model's writes
never trigger a re-render), and re-render only when the value they actually return changes - so
completing a row that becomes the new first match, or newly passes the builder's filter, still
yields exactly one render.

**Row-level only.** Scope and window reads (`ScopeHandle.use`/`useWindow`) have no `require` of
their own on the source row - a scope's membership and `totalCount` are defined by _unfiltered_
membership (see [Scope reads](#scope-reads) below), and gating the source row itself would silently
change what "being in the scope" means. `Model.view`'s `include` DOES support `require` on
_included_ related rows - see [`Model.view`](#modelviewname-config) below.

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

## Projections: `select` and `renderKeys`

`use.row`, `use.first`, `use.byIds`, and `use.related` each accept a mutually-exclusive pair of
projection options - passing both on the same call throws `` `${surface} cannot use select and
renderKeys together` ``:

| Option       | Shape                              | What is returned                        | Identity kept stable while...                                    |
| ------------ | ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| `select`     | `(row: TStored) => TProjection`      | The selector's return value, not the row. | The **projected output** stays shallow-equal across recomputes.        |
| `renderKeys` | `readonly (keyof TStored & string)[]` | The full stored row, unprojected.         | The **listed fields** on the source row stay shallow-equal across recomputes, even while other fields on the same row change. |
| (neither)    | -                                     | The full stored row.                      | Only while the underlying row object itself is unchanged - any write to the row produces a new reference. |

Both options run through one shared per-hook projection gate: on every recompute the gate compares
the new equality value (the selector's output for `select`, the listed keys' values for
`renderKeys`) against the previous one with a shallow-equal check, and returns the **previous
output reference** unchanged when they match - so a memoized child component keyed on that
reference skips re-rendering for changes it does not display. `use.byIds`'s array form applies the
same per-item gate plus an outer array-level shallow-equal check, so an untouched row's projected
entry keeps its reference inside the returned `rows` array too.
Array-valued projection or `renderKeys` entries compare element-wise by reference, one level deep.

## Scope reads

A scope is a named, ordered subset of a model's rows, declared with `scope(spec)` (see
[models.md](./models.md#scopes)) and consumed through `model.scopes.<name>`:

| Member       | Signature                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `use`        | `(scopeValue, { select?, renderKeys?, keepPrevious? }?) => TStored[]`                 | Reactive read of every row currently in the scope, in the scope's configured sort order. `keepPrevious` defaults to `false`; when enabled, an unresolved key handoff returns the last non-empty key snapshot (see below). `null`/`undefined` reads as empty without subscribing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `useWindow`  | `(scopeValue, opts?) => { rows, totalCount, hasMore, isPreviousData, fetchNextPage }` | Reactive, render-windowed read: renders only the first `pageSize` rows locally (default from `configureDb`'s `defaults.pageSize`, else 20), growing on demand via the returned `fetchNextPage()`. This is **local** window growth over rows already synced into the model - a different concept from a query's `fetchNextPage` (network pagination; see [queries.md](./queries.md)), even though both surfaces share the `fetchNextPage` name. A paginated list typically wires both: the query result's `fetchNextPage()` to fetch more rows from the server, `useWindow(...).fetchNextPage()` to reveal more of what is already local. The window resets to `pageSize` whenever `scopeValue`'s key changes. `isPreviousData` is true only while `keepPrevious` is serving the prior key. |
| `useCount`   | `(scopeValue) => number`                                                              | Reactive count of rows currently in the scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `invalidate` | `(scopeValue?) => void`                                                               | Clears this scope's fetch-state and invalidates its derived React Query key(s).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `read`       | `(scopeValue) => TStored[]`                                                           | Synchronous snapshot read of the scope's rows, in sort order; safe to call outside React.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `seed`       | `(scopeValue, rows: TInput[]) => void`                                                | Dev/test-only seed through the normal journalled apply pipeline plus complete explicit membership replacement for this scope in the provided order. Automatic memberships are also applied, and subscribers receive at most one commit wave.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`keepPrevious` is hook-local and opt-in. On a key switch it retains the prior non-empty snapshot
only until the new key produces rows or completes with a confirmed empty scope. After that first
resolved snapshot, prior-key rows cannot reappear for the current key. Runtime reset and unmount
discard retention state. Prefer `useWindow` for this pattern because `isPreviousData` lets the UI
distinguish retained content from current-key content without guessing from row count. Do not enable
it for account or detail identity switches where showing the previous entity would be unsafe.

## `Model.use.pending(id)`

Returns true while the exact row id belongs to an open optimistic operation. Insert readers switch
to true for the temp id and back to false when commit swaps it for the server id or rollback removes
it. Patch readers switch to true for the existing id and back to false after commit or rollback.
Readers for other ids are not notified, row objects are unchanged, and a nullish id returns false
without subscribing.

During boot replay, hydrated pending operations follow the existing orphan reconciliation path:
their temp rows are removed and the operations are rolled back before replay completes. The removed
temp id therefore reports false after boot.

## `Model.view(name, config)`

A reactive, pinpoint-notified projection that joins a model's scope with its declared relations (or
computed cross-model lookups) into one item shape - the read-side counterpart to declaring
relations for writes (see [models.md](./models.md#relations)).

```ts
const listView = ChatModel.view<ChatListItem, { lastMessage: StoredMessage | null; users: UserData[] }>('list', {
  source: 'list', // a declared scope name, or a ScopeHandle
  include: {
    lastMessage: 'lastMessage', // a declared relation name
    users: { model: UserModel, ids: chat => chat.userIds } // computed target ids
  },
  select: (chat, included) => ({ ...chat, lastMessage: included.lastMessage, users: included.users }),
  renderKeys: ['title', 'lastMessage'] // checked against ChatListItem keys
});

const items = listView.use({ status: 'primary' }, { keepPrevious: true });
const window = listView.useWindow({ status: 'primary' }, { pageSize: 20, keepPrevious: true });
```

When an output type is explicit, declare the include map as the second type argument as shown;
TypeScript does not partially infer later generic arguments. That declaration types `included`
without coupling its related-row shapes to the structural model readers used by computed includes.

| Option       | Type                                                | Description                                                                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`     | `string \| ScopeHandle`                             | A declared scope name on this model, or an explicit `ScopeHandle`.                                                                                                                                                                                                                                                           |
| `include`    | `{ [K in keyof TIncluded]: ViewIncludeSpec<TRow> }` | Per-alias include: a declared relation name (`belongsTo`/`hasMany`/`hasOne` only - `references` throws), or a computed target model plus id resolver that resolves one or more ids off the source row. Resolved includes subscribe to their pinpoint row dependencies, so unrelated target writes do not recompute the view. |
| `select`     | `(row, included, ctx: { index }) => TItem`          | Build one view item. Defaults to `{ ...row, ...included }`.                                                                                                                                                                                                                                                                  |
| `renderKeys` | `readonly (keyof TItem & string)[]`                 | Preserve an item's reference across recomputes while every listed key stays shallow-equal through the shared projection gate (see [Projections](#projections-select-and-renderkeys) above).                                                                                                                                  |

Returns a `ViewHandle`: `use(scopeValue, { keepPrevious? }?) => TItem[]` and
`useWindow(scopeValue, opts?) => { rows, totalCount, hasMore, isPreviousData, fetchNextPage }` - the
same opt-in key-handoff and window semantics as `ScopeHandle`. `Model.view` throws at call time if
`source` names an unknown scope or `include` names an unknown/unsupported relation.

Unlike row-level reads, a view may combine `select` with `renderKeys`. The selected object remains
the returned item, while its reference is preserved when every listed key on that selected output
is shallow-equal; `select` alone compares the full projection, and `renderKeys` alone gates the
unselected row. Row-level reads continue to require `select` or `renderKeys`, never both.

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
  include: { author: { require: ['fullName'] } }, // alias 'author' == declared relation name
  select: (row, included) => ({ id: row.id, author: included.author }) // author: Author | null
});
```

An incomplete related row is **dropped** from an array-shaped result (a `hasMany` include, or a
`{ model, ids, require }` include whose `ids` resolver returns an array) and delivered as
**`null`** for a single-shaped result (`belongsTo`, `hasOne`, or an `ids` resolver that returns one
id) - `select` never sees a partial related row. Reactivity is pinpoint per item: when a required
field on a related row arrives, only the view items that included that row re-render - other items
keep their prior reference.

## Reactivity guarantees

Every write compiles into one apply-pipeline transaction that publishes pinpoint notifications
keyed by `(model, id, fields)` for row/field reads and by `(model, scopeKey)` for scope reads.
A write is visible to readers in the same tick - there are no async hops, debounces, or
query-cache round-trips on the write path. A patch to one field notifies only readers of that
field; an unrelated row, an unrelated field on the same row, and a scope the write did not join or
leave never re-render. Array reads (`use.where(...).rows()`, `scope.use`, `use.byIds(...).rows`)
keep referential identity for every untouched element, so a single-row patch never invalidates
memoized siblings.

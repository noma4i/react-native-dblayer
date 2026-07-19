# Queries

Two surfaces cover network reads. `Model.query(name, config)` compiles a GraphQL response into the
shared apply pipeline and writes it into a model or scope, so the result becomes a normal reactive
model read (see [reading.md](./reading.md)). `defineFetch` is the model-less counterpart: it runs a
query (or a custom fetcher) and hands back the selected payload directly, with no store
destination. Both are backed by TanStack Query, whose client is owned internally and provided by
`DbProvider` (see [getting-started.md](./getting-started.md#dbprovider)) - it is never re-exported.

## Contents

- [`Model.query(name, config)`](#modelqueryname-config)
- [`QueryResult`](#queryresult)
- [Live subscription colocation](#live-subscription-colocation)
- [`ScopeCoverage` semantics](#scopecoverage-semantics)
- [Loading state](#loading-state)
- [Error surfacing](#error-surfacing)
- [`defineFetch(config)`](#definefetchconfig)
- [`Model.fetch(name, config)`](#modelfetchname-config)

## `Model.query(name, config)`

```ts
const threadQuery = MessageModel.query('thread', {
  document: MessagesDocument,
  vars: (scope: { chatId: string }) => ({ chatId: scope.chatId }),
  page: data => data.messages, // infinite connection; use `select` for a single fetch
  into: MessageModel.scopes.thread,
  edge: node => ({ deliveredAt: node.deliveredAt }),
  extract: ({ nodes }) => [{ into: UserModel, rows: authorsOf(nodes) }],
  staleTime: 30_000,
  emptyStaleTime: 5_000
});

const { data, loadingState, error, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = threadQuery.use({ chatId });

await threadQuery.fetch({ chatId }); // one fetch outside React
threadQuery.invalidate({ chatId }); // clear the React Query cache for one scope
```

`name` sets the query's conventional cache-key namespace (`<modelId>:<name>`, overridable via
`key`) and its default write destination (the owning model itself, overridable via `into`).

### `QueryConfig`

| Option           | Type                                                   | Description                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document`       | GraphQL document                                       | The query document. `TResponse`/`TVars` are inferred from a `TypedDocumentNode`.                                                                                                      |
| `key`            | `string`                                               | Stable cache-key namespace. Defaults to `<modelId>:<name>`.                                                                                                                           |
| `vars`           | `(scope) => TVars`                                     | Derive GraphQL variables from the scope value passed to `use`/`fetch`.                                                                                                                |
| `page`           | `(data) => { nodes \| edges, pageInfo }`               | Infinite-connection selector for cursor pagination. Mutually exclusive with `select` - setting `page` makes `use` an infinite-query hook (`hasNextPage`/`fetchNextPage` become live). |
| `select`         | `(data) => unknown`                                    | Non-paginated payload selector for a single-fetch query. Mutually exclusive with `page`.                                                                                              |
| `into`           | `ScopeHandle \| Model`                                 | Write destination: a model's scope handle (scoped write, membership tracking) or a model directly. Defaults to the owning model.                                                      |
| `coverage`       | `ScopeCoverage`                                        | Membership reconciliation mode for scope destinations. Defaults to `'page'` when `page` is set, else `'complete'`. See [ScopeCoverage semantics](#scopecoverage-semantics) below.     |
| `edge`           | `(edgeSource) => Record<string, unknown> \| undefined` | Edge payload stored alongside a scope entry; receives the connection edge object (or the node itself for plain lists).                                                                |
| `extract`        | `(ctx: { data, nodes }) => ExtractSink[]`              | Cross-model sideloads applied in the SAME transaction as the main rows.                                                                                                               |
| `map`            | `(selected) => unknown`                                | Transform the selected/paged payload before it is split into nodes and written. Runs after `select`/`page`.                                                                           |
| `enabled`        | `(scope) => boolean`                                   | Gate network execution per scope value; `false` skips fetching while local reads stay live. Defaults to always enabled.                                                               |
| `staleTime`      | `number` (ms)                                          | Freshness window before a scope with data is considered stale and refetched. Defaults to `DbDefaults.staleTime`, then `0`.                                                            |
| `emptyStaleTime` | `number` (ms)                                          | Freshness window used instead of `staleTime` only when the last fetch for a scope returned zero rows.                                                                                 |
| `gcTime`         | `number` (ms)                                          | TanStack Query cache garbage-collection time for this query's cache entries.                                                                                                          |
| `maxPages`       | `number`                                               | Bounded page window retained by the underlying infinite query; older pages are dropped past this count.                                                                               |
| `refetchOnMount` | `boolean`                                              | Whether TanStack Query refetches on hook remount.                                                                                                                                     |
| `direction`      | `'forward' \| 'backward'`                              | Cursor pagination direction; `'backward'` reads `hasPreviousPage`/`startCursor` instead of the forward pair.                                                                          |
| `cursorVar`      | `string`                                               | GraphQL variable carrying the page cursor; defaults to `'after'` (`'before'` when backward).                                                                                          |
| `getCursor`      | `(page) => string \| null`                             | Override cursor extraction from a page; defaults to reading `pageInfo.endCursor`/`startCursor` per `direction`.                                                                       |
| `mapCursor`      | `(cursor: string) => unknown`                          | Transform the raw string cursor before it is substituted into the cursor variable (e.g. `Number` for numeric cursors).                                                                |
| `live`           | `Record<string, ModelIngestEntry>`                     | Colocated live subscription entries, activated while a reader is mounted. See [Live subscription colocation](#live-subscription-colocation) below.                                    |

`Model.query` returns `{ use, fetch, invalidate }`:

- `use(scope, opts?)` is a hook - a single-fetch hook when `page` is omitted, an infinite-query hook
  when `page` is set - returning a `QueryResult`.
- `fetch(scope)` runs one fetch outside React, applying the response through the same pipeline.
- `invalidate(scope?)` clears the React Query cache for one scope, or every registered scope when
  `scope` is omitted.

### Vibe switch with previous scope rows

For a feed-style key switch, keep the network query and local rendering responsibilities separate:
the query continues writing each response into its keyed scope, while the screen reads
`Model.scopes.feed.useWindow({ vibeId }, { keepPrevious: true })` (see
[reading.md](./reading.md#scope-reads)). Until the new vibe produces rows or confirms an empty
response, the window returns the prior non-empty rows with `isPreviousData: true`; the first
resolved snapshot switches permanently to the new key. This option is deliberately off by default
and must not be used for account or detail switches where previous identity data would be unsafe.

### `QueryResult`

| Field                | Type                    | Description                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`               | `T[] \| T \| undefined` | Reactive read of the write destination (`config.into`); `undefined` before any successful write.                                                                                                                                                                                                                                                                                            |
| `loadingState`       | `LoadingState`          | UI loading-state machine derived from fetch status and whether `data` has rows. See [Loading state](#loading-state) below.                                                                                                                                                                                                                                                                  |
| `error`              | `Error \| null`         | The last fetch/next-page error, or `null`. Cleared on the next successful fetch.                                                                                                                                                                                                                                                                                                            |
| `hasNextPage`        | `boolean`               | `true` when another page is available. Always `false` for single (non-`page`) queries.                                                                                                                                                                                                                                                                                                      |
| `isFetchingNextPage` | `boolean`               | `true` while a next-page fetch is in flight. Always `false` for single (non-`page`) queries.                                                                                                                                                                                                                                                                                                |
| `fetchNextPage`      | `() => void`            | Fetch and apply the next page over the network. A no-op for single queries. This is **server-side** pagination - a different concept from a scope's `ScopeHandle.useWindow(...).fetchNextPage` (local window growth over already-synced rows; see [reading.md](./reading.md#scope-reads)), even though both surfaces share the `fetchNextPage` name. A paginated list typically wires both. |
| `refetch`            | `() => Promise<void>`   | Re-run the query from the first page, replacing `data`.                                                                                                                                                                                                                                                                                                                                     |

### Live subscription colocation

```ts
const threadQuery = MessageModel.query('thread', {
  document: MessagesDocument,
  vars: (scope: { chatId: string }) => ({ chatId: scope.chatId }),
  select: data => data.messages,
  into: MessageModel.scopes.thread,
  live: {
    messageCreated: { document: MessageCreatedDocument, handler: payload => ({ upsert: payload.message }) }
  }
});

const { data } = threadQuery.use({ chatId }); // mounting subscribes; unmounting may stop
threadQuery.live.apply('messageCreated', { message }); // manual injection, same pipeline
```

`live` is a `Record<string, ModelIngestEntry>` - the identical entry shape
[`Model.ingest`](./ingest-live.md#modelingestentries) accepts, so every guard, `echoGuard`, effect,
and error-containment rule documented there applies unchanged here, delivered through the same
model ingest pipeline. Passing `live` picks the `Model.query` overload whose return type adds a
`live: LiveQueryHandle` member (`{ apply(event, payload) }`); omitting `live` entirely picks the
plain overload, whose return has no `live` member at all - at the type level and at runtime.

**Lifecycle.** The colocated subscription is refcounted by mounted `use` readers, not by the query
itself: the first `use()` mount activates it (lazily creating one `createDbSubscriptionRuntime` over
the query's compiled `live` entries), each further mount only increments the reader count, and the
subscription deactivates only when the LAST mounted reader unmounts - overlapping readers of the
same query share exactly ONE transport subscription. `fetch(scope)` never touches this refcount or
activates anything; it is a plain one-shot network call that never subscribes.

**Reset.** `resetRuntime()` (see [runtime.md](./runtime.md#resetruntime-kill-switch)) deactivates
and drops the query's live runtime immediately. If every reader was already unmounted, nothing more
happens - a payload delivered to the old (now deactivated) subscriber handle after this point writes
nothing. If a reader is still mounted when `resetRuntime()` runs, the drop is followed by an
immediate resync: a fresh runtime is created and reactivated for the mounted reader, so subscription
delivery resumes transparently across a reset.

**`live.apply(event, payload)`.** Injects a payload through the exact same guarded pipeline
(`ModelIngestEntry`'s `guard`/`echoGuard`/`debounce`/`effect`/`apply`) that a real transport
subscription event uses - `list.live.apply('messageCreated', payload)` and
`MessageModel.ingest({ messageCreated: {...} }).apply('messageCreated', payload)` commit identical
rows for identical entries. Handy for tests, or for a transport delivering live events outside
`createDbSubscriptionRuntime`.

## `ScopeCoverage` semantics

`ScopeCoverage` controls how an incoming batch of rows reconciles against a scope's existing membership:

| ScopeCoverage | Behavior                                                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'complete'`  | Incoming rows become the exact membership, in server order; previous members absent from the response are detached (their entity rows are untouched, only scope membership drops).                                                                                           |
| `'page'`      | Incoming rows upsert into membership - existing members keep their order, new ones append in server order; nothing is detached. A first-page refetch (`resetOrder`) makes incoming rows the new head order, with previous members kept, in their relative order, after them. |
| `'delta'`     | Same merge semantics as `'page'`, used for single-row/subscription-driven updates.                                                                                                                                                                                           |

## Loading state

`QueryResult.loadingState` and `FetchResult.loadingState` share one `LoadingState` shape, derived
internally from the current fetch phase and whether `data` has rows:

| Field                  | Type                                                                                                                  | True when                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `phase`                | `LoadingPhase` (`'idle' \| 'hydrating' \| 'initial_loading' \| 'ready' \| 'refreshing' \| 'loading_more' \| 'error'`) | The underlying fetch state machine's current phase.                               |
| `hasData`              | `boolean`                                                                                                             | `data` has at least one row (array results) or is defined (single results).       |
| `isReady`              | `boolean`                                                                                                             | The UI can show ready data - `hasData` and not in an error/initial-loading phase. |
| `showSkeleton`         | `boolean`                                                                                                             | The initial empty-and-loading state - show a skeleton, not a spinner.             |
| `showData`             | `boolean`                                                                                                             | Primary data should render.                                                       |
| `showEmptyState`       | `boolean`                                                                                                             | A confirmed-empty result should render an empty state.                            |
| `showRefreshIndicator` | `boolean`                                                                                                             | A pull/refresh indicator should be visible (refetch of already-loaded data).      |
| `showFooterSpinner`    | `boolean`                                                                                                             | `phase === 'loading_more'` - a pagination footer spinner should be visible.       |
| `showErrorBanner`      | `boolean`                                                                                                             | A non-blocking error banner should be visible alongside stale data.               |

## Error surfacing

A transport failure surfaces on the status surface's `error` field (and `FetchResult.error` for
`defineFetch`) and is separately reported to `DbDefaults.onSyncError` with `{ source: 'query' }`
(see [getting-started.md](./getting-started.md#onsyncerror-policy)), so app-wide error tracking does
not need to be wired into every screen individually. `onSyncError` observes the failure; it never
changes the query's own control flow.

## `defineFetch(config)`

Ephemeral, model-less fetch: runs a query (or a custom fetcher) and hands back the selected payload
directly, with no `into` destination. The response never reaches the apply pipeline, never writes a
journal record, and never touches a `dbl:` storage key. Use it for display-only data that does not
belong to any single model and has no local reactive read of its own (pricing tables, country
lists, SKU catalogs) where a `Model.query` write destination would be pure overhead.

```ts
import { defineFetch } from '@noma4i/react-native-dblayer';

const skuPricing = defineFetch({
  document: SkuPricingDocument,
  key: 'sku-pricing',
  vars: (input: { sku: string }) => ({ sku: input.sku }),
  select: data => data.pricing,
  staleTime: 60_000
});

const countryList = defineFetch({
  fetcher: () => restClient.get('/countries').then(r => r.json()),
  key: 'country-list',
  select: data => data as Country[]
});

const { data, loadingState, error, refetch } = skuPricing.use({ sku });
const pricing = await skuPricing.fetch({ sku }); // one fetch outside React, throws on failure
skuPricing.remove(); // drop every cached input for this key
```

### `FetchConfig`

`document` and `fetcher` are mutually exclusive - exactly one is required; `defineFetch` throws
`defineFetch requires exactly one of document or fetcher` at boot-validation time otherwise (see
[getting-started.md](./getting-started.md#bootdboptions--suspenddb)).

| Option      | Type                                         | Description                                                                                                        |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `document`  | GraphQL document                             | The query document, executed against the configured `DbTransport`. `TData` is inferred from a `TypedDocumentNode`. |
| `fetcher`   | `(input: TInput) => Promise<TData>`          | Execute a store-free request without a GraphQL transport operation - any promise-returning fetch.                  |
| `key`       | `string`                                     | Stable cache-key namespace for this fetch, combined with a hash of the input.                                      |
| `select`    | `(data: TData) => TSelected`                 | Pick the payload to expose as `data`; the raw response is never returned.                                          |
| `vars`      | `(input: TInput) => Record<string, unknown>` | Derive GraphQL variables from the hook/imperative call input (`document` form only). Omit for input-less queries.  |
| `enabled`   | `(input: TInput) => boolean`                 | Gate `use(input)`'s automatic network fetch; `false` keeps the hook network-idle. Does not affect `fetch(input)`.  |
| `staleTime` | `number` (ms)                                | Freshness window before a result is considered stale and refetched. Defaults to `DbDefaults.staleTime`, then `0`.  |
| `gcTime`    | `number` (ms)                                | TanStack Query cache garbage-collection time. Defaults to `DbDefaults.gcTime`.                                     |

`defineFetch` returns `{ use, fetch, remove }`:

- `use(input)` is a hook returning a `FetchResult`.
- `fetch(input)` runs one fetch outside React through the owned query client and resolves to the
  selected payload, throwing on transport/`fetcher` failure.
- `remove()` drops every cached input for this fetch's `key` from the query cache.

### `FetchResult`

| Field          | Type                     | Description                                                                                              |
| -------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `data`         | `TSelected \| undefined` | The selected payload; `undefined` before the first successful fetch.                                     |
| `loadingState` | `LoadingState`           | UI loading-state machine. See [Loading state](#loading-state) above.                                     |
| `error`        | `unknown`                | The last fetch error, or `null`.                                                                         |
| `refetch`      | `() => void`             | Re-run the fetch, replacing `data` on success. Does not return a promise - `await fetch(input)` instead. |

`defineFetch` reports transport failures to `DbDefaults.onSyncError` with `{ source: 'query' }`,
same as `Model.query`.

## `Model.fetch(name, config)`

A model-scoped wrapper over `defineFetch`: identical config (including the `document`/`fetcher`
choice and `remove()`) and `{ use, fetch, remove }` -> `FetchResult` surface, with `key` defaulting
to `<modelId>:<name>` instead of being required. Use it for a fetch that conceptually belongs to one
model (e.g. a model-specific aggregate) but still wants no local store write of its own.

```ts
const unreadSummary = MessageModel.fetch('unread-summary', {
  document: UnreadSummaryDocument,
  vars: (chatId: string) => ({ chatId }),
  select: data => data.unreadSummary
});
```

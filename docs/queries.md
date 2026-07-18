# Queries

Two DSLs cover network reads. `defineQuery` compiles a GraphQL response into the shared apply
pipeline and writes it into a model or scope, so the result becomes a normal reactive model read.
`defineFetch` is the ephemeral counterpart: it runs a query and hands back the selected payload
directly, with no store destination. Both are backed by TanStack Query, whose shared client/provider
live in [configuration.md](./configuration.md#react-query-passthrough).

## `defineQuery(config)`

```ts
import { defineQuery } from '@noma4i/react-native-dblayer';

const chatThreadQuery = defineQuery({
  document: MessagesDocument,               // cache key defaults to the operation name
  vars: (scope: { chatId: string }) => ({ chatId: scope.chatId }),
  page: data => data.messages,               // infinite connection; use `select` for a single fetch
  into: MessageModel.scopes.thread,
  edge: node => ({ deliveredAt: node.deliveredAt }),
  extract: ({ nodes }) => [{ into: UserModel, rows: authorsOf(nodes) }],
  staleTime: 30_000,
  emptyStaleTime: 5_000
});

const { data, loadingState, error, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
  chatThreadQuery.use({ chatId });

await chatThreadQuery.fetch({ chatId });      // one fetch outside React
chatThreadQuery.invalidate({ chatId });       // clear the React Query cache for one scope
```

### `QueryConfig`

| Option | Type | Description |
| --- | --- | --- |
| `document` | GraphQL document | The query document. `TResponse`/`TVars` are inferred from a `TypedDocumentNode`. |
| `key` | `string` | Stable cache-key namespace; defaults to the document's operation name. |
| `vars` | `(scope) => TVars` | Derive GraphQL variables from the scope value passed to `use`/`fetch`. |
| `page` | `(data) => { nodes \| edges, pageInfo }` | Infinite-connection selector for cursor pagination. Mutually exclusive with `select` - setting `page` makes `use` an infinite-query hook (`hasNextPage`/`fetchNextPage` become live). |
| `select` | `(data) => unknown` | Non-paginated payload selector for a single-fetch query. Mutually exclusive with `page`. |
| `into` | `ScopeHandle \| Model` | Write destination: a model's scope handle (scoped write, membership tracking) or a model directly. |
| `coverage` | `Coverage` | Membership reconciliation mode for scope destinations. Defaults to `'page'` when `page` is set, else `'complete'`. See Coverage semantics below. |
| `edge` | `(edgeSource) => Record<string, unknown> \| undefined` | Edge payload stored alongside a scope entry; receives the connection edge object (or the node itself for plain lists). |
| `extract` | `(ctx: { data, nodes }) => ExtractSink[]` | Cross-model sideloads applied in the SAME transaction as the main rows. |
| `map` | `(selected) => unknown` | Transform the selected/paged payload before it is split into nodes and written. Runs after `select`/`page`. |
| `enabled` | `(scope) => boolean` | Gate network execution per scope value; `false` skips fetching while local reads stay live. Defaults to always enabled. |
| `staleTime` | `number` (ms) | Freshness window before a scope with data is considered stale and refetched. Defaults to `DbDefaults.staleTime`, then `0`. |
| `emptyStaleTime` | `number` (ms) | Freshness window used instead of `staleTime` only when the last fetch for a scope returned zero rows. |
| `gcTime` | `number` (ms) | TanStack Query cache garbage-collection time for this query's cache entries. |
| `maxPages` | `number` | Bounded page window retained by the underlying infinite query; older pages are dropped past this count. |
| `refetchOnMount` | `boolean` | Whether TanStack Query refetches on hook remount. |
| `direction` | `'forward' \| 'backward'` | Cursor pagination direction; `'backward'` reads `hasPreviousPage`/`startCursor` instead of the forward pair. |
| `cursorVar` | `string` | GraphQL variable carrying the page cursor; defaults to `'after'` (`'before'` when backward). |
| `getCursor` | `(page) => string \| null` | Override cursor extraction from a page; defaults to reading `pageInfo.endCursor`/`startCursor` per `direction`. |
| `mapCursor` | `(cursor: string) => unknown` | Transform the raw string cursor before it is substituted into the cursor variable (e.g. `Number` for numeric cursors). |

`defineQuery` returns `{ use, fetch, invalidate }`:

- `use(scope, opts?)` is a hook - a single-fetch hook when `page` is omitted, an infinite-query hook
  when `page` is set - returning a `QueryResult`.
- `fetch(scope)` runs one fetch outside React, applying the response through the same pipeline.
- `invalidate(scope?)` clears the React Query cache for one scope, or every registered scope when
  `scope` is omitted.

### `QueryResult`

| Field | Type | Description |
| --- | --- | --- |
| `data` | `T[] \| T \| undefined` | Reactive read of the write destination (`config.into`); `undefined` before any successful write. |
| `loadingState` | `LoadingState` | UI loading-state machine derived from fetch status and whether `data` has rows. |
| `error` | `Error \| null` | The last fetch/next-page error, or `null`. Cleared on the next successful fetch. |
| `hasNextPage` | `boolean` | `true` when another page is available. Always `false` for single (non-`page`) queries. |
| `isFetchingNextPage` | `boolean` | `true` while a next-page fetch is in flight. Always `false` for single (non-`page`) queries. |
| `fetchNextPage` | `() => void` | Fetch and apply the next page over the network. A no-op for single queries. This is **server-side** pagination - a different concept from a scope's `ScopeHandle.useWindow(...).fetchNextPage` (local window growth over already-synced rows; see [models.md](./models.md#scopehandle)), even though both surfaces share the `fetchNextPage` name. A paginated list typically wires both. |
| `refetch` | `() => Promise<void>` | Re-run the query from the first page, replacing `data`. |

### Coverage semantics

`Coverage` controls how an incoming batch of rows reconciles against a scope's existing membership:

| Coverage | Behavior |
| --- | --- |
| `'complete'` | Incoming rows become the exact membership, in server order; previous members absent from the response are detached (their entity rows are untouched, only scope membership drops). |
| `'page'` | Incoming rows upsert into membership - existing members keep their order, new ones append in server order; nothing is detached. A first-page refetch (`resetOrder`) makes incoming rows the new head order, with previous members kept, in their relative order, after them. |
| `'delta'` | Same merge semantics as `'page'`, used for single-row/subscription-driven updates. |

### Error surfacing

A transport failure surfaces on `QueryResult.error` (and `FetchResult.error` for `defineFetch`) and
is separately reported to `DbDefaults.onSyncError` with `{ source: 'query' }` (see
[configuration.md](./configuration.md#onsyncerror-policy)), so app-wide error tracking does not
need to be wired into every screen individually. `onSyncError` observes the failure; it never
changes the query's own control flow.

## `defineFetch(config)`

Ephemeral, store-free fetch: runs a query and hands back the selected payload directly, with no
`into` destination. The response never reaches the apply pipeline, never writes a journal record,
and never touches a `dbl:` storage key. Use it for display-only data with no local reactive read of
its own (pricing tables, country lists, SKU catalogs) where a `defineQuery` write destination would
be pure overhead.

```ts
import { defineFetch } from '@noma4i/react-native-dblayer';

const skuPricing = defineFetch({
  document: SkuPricingDocument,
  key: 'sku-pricing',
  vars: (input: { sku: string }) => ({ sku: input.sku }),
  select: data => data.pricing,
  staleTime: 60_000
});

const { data, loadingState, error, refetch } = skuPricing.use({ sku });
const pricing = await skuPricing.fetch({ sku });   // one fetch outside React, throws on failure
```

### `FetchConfig`

| Option | Type | Description |
| --- | --- | --- |
| `document` | GraphQL document | The query document. `TData` is inferred from a `TypedDocumentNode`. |
| `key` | `string` | Stable cache-key namespace for this fetch, combined with a hash of the input. |
| `select` | `(data: TData) => TSelected` | Pick the payload to expose as `data`; the raw response is never returned. |
| `vars` | `(input: TInput) => Record<string, unknown>` | Derive GraphQL variables from the hook/imperative call input. Omit for input-less queries. |
| `enabled` | `(input: TInput) => boolean` | Gate `use(input)`'s automatic network fetch; `false` keeps the hook network-idle. Does not affect `fetch(input)`. |
| `staleTime` | `number` (ms) | Freshness window before a result is considered stale and refetched. Defaults to `DbDefaults.staleTime`, then `0`. |
| `gcTime` | `number` (ms) | TanStack Query cache garbage-collection time. Defaults to `DbDefaults.gcTime`. |

`defineFetch` returns `{ use, fetch }`: `use(input)` is a hook returning a `FetchResult`; `fetch(input)`
runs one fetch outside React and resolves to the selected payload, throwing on transport failure.

### `FetchResult`

| Field | Type | Description |
| --- | --- | --- |
| `data` | `TSelected \| undefined` | The selected payload; `undefined` before the first successful fetch. |
| `loadingState` | `LoadingState` | UI loading-state machine derived from fetch status and whether `data` is present. |
| `error` | `unknown` | The last fetch error, or `null`. |
| `refetch` | `() => void` | Re-run the fetch, replacing `data` on success. Does not return a promise - `await fetch(input)` instead. |

`defineFetch` reports transport failures to `DbDefaults.onSyncError` with `{ source: 'query' }`,
same as `defineQuery`.

## Stable view and list hooks

Read helpers that keep derived arrays and view objects referentially stable across renders, so
components memoized on identity skip re-rendering for changes they do not display.

| Export | Signature | Role |
| --- | --- | --- |
| `useStableProjection` | `(sources, config) => TItem[]` | Projects a stable item list: owns an entry cache keyed by `getKey` (defaults to `source.id`), reuses cached entries whose `entriesEqual` (or `renderKeys`) still holds, and returns the previous array reference when every item is unchanged. |
| `useStableEntity` | `(value, config) => TItem \| null \| undefined` | Reuses one entity reference while configured fields (`renderKeys` or all-but-`volatileKeys`) remain equal. |
| `useStableSorted` | `(source, compare, invalidationKey?) => T[]` | Memoizes sorted output and reuses it for element-identical input arrays, resorting only when `source` or `invalidationKey` changes. |
| `pickEqual` | `(prev, next, keys) => boolean` | Shared value-equality: deep-compares only the listed keys. The building block behind `useStableProjection`'s `renderKeys` and `useStableEntity`'s `renderKeys`. |
| `EMPTY_IDS` | `string[]` | Shared immutable empty id list for stable fallback reads. |
| `createUniqueIds` | `(ids) => string[]` | Returns unique non-empty ids in first-seen order. |
| `computeLoadingState` | `(phase, hasData) => LoadingState` | Converts a loading phase plus data presence into UI display flags (`showSkeleton`, `showEmptyState`, `showRefreshIndicator`, ...). Exported so a screen composing a custom loading state from multiple hook results can reuse the package's own derivation. |
| `computePhase` | `(input: ComputePhaseInput) => LoadingPhase` | Computes the current loading phase (`'idle' \| 'hydrating' \| 'initial_loading' \| 'ready' \| 'refreshing' \| 'loading_more' \| 'error'`) from query and collection state. |

`LoadingState`, `DbWhere<T>`, and `StableProjectionConfig` are the corresponding public types:
`LoadingState` is the object `computeLoadingState` returns and every `QueryResult`/`FetchResult`
exposes as `loadingState`; `DbWhere<T>` is the predicate type accepted by every model `where`/`getWhere`
read (see [models.md](./models.md#reads)); `StableProjectionConfig` is the config shape
`useStableProjection` accepts (`getKey`, `buildEntry`, `emptyItems`, `entriesEqual`).

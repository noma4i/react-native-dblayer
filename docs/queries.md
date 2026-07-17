# Queries

The query DSL runs a GraphQL operation, writes the result into a collection, and hands back the reactive read.
DBLay owns the `@tanstack/react-query` version and exports `QueryClient`, `QueryClientProvider`,
`focusManager`, `useQuery`, and `useQueryClient` from `@noma4i/react-native-dblayer` for the host app. The query
cache is not model storage: DBLay rows stay in DBLay planes.

## `useDbSingleRequest(config)`

Full example — fetch one user, store it, render the reactive row:

```tsx
import { useDbSingleRequest } from '@noma4i/react-native-dblayer';
import { ActivityIndicator, Text } from 'react-native';
import { USER_QUERY } from './operations'; // graphql-codegen TypedDocumentNode

function UserCard({ id }: { id: string }) {
  const { data: user, isLoading, loadingState } = useDbSingleRequest({
    query: USER_QUERY,                            // types inferred from the document
    vars: { id },
    select: (d) => d.user,                        // pick the payload
    sync: { model: UserModel, contract: 'user' }, // write it into UserModel
    read: { model: UserModel, id },               // read it back reactively
  });

  if (loadingState.showSkeleton) return <ActivityIndicator />;
  return <Text>{user?.name}</Text>;
}
```

Because it wrote into `UserModel`, any other component now reads the same row for free:

```tsx
function OnlineDot({ id }: { id: string }) {
  const user = UserModel.find(id); // no fetch; re-renders on change
  return user?.isOnline ? <Dot /> : null;
}
```

### `modelDetailRequest(model, config)`

Use this builder for standard "fetch one node, write it to the same model, read it back by id" requests. Raw
`useDbSingleRequest` configs remain supported for custom flows.

```tsx
import { modelDetailRequest, useDbSingleRequest } from '@noma4i/react-native-dblayer';

const user = useDbSingleRequest(
  modelDetailRequest(UserModel, {
    query: USER_QUERY,
    id: userId,
    select: (d) => d.user,
    contract: 'profile',
    staleTime: Infinity,
  })
);
```

The builder derives:

| Field | Derived value |
| --- | --- |
| `key` | model-scoped DB query key; explicit `key` wins. |
| `vars` | `{ id }`; pass `vars: (id) => ({ momentId: id })` or an object for custom variable names. |
| `sync` | `{ model, contract: config.contract ?? 'detail' }`. |
| `read` | `{ model, id }`; pass `read: false` for select-only detail lookups such as public uuid routes. |
| `enabled` | `Boolean(id) && callerEnabled`; `enabled` may be a boolean or `(id) => boolean`. |

No-read variant:

```ts
modelDetailRequest(UserModel, {
  query: USER_BY_UUID_QUERY,
  id: uuid,
  select: (d) => d.user,
  vars: (id) => ({ id, first: 1 }),
  contract: 'deepLink',
  read: false,
});
```

### `DbRequestSingleConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | `TypedDocumentNode<TResponse, TVars> \| DocumentNode` | **required** | The GraphQL query. Types flow from a `TypedDocumentNode`. |
| `key` | `readonly unknown[]` | derived when model-backed | React Query cache key. Explicit keys win. |
| `select` | `(data: TResponse) => TSelected` | identity | Pick the payload (e.g. `d => d.user`). Omit to use the full response data. |
| `vars` | `TVars` | `—` | Query variables. |
| `map` | `(selected) => TResult` | identity | Transform the payload before writing/returning. |
| `sync` | `{ model, contract: string } \| ((selected) => void)` | `—` | Where to write. `{ model, contract }` merges into the model under the `contract` label; a function writes manually. |
| `extract` | `({ data, selected }) => unknown` | `—` | Side-load payload → extract sink (source `'query'`). |
| `extractSource` | `string` | `'query'` | Source label passed to the extract sink. |
| `read` | `{ model, id } \| { model }` | `—` | Reactive read returned: `{ model, id }` = one row, `{ model }` = `all()`. |
| `enabled` | `boolean` | `true` | `false` disables network execution and fetch scheduling. Local model reads stay live: rows produce `ready`, no rows produce `idle` without skeleton. |
| `staleTime` | `number` (ms) | TanStack Query | Freshness window. |
| `emptyStaleTime` | `number` (ms) | `0` | Known-empty DB fetch-state skip window. Not passed to React Query. |
| `gcTime` | `number` (ms) | TanStack Query | Cache GC time. |
| `refetchOnMount` | `boolean` | TanStack Query | Refetch on remount. |

### Freshness gate resolution

| Knob | Resolution | Default | Meaning |
| --- | --- | --- | --- |
| `staleTime` | request config > model config > package default | `0` = DB gate off for non-empty scopes | DB fetch-state skip window for scopes with rows. Request `staleTime` is still passed to React Query unchanged. |
| `emptyStaleTime` | request config > model config > package default | `0` = known-empty scopes never skip | DB fetch-state skip window only when stored fetch-state has `empty === true`. Not passed to React Query. |

Writing a list into a collection and reading it all back:

```tsx
function Members({ teamId }: { teamId: string }) {
  const { loadingState } = useDbSingleRequest({
    query: MEMBERS_QUERY,
    vars: { teamId },
    select: (d) => d.team.members,               // User[]
    sync: { model: UserModel, contract: 'members' },
    read: { model: UserModel },                  // read all() reactively
    staleTime: 60_000,
  });
  const members = UserModel.all();
  if (loadingState.showEmptyState) return <Empty />;
  return <FlatList data={members} renderItem={/* ... */} />;
}
```

Side-loading related entities with `extract` (needs the extract seam wired — see
[Configuration](./configuration.md#extract-seam)):

```ts
useDbSingleRequest({
  query: POST_QUERY, vars: { id },
  select: (d) => d.post,
  sync: { model: PostModel, contract: 'post' },
  extract: ({ selected }) => ({ users: [selected.author] }), // author lands in UserModel via the sink
  read: { model: PostModel, id },
});
```

### Returns — `BaseQueryResult<TResult>`

The full `@tanstack/react-query` `UseQueryResult` (`data`, `isLoading`, `isError`, `error`, `refetch`, …) **plus** a
`loadingState` UI state machine:

```ts
loadingState: {
  phase: 'idle' | 'hydrating' | 'initial_loading' | 'ready' | 'refreshing' | 'loading_more' | 'error';
  hasData; isReady; showSkeleton; showData; showEmptyState;
  showRefreshIndicator; showFooterSpinner; showErrorBanner;
}
```

```tsx
const { loadingState } = useDbSingleRequest(/* ... */);
if (loadingState.showSkeleton)   return <Skeleton />;
if (loadingState.showErrorBanner) return <ErrorBanner />;
if (loadingState.showEmptyState) return <Empty />;
return <Content />;
```

## `useDbInfiniteRequest(config)`

Cursor-paginated connections. Each page's nodes are written into a collection.

```tsx
function Feed() {
  const { items, loadingState, loadMore, hasNextPage } = useDbInfiniteRequest({
    query: FEED_QUERY,
    selectPage: (d) => d.feed,                       // -> { edges | nodes, pageInfo }
    getCursor: (d) => d.feed.pageInfo.endCursor,
    getPageVars: (after) => ({ after }),
    read: feedCollectionBinding,                     // collection that stores page nodes
  });

  return (
    <FlatList
      data={items}
      keyExtractor={(n) => n.id}
      onEndReached={() => hasNextPage && loadMore()}
      ListFooterComponent={loadingState.showFooterSpinner ? <Spinner /> : null}
      renderItem={/* ... */}
    />
  );
}
```

### `DbRequestInfiniteConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | `TypedDocumentNode<TResponse, TVars> \| DocumentNode` | **required** | The paginated query. |
| `key` | `readonly unknown[]` | derived from collection binding | React Query key. Explicit keys win. |
| `selectPage` | `(data) => ConnectionWithNodes \| ConnectionWithEdges \| null` | **required** | Pick the connection (`{ nodes, pageInfo }` or `{ edges, pageInfo }`). |
| `read` | collection binding | **required** | Stores page nodes; read back reactively. |
| `vars` | `TVars` | `—` | Base variables. |
| `scope` | `object \| () => object` | `—` | Scope values merged into variables and used as the read/write filter when `filter` is omitted. |
| `getPageVars` | `(pageParam: string) => Record<string, unknown>` | `—` | Cursor → next page's variables. |
| `getCursor` | `(data) => string \| number \| null` | `—` | Next cursor from a page. |
| `patchNode` | `(node, { index, globalIndex, pageParam }) => Partial \| null` | `—` | Decorate each node before storing. `globalIndex` resets on initial-page fetches and increments across loaded pages. |
| `extract` | `({ data, nodes }) => unknown` | `—` | Side-load payload (extract sink, source `'query'`). |
| `extractSource` | `string` | `'query'` | Source label passed to the extract sink. |
| `resolveSyncContract` | `(ctx) => SyncContract` | replace initial page, merge loaded pages | Override how each page is written. Use `mergeInitialSyncContract` when initial pages should merge instead of replace. |
| `readMode` | `'data' \| 'none'` | `'data'` | `'none'` when a view hook owns the reactive read. |
| `filter` | `() => unknown` | `—` | Scope filter for the read. |
| `currentUserId` | `() => string \| undefined` | `—` | Scope-key input. |
| `direction` | `'forward' \| 'backward'` | `'forward'` | Pagination direction. |
| `enabled` / `staleTime` / `emptyStaleTime` / `gcTime` / `refetchOnMount` | | `true` / see freshness table / TanStack Query | As above. |
| `maxPages` | `number` | `none` | Bounded page window retained by TanStack `useInfiniteQuery`. |

Infinite requests derive omitted keys from `createCollectionBinding(model, { scopeMap })` and the runtime
`filter`/`currentUserId` scope. Pass an explicit `key` for non-model-backed reads.

When `scope` is provided, the runtime merges it into query variables before `vars`, so explicit `vars` win on
conflicts. If `filter` is omitted, the same `scope` becomes the collection read/write filter:

```ts
const chatCollection = createCollectionBinding(ChatModel, {
  sortField: 'lastActivityAt',
  scopeMap: { statusFilter: 'status' },
});

useDbInfiniteRequest({
  query: CHATS_QUERY,
  selectPage: (d) => d.chats,
  vars: { first: 20 },
  scope: { statusFilter },
  read: chatCollection,
});
```

That is equivalent to `vars: { statusFilter, first: 20 }` plus `filter: () => ({ statusFilter })`. Explicit
`filter` still wins over `scope`, which keeps raw configs a first-class escape hatch for scopes whose server
variables do not match the collection scope vocabulary.

By default, an initial page writes `replaceSyncContract('initial', scope)` and a loaded page writes
`mergeSyncContract('loadMore', scope)`. Pass `resolveSyncContract: mergeInitialSyncContract` for append-only
scopes where the initial page should merge with existing rows while still tagging sources as `'initial'` or
`'loadMore'`.

### `createCollectionBinding(model, options)`

Bindings connect an infinite request to a model. They own collection writes, freshness scopes, and reactive reads.

| Option | Description |
| --- | --- |
| `scopeMap` | Maps request/filter keys to stored-row fields for scoped reads, freshness, and scoped replace filters. |
| `sortField` / `sortDirection` | Field ordering for the bound read. `sortDirection` defaults to `'desc'`. |
| `comparator` | Custom row comparator for canonical ordering. Mutually exclusive with `sortField`. |
| `useData` | Override hook for read projections. Receives `{ filter, scope, rows, empty }`; return `empty` for stable no-data output. |

For scoped bindings, explicit nullish reads return no rows: `binding.useData(null)` and `binding.useData(undefined)`
return a stable empty array, and `binding.count(null)` / `binding.count(undefined)` return `0`. Unscoped
`binding.useData()` and `binding.count()` still read the full collection.

## Imperative requests

```ts
import { invalidateDbRequests, invalidateModel, resetDbQueryRuntime } from '@noma4i/react-native-dblayer';

invalidateModel(MessageModel, { chatId });                      // fetch-state clear + React Query invalidation
await invalidateDbRequests(['messages', chatId]);                // explicit React Query key invalidation
await resetDbQueryRuntime();                                    // cancel all queries, then clear cache
```

These helpers use the `queryClient` passed to `configureDb`. Without one, they no-op and log through the package
logger. Hooks still read the React Query client from React context.

`invalidateModel(model, scope?)` first clears DB fetch-state (`model.clearFetchState(scope)` for a scoped call,
or every persisted fetch-state record for that model when unscoped), then invalidates the derived React Query key.
Mounted hooks subscribe to fetch-state changes, so a freshness-gated request can fetch after `invalidateModel`.
`invalidateDbRequests(key)` is intentionally React Query only and does not clear DB fetch-state.

### Returns — `InfiniteQueryResult<TNode>`

| Field | Type | Description |
| --- | --- | --- |
| `data` | `TNode[]` | Accumulated nodes (reactive). |
| `loadingState` | `LoadingState` | UI state machine (as above). |
| `hasNextPage` | `boolean` | Another page exists. |
| `isFetchingNextPage` | `boolean` | A page load is in flight. |
| `isBackgroundFetching` | `boolean` | Background refresh running. |
| `loadMore` | `() => void` | Load the next page. |
| `refetch` | `() => Promise<void>` | Re-run from the first page. |

## Non-React execution

Run the same configs outside React (services, preloads):

```ts
import { runDbInfiniteQueryDirect, runDbQueryDirect } from '@noma4i/react-native-dblayer';

await runDbQueryDirect({ key: ['user', id], query: USER_QUERY, vars: { id }, select: (d) => d.user,
  sync: { model: UserModel, contract: 'user' } });

await runDbInfiniteQueryDirect(feedConfig, /* pageParam */ undefined);
```
`runDbQueryDirect` is the one-shot counterpart to `useDbSingleRequest`. It ignores hook-only fields such as `key`,
`enabled`, `staleTime`, `gcTime`, and `refetchOnMount`; the request runs immediately. When `select` is
omitted, the full response data is used as the selected payload.

When `key` is omitted in hooks, model-backed single requests derive it from `read.model`, `read.id`, or `sync.model`
as `['db', collectionId]` or `['db', collectionId, stableSerialize(scope)]`. Hook configs without an explicit key
and without a model-backed `read` or `sync.model` throw a config error.

## Stable View and List Hooks

Collection emissions often create fresh arrays and row objects even when rendered fields did not change. These hooks
preserve item and array references for list UIs.

| API | Purpose |
| --- | --- |
| `buildStableItems(source, config, previousCache)` | Non-React core; reuses prior entry items when `entriesEqual` passes. |
| `useStableItems(source, config)` | Hook wrapper; owns the entry cache, writes it back, and reuses the previous array when item refs are element-identical. |
| `useStableEntity(value, config)` | Single-row identity guard; returns the prior entity while configured fields are equal. |
| `useStableSorted(source, compare, invalidationKey?)` | Sorts without mutating `source`; reuses previous sorted output when source item refs and optional key are unchanged. |
| `useOrderedEntities(model, ids)` | Reads `model.byIds(ids)`, returns entities in input id order, drops missing ids, and shares a stable empty array. |
| `useEntitiesById(model, ids)` | Reads `model.byIds(ids)` and returns a stable `Map<string, row>` keyed by id. |
| `useJoinedEntities(config)` | Joins model rows by id across two model sources while preserving stable output identity. |
| `useWindowedLoadMore(loadMore, refresh, pageSize, resetKey)` | Grows a render window by `pageSize`, delegates network load-more/refresh, and resets on refresh or reset-key change. |

`useStableItems` accepts either custom entry equality or render-key equality:

| Config path | Contract |
| --- | --- |
| `entriesEqual(prev, next)` | Full control; entry shape can include context fields beyond `item`. |
| `renderKeys: Array<keyof TItem>` | Compares `prev.item` and `next.item` through `pickEqual`; mutually exclusive with `entriesEqual`. |

`getKey` defaults to `item.id` and throws if an item does not have a string `id`. `buildEntry` defaults to
`item => ({ item })`. `emptyItems` defaults to a shared frozen empty array, and explicit config values always win.
For comparator behavior that depends on outside state, pass that state as `invalidationKey`. `useOrderedEntities`
returns only the ordered item array; use `useEntitiesById` directly when a view also needs random lookup by id.

`useStableEntity` accepts either:

| Config path | Contract |
| --- | --- |
| `volatileKeys: Array<keyof TItem>` | Deep-compares the entity after omitting volatile fields such as timestamps. |
| `renderKeys: Array<keyof TItem>` | Compares only fields that affect rendering. |

`null` and `undefined` are returned as-is. Moving from a nullish value to an object always adopts the new object
identity.

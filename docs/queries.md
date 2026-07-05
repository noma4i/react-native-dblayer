# Queries

The query DSL runs a GraphQL operation, writes the result into a collection, and hands back the reactive read. It
sits on `@tanstack/react-query`, so wrap your app in a `QueryClientProvider`.

## `useDbSingleRequest(config)`

Full example — fetch one user, store it, render the reactive row:

```tsx
import { useDbSingleRequest } from '@noma4i/react-native-dblayer';
import { ActivityIndicator, Text } from 'react-native';
import { USER_QUERY } from './operations'; // graphql-codegen TypedDocumentNode

function UserCard({ id }: { id: string }) {
  const { data: user, isLoading, loadingState } = useDbSingleRequest({
    key: ['user', id],
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

### `DbRequestSingleConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | `TypedDocumentNode<TResponse, TVars> \| DocumentNode` | **required** | The GraphQL query. Types flow from a `TypedDocumentNode`. |
| `key` | `readonly unknown[]` | **required** | React Query cache key. |
| `select` | `(data: TResponse) => TSelected` | **required** | Pick the payload (e.g. `d => d.user`). |
| `vars` | `TVars` | `—` | Query variables. |
| `map` | `(selected) => TResult` | identity | Transform the payload before writing/returning. |
| `sync` | `{ model, contract: string } \| ((selected) => void)` | `—` | Where to write. `{ model, contract }` merges into the model under the `contract` label; a function writes manually. |
| `extract` | `({ data, selected }) => unknown` | `—` | Side-load payload → extract sink (source `'query'`). |
| `read` | `{ model, id } \| { model }` | `—` | Reactive read returned: `{ model, id }` = one row, `{ model }` = `all()`. |
| `enabled` | `boolean` | `true` | Gate the query. |
| `inactive` | `boolean` | `false` | Background/inactive screen (affects `loadingState`). |
| `staleTime` | `number` (ms) | TanStack Query | Freshness window. |
| `gcTime` | `number` (ms) | TanStack Query | Cache GC time. |
| `refetchOnMount` | `boolean` | TanStack Query | Refetch on remount. |

Writing a list into a collection and reading it all back:

```tsx
function Members({ teamId }: { teamId: string }) {
  const { loadingState } = useDbSingleRequest({
    key: ['members', teamId],
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
  key: ['post', id], query: POST_QUERY, vars: { id },
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
    key: ['feed'],
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
| `key` | `readonly unknown[]` | **required** | React Query key. |
| `selectPage` | `(data) => ConnectionWithNodes \| ConnectionWithEdges \| null` | **required** | Pick the connection (`{ nodes, pageInfo }` or `{ edges, pageInfo }`). |
| `read` | collection binding | **required** | Stores page nodes; read back reactively. |
| `vars` | `TVars` | `—` | Base variables. |
| `getPageVars` | `(pageParam: string) => Record<string, unknown>` | `—` | Cursor → next page's variables. |
| `getCursor` | `(data) => string \| number \| null` | `—` | Next cursor from a page. |
| `patchNode` | `(node, { index, pageParam }) => Partial \| null` | `—` | Decorate each node before storing. |
| `extract` | `({ data, nodes }) => unknown` | `—` | Side-load payload (extract sink, source `'query'`). |
| `resolveSyncContract` | `(ctx) => SyncContract` | replace first page, merge rest | Override how each page is written. |
| `readMode` | `'data' \| 'none'` | `'data'` | `'none'` when a view hook owns the reactive read. |
| `filter` | `() => unknown` | `—` | Scope filter for the read. |
| `currentUserId` | `() => string \| undefined` | `—` | Scope-key input. |
| `direction` | `'forward' \| 'backward'` | `'forward'` | Pagination direction. |
| `enabled` / `staleTime` / `gcTime` | | `true` / TanStack Query | As above. |

### Returns — `InfiniteQueryResult<TNode>`

| Field | Type | Description |
| --- | --- | --- |
| `items` / `data` | `TNode[]` | Accumulated nodes (reactive). |
| `loadingState` | `LoadingState` | UI state machine (as above). |
| `hasNextPage` | `boolean` | Another page exists. |
| `isFetchingNextPage` | `boolean` | A page load is in flight. |
| `isBackgroundFetching` | `boolean` | Background refresh running. |
| `loadMore` | `() => void` | Load the next page. |
| `fetchNextPage` | `() => void` | Lower-level next-page trigger. |
| `refetch` / `refresh` | `() => Promise<void>` | Re-run from the first page. |

## Non-React execution

Run the same configs outside React (services, preloads):

```ts
import { executeDbSingleRequest, executeDbInfiniteRequest } from '@noma4i/react-native-dblayer';

await executeDbSingleRequest({ key: ['user', id], query: USER_QUERY, vars: { id }, select: (d) => d.user,
  sync: { model: UserModel, contract: 'user' } });

await executeDbInfiniteRequest(feedConfig, /* pageParam */ undefined);
```

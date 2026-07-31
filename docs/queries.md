# Queries

Model reads are declared as named relations. A relation can be local-only, a complete GraphQL
list, a GraphQL connection, or a GraphQL single-row read.

## `gql.connection(document, options)`

```ts
const Message = defineModel('Message', {
  schema: MessageSchema,
  relations: {
    thread: {
      by: { chatId: 'chatId' },
      sort: 'server-order',
      remote: gql.connection(MessagesDocument, {
        variables: ({ chatId }: { chatId: string }) => ({ chatId }),
        connection: data => data.messages
      })
    }
  }
});
```

## `GraphqlConnectionOptions`

| Option | Purpose |
| --- | --- |
| `variables` | Maps relation parameters to GraphQL variables. |
| `connection` | Selects Relay nodes, edges, and page info. |
| `coverage` | Selects complete or paged membership reconciliation. |
| `cursor` | Selects a custom cursor from the response. |
| `required` | Disables transport until all named parameters are non-nullish. |
| `staleTime` | Sets filled-result freshness. |
| `persistenceVersion` | Versions persisted query metadata when the declaration contract changes. |
| `resumeStaleTime` | Overrides foreground invalidation age. |
| `emptyStaleTime` | Sets empty-result freshness. |
| `refetchOnMount` | Controls mount refetch of stale data. |
| `maxPages` | Bounds retained remote pages. |
| `direction` | Selects forward or backward cursor traversal. |
| `cursorVar` | Overrides the cursor variable name. |
| `map` | Maps each selected transport node before model normalization. |
| `mapCursor` | Maps the stored cursor into the transport variable type. |

## `gql.list(document, options)`

`gql.list` selects a complete, non-paginated array. Its optional `map` callback transforms each
transport node before model normalization. The remaining freshness and required-parameter options
match `gql.single`.

## `gql.single(document, options)`

```ts
details: {
  remote: gql.single(MessageDocument, {
    variables: ({ id }: { id: string }) => ({ id }),
    select: data => data.message,
    required: ['id']
  })
}
```

## `GraphqlSingleOptions`

| Option | Purpose |
| --- | --- |
| `variables` | Maps relation parameters to GraphQL variables. |
| `select` | Selects one row or a nullish absence. |
| `required` | Disables transport until all named parameters are non-nullish. |
| `staleTime` | Sets filled-result freshness. |
| `persistenceVersion` | Versions persisted query metadata when the declaration contract changes. |
| `resumeStaleTime` | Overrides foreground invalidation age. |
| `emptyStaleTime` | Sets empty-result freshness. |
| `refetchOnMount` | Controls mount refetch of stale data. |

## `QueryResult`

`Relation.use()` returns `RelationResult`: `data`, `loadingState`, `error`, `hasMore`,
`isFetchingMore`, `isPreviousData`, `loadMore()`, and `refresh()`. `QueryResult` is the lower-level service result used by
`defineFetch`. `useLoadMore(target, options)` adapts a model-less paginated result to a stable,
debounced advance callback through `LoadMoreTarget` and `LoadMoreOptions`.

## Loading state

`LoadingState` distinguishes initial loading, refreshing, paging, retrying, offline state, ready
data, empty data, and errors. Local rows remain readable while a remote refresh is in progress.

## `defineFetch(config)`

`defineFetch` is reserved for reads with no model destination. `FetchConfig` accepts a GraphQL
document and selector or a custom fetcher. `FetchHandle` exposes `read`, freshness-aware `fetch`,
forced `refresh`, `use`, and family `remove`. `validate` checks selected data after transport and
durable restore. `FetchResult` carries data, loading state, error, and refresh.

Freshness-aware `fetch` keeps restored data when a stale network attempt fails. Offline `fetch`
returns restored data and rejects when no memory or durable record exists. Forced `refresh`
propagates request failures even when older data remains readable.

## Connection and extract helpers

`fromNodes` normalizes Relay nodes and edges. `intoIf` conditionally returns an `ExtractSink`.
These helpers remain public for model-less services and migration adapters; model relations land
their selected rows automatically.

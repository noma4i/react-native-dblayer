# Queries

Model reads are declared as named relations. A relation can be local-only, a GraphQL connection,
or a GraphQL single-row read.

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
| `required` | Disables transport until all named parameters are non-nullish. |
| `staleTime` | Sets filled-result freshness. |
| `resumeStaleTime` | Overrides foreground invalidation age. |
| `emptyStaleTime` | Sets empty-result freshness. |
| `refetchOnMount` | Controls mount refetch of stale data. |
| `maxPages` | Bounds retained remote pages. |
| `direction` | Selects forward or backward cursor traversal. |
| `cursorVar` | Overrides the cursor variable name. |

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
| `resumeStaleTime` | Overrides foreground invalidation age. |
| `emptyStaleTime` | Sets empty-result freshness. |
| `refetchOnMount` | Controls mount refetch of stale data. |

## `QueryResult`

`Relation.use()` returns `RelationResult`: `data`, `loadingState`, `error`, `hasMore`,
`loadMore()`, and `refresh()`. `QueryResult` is the lower-level service result used by
`defineFetch`. `useLoadMore(target, options)` adapts a model-less paginated result to a stable,
debounced advance callback through `LoadMoreTarget` and `LoadMoreOptions`.

## Loading state

`LoadingState` distinguishes initial loading, refreshing, paging, retrying, offline state, ready
data, empty data, and errors. Local rows remain readable while a remote refresh is in progress.

## `defineFetch(config)`

`defineFetch` is reserved for reads with no model destination. `FetchConfig` accepts a GraphQL
document and selector or a custom fetcher. `FetchHandle` exposes `read`, `fetch`, `use`, and
invalidation. `FetchResult` carries data, loading state, error, and refresh.

## Connection and extract helpers

`fromNodes` normalizes Relay nodes and edges. `intoIf` conditionally returns an `ExtractSink`.
These helpers remain public for model-less services and migration adapters; model relations land
their selected rows automatically.

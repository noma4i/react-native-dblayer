# Queries

Model reads are declared as named relations. A relation can be local-only, a complete GraphQL
list, a GraphQL connection, or a GraphQL single-row read.

## `owner.gql.connection(document, options)`

```ts
const Message = defineModel('Message', {
  schema: MessageSchema,
  relations: {
    thread: {
      by: { chatId: 'chatId' },
      sort: 'server-order',
      remote: owner.gql.connection(MessagesDocument, {
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
| `write` | Plans additional cross-model writes and invalidations in the response envelope. |
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

Remote query declarations use one `write(context, plan)` callback and one `WritePlan`. The root
relation landing and additional intents enter one commit envelope. Invalidation intents run after a
successful commit.

## `owner.gql.list(document, options)`

`owner.gql.list` selects a complete, non-paginated array. Its optional `map` callback transforms each
transport node before model normalization. The remaining freshness and required-parameter options
match `owner.gql.single`.

## `owner.gql.single(document, options)`

```ts
details: {
  remote: owner.gql.single(MessageDocument, {
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
| `write` | Plans additional cross-model writes and invalidations in the response envelope. |
| `required` | Disables transport until all named parameters are non-nullish. |
| `staleTime` | Sets filled-result freshness. |
| `persistenceVersion` | Versions persisted query metadata when the declaration contract changes. |
| `resumeStaleTime` | Overrides foreground invalidation age. |
| `emptyStaleTime` | Sets empty-result freshness. |
| `refetchOnMount` | Controls mount refetch of stale data. |

## `QueryResult`

`Relation.use()` returns `RelationResult`: `data`, `loadingState`, `error`, `hasMore`,
`isFetchingMore`, `isPreviousData`, `loadMore()`, and `refresh()`. `QueryResult` is the shared
reactive result contract. `useLoadMore(target, options)` creates a stable, debounced advance
callback through `LoadMoreTarget` and `LoadMoreOptions`.

## Loading state

`LoadingState` distinguishes initial loading, refreshing, paging, retrying, offline state, ready
data, empty data, and errors. Local rows remain readable while a remote refresh is in progress.

## Connection helpers

`fromNodes` normalizes Relay nodes and edges for service-level transport handling. Model relations
land their selected rows automatically.

# Subscription events

Typed subscription handlers are declared in a model with `owner.gql.live`.

## `owner.gql.live(document, options)`

```ts
const Message = defineModel('Message', {
  schema: MessageSchema,
  events: {
    messageCreated: owner.gql.live(MessageCreatedDocument, {
      root: { insert: { select: ({ payload }) => payload.message } }
    }),
    messageDeleted: owner.gql.live(MessageDeletedDocument, {
      root: { destroy: { select: ({ payload }) => payload.id } }
    })
  }
});
```

## `GraphqlLiveOptions`

| Option | Purpose |
| --- | --- |
| `variables` | Supplies static GraphQL subscription variables. |
| `root` | Selects exactly one owner-model insert, update, or destroy root. |
| `write` | Plans additional cross-model writes and invalidations in the same commit envelope. |
| `debounce` | Coalesces transport events before planning. |

## `Model.events`

`Model.events.name.subscribe(listener)` observes accepted typed payloads after their model commit.
Transport events execute the root plan, sideload traversal, relation effects, idempotency checks,
and atomic commit before listener notification.

Live ingest uses the same `WritePlan` as actions and remote queries. The event root and additional
intents enter one commit envelope. Invalidation intents run after a successful commit.

## `useDbSubscriptions(active)`

Mount `useDbSubscriptions` once under `DbProvider`. It acquires every registered model event while
active and releases the shared lifecycle on cleanup. The lifecycle reconnects recoverable
transport failures and disposes listeners when the final consumer releases it.

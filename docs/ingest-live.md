# Subscription events

Typed subscription handlers are declared in a model with `gql.live`.

## `gql.live(document, options)`

```ts
const Message = defineModel('Message', {
  schema: MessageSchema,
  events: {
    messageCreated: gql.live(MessageCreatedDocument, {
      handler: payload => ({ upsert: payload.message })
    }),
    messageDeleted: gql.live(MessageDeletedDocument, {
      handler: payload => ({ destroy: payload.id })
    })
  }
});
```

## `GraphqlLiveOptions`

| Option | Purpose |
| --- | --- |
| `handler` | Converts one typed payload into an `IngestDecl` or ignores it with `null`. |
| `debounce` | Coalesces transport events under the shared subscription runtime. |

## `Model.events`

`ModelEventHandle.entries` contains transport-ready declarations.
`Model.events.apply(name, payload)` delivers a typed payload manually. Both routes execute the same
handler, sideload traversal, relation effects, idempotency checks, and atomic plan commit.

`IngestDecl` supports row upsert, destroy, operation echo identity, and additional
`write(context, plan)` intents.

Live ingest uses the same `WritePlan` as actions and remote queries. The event root and additional
intents enter one commit envelope. Invalidation intents run after a successful commit.

## `createDbSubscriptionRuntime(entries)`

The runtime subscribes through configured `DbTransport.subscribe`, reference-counts consumers,
reconnects after recoverable transport failure, and disposes every listener when the final
consumer detaches.

`defineDbSubscriptionEntry(entry)` preserves payload inference for custom entries.
`createDbSubscriptionEffects(noopEffects)` connects a runtime to React lifecycle or a custom host.

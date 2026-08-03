# react-native-dblayer

`@noma4i/react-native-dblayer` is a local-first GraphQL data layer for React Native. A model owns
its schema, relations, associations, actions, subscription events, write policy, maintenance, and
domain statics. Components use class-like model methods instead of assembling query and mutation
machinery.

Full reference: [docs/README.md](./docs/README.md).

## Define a model

```ts
import { defineModel, defineShape, f } from '@noma4i/react-native-dblayer';

const MessageSchema = defineShape<MessageInput>()({
  chatId: f.id(),
  body: f.str(),
  status: f.enum(['sending', 'sent'] as const)
});

export const Message = defineModel('Message', {
  schema: MessageSchema,
  relations: owner => ({
    thread: {
      by: { chatId: 'chatId' },
      sort: 'server-order',
      remote: owner.gql.connection(MessagesDocument, {
        variables: ({ chatId }: { chatId: string }) => ({ chatId }),
        connection: data => data.messages
      })
    },
    details: {
      remote: owner.gql.single(MessageDocument, {
        variables: ({ id }: { id: string }) => ({ id }),
        select: data => data.message,
        required: ['id']
      })
    }
  }),
  actions: owner => ({
    send: owner.gql.action(SendMessageDocument, {
      mode: 'request',
      result: 'sendMessage',
      variables: input => ({ input }),
      optimistic: {
        root: {
          insert: {
            select: ({ input, tempId }) => ({
              id: tempId,
              chatId: input.chatId,
              body: input.body,
              status: 'sending'
            })
          }
        }
      },
      root: { insert: { select: ({ data }) => data.sendMessage.message } }
    })
  }),
  events: owner => ({
    messageCreated: owner.gql.live(MessageCreatedDocument, {
      root: { insert: { select: ({ payload }) => payload.message } }
    })
  })
});
```

`defineModel(key, config)` is the only public model constructor. Named relations are flat methods,
commands live under `Model.actions`, and subscription declarations live under `Model.events`.

## Read data

```ts
const row = Message.find(messageId);
const current = Message.useFind(messageId);

const relation = Message.thread({ chatId });
const snapshot = relation.read();
const { data, loadingState, error, hasMore, isFetchingMore, loadMore, refresh } = relation.use({
  pageSize: 20
});

await relation.fetch();
await relation.refresh();
Message.thread.invalidate();
```

The same immutable `Relation` object provides local snapshot reads, subscribed reads, loading
state, invalidation, pagination, refresh, and counts. `fetch` respects freshness and preserves
restored data across request failure, while no-cache offline calls reject. `refresh` forces
transport, and a named relation method invalidates its complete persisted family without touching
sibling relations. `where` and `byIds` return the same shape.

## Run actions

```ts
await Message.actions.send.run({ chatId, body });

const send = Message.actions.send.use();
await send.run({ chatId, body });
```

Request actions own optimistic writes, correlation, rollback, deduplication, and invalidation.
Actions, remote queries, and live ingest use one `write(context, plan)` callback and one `WritePlan`.
Durable and poll modes use the same `owner.gql.action` declaration.

## Observe subscription events

```ts
const unsubscribe = Message.events.messageCreated.subscribe(payload => {
  logger.info('message committed', payload.message.id);
});
```

Mount `useDbSubscriptions(active)` once under the configured runtime. Transport delivery and
event listeners use the same model event plan and atomic commit pipeline. Listeners run after the
commit succeeds.

## Runtime

```ts
import { configureDb, DbProvider } from '@noma4i/react-native-dblayer';

configureDb({ transport });

const Root = () => (
  <DbProvider>
    <App />
  </DbProvider>
);
```

Every write compiles into one plan, one write-ahead transaction, and one semantic publish.
Canonical rows, relation membership, ordering, optimistic identity, and operation state remain
consistent under one epoch. Storage failure publishes nothing. `resetRuntime()` clears persisted
and in-memory state on logout.

Named queries with a finite positive freshness window persist query identity, selected data or
pagination metadata, the original update timestamp, and invalidation state. A process restart
therefore restores fresh data without transport and refreshes expired or invalidated data exactly
once. Anonymous and zero-stale queries remain process-local. Increment `persistenceVersion` when a
selected shape, destination, identity, or pagination contract changes.

## Verification

The release gate runs type checking, linting, JSDoc coverage, build-artifact verification, the
complete Jest contract suite, 100% executable-source coverage, and mutation testing with zero
survivors.

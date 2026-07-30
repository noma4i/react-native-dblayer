# react-native-dblayer

`@noma4i/react-native-dblayer` is a local-first GraphQL data layer for React Native. A model owns
its schema, relations, associations, actions, subscription events, write policy, maintenance, and
domain statics. Components use class-like model methods instead of assembling query and mutation
machinery.

Full reference: [docs/README.md](./docs/README.md).

## Define a model

```ts
import { defineModel, defineShape, f, gql } from '@noma4i/react-native-dblayer';

const MessageSchema = defineShape<MessageInput>()({
  chatId: f.id(),
  body: f.str(),
  status: f.enum(['sending', 'sent'] as const)
});

export const Message = defineModel('Message', {
  schema: MessageSchema,
  relations: {
    thread: {
      by: { chatId: 'chatId' },
      sort: 'server-order',
      remote: gql.connection(MessagesDocument, {
        variables: ({ chatId }: { chatId: string }) => ({ chatId }),
        connection: data => data.messages
      })
    },
    details: {
      remote: gql.single(MessageDocument, {
        variables: ({ id }: { id: string }) => ({ id }),
        select: data => data.message,
        required: ['id']
      })
    }
  },
  actions: {
    send: gql.action(SendMessageDocument, {
      result: 'sendMessage',
      variables: input => ({ input }),
      kind: 'insert',
      select: data => data.sendMessage.message,
      optimistic: {
        build: (input, { tempId }) => ({
          id: tempId,
          chatId: input.chatId,
          body: input.body,
          status: 'sending'
        })
      }
    })
  },
  events: {
    messageCreated: gql.live(MessageCreatedDocument, {
      handler: payload => ({ upsert: payload.message })
    })
  }
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
```

The same immutable `Relation` object provides local snapshot reads, subscribed reads, loading
state, invalidation, pagination, refresh, and counts. `where` and `byIds` return the same shape.

## Run actions

```ts
await Message.actions.send.run({ chatId, body });

const send = Message.actions.send.use();
await send.run({ chatId, body });
```

Request actions own optimistic writes, correlation, rollback, deduplication, extraction, and
invalidation. Durable and poll modes use the same `gql.action` declaration.

## Apply subscription events

```ts
Message.events.apply('messageCreated', payload);
```

Pass `Message.events.entries` to the shared subscription runtime. Manual delivery and transport
delivery execute the same typed handler and atomic ingest pipeline.

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
consistent under one epoch. `resetRuntime()` clears persisted and in-memory state on logout.

Standalone `defineFetch` and `defineCommand` remain available only for model-less service work.

## Verification

The release gate runs type checking, linting, JSDoc coverage, build-artifact verification, the
complete Jest contract suite, 100% executable-source coverage, and mutation testing with zero
survivors.

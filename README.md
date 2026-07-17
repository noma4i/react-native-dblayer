# react-native-dblayer

`@noma4i/react-native-dblayer` is a local-first GraphQL data layer for React Native with an
ActiveRecord-flavored DSL. Every write - query page, mutation, subscription event, imperative
call - compiles into one journalled apply pipeline: a pure plan, a single transaction, a durable
write-ahead commit, and one semantic publish. Reads subscribe to exactly the rows, fields, and
scopes they consume, so an unrelated change never re-renders a component.

## Architecture

Three state planes hold everything:

| Plane | Owns |
|---|---|
| EntityState | canonical rows, per-model write clock, tombstones |
| ScopeIndex | scope membership, order, edge payloads, coverage |
| OperationState | optimistic identity, idempotency keys, keyed sequences |

One apply runtime is shared by every model: a plan touching several models applies and persists
as one transaction under one epoch. Durability is write-ahead: each plan persists exactly two
storage batches - the pending journal record first, then data plus the committed record - so a
torn write replays on startup instead of corrupting state.

The commit bus delivers pinpoint notifications keyed by `(model, id, fields)` and scope. Hooks
are built on `useSyncExternalStore`; a write is visible to readers in the same tick - there are
no async hops, debounces, or query-cache round-trips on the write path.

## Configure

```ts
configureDb({ transport, queryClient });
```

DBLay owns the `@tanstack/react-query` version and exports the shared `QueryClient`,
`QueryClientProvider`, `focusManager`, `useQuery`, and `useQueryClient` primitives for the host app.
Import them from `@noma4i/react-native-dblayer`. The DBLay query DSL still hides the Query cache from
model storage: DB rows remain in DBLay planes, not in Query cache entries.

`transport` provides `query`, `mutation`, and `subscribe`. Storage defaults to MMKV and can be
replaced with any `StoragePlane`. There is no partitioning and no per-user namespace: one flat
database, and `resetRuntime()` is the kill-switch - it deletes every persisted key, clears all
in-memory planes, and notifies live subscribers. Call it on logout; models keep working after it.

## Models

```ts
const MessageModel = defineModel({
  id: 'messages',
  name: 'MessageModel',
  fields: MessageSchema.fields,
  scopes: {
    thread: scope({ by: { chatId: 'chatId' }, sort: { field: 'createdAt', dir: 'asc' } })
  },
  relations: () => ({
    chat: belongsTo(ChatModel, {
      foreignKey: 'chatId',
      touch: (message, chat) => ({
        lastMessageText: message.text,
        lastActivityAt: Math.max(Number(chat.lastActivityAt ?? 0), Number(message.createdAt))
      }),
      counterCache: { field: 'unreadCount', filter: message => message.kind !== 'system' }
    })
  }),
  statics: model => ({
    forChat: (chatId: string) => model.getWhere({ chatId })
  })
});
```

Relations are the Rails taxonomy compiled into plan expansion:

- `belongsTo` with `touch` projects child data onto the parent in the same transaction - values
  come from event data, never from the wall clock. Several children in one plan fold through an
  accumulated parent view, so max-style fields compose.
- `belongsTo` with `counterCache` increments only for rows the store has never seen (a re-delivered
  or edited row never double-counts) and decrements on explicit destroy.
- `hasMany` with `dependent: 'destroy'` cascades explicit destroys recursively. Without it, a
  relation is query-only - destroying a parent never touches children.
- `hasOne` picks the best child by comparator on read.

`scope({ by })` is declarative membership: an event row (optimistic insert, ingest, replace,
re-parenting patch) joins and leaves its scopes inside the same plan - a sent message is a member
of its thread in the same tick, before the server responds. Server snapshots stay authoritative:
a page reconcile overrides auto-membership, and `complete` coverage detaches rows that left the
scope without destroying the entities. Explicit destroy is the only entity deletion authority.

Relation effects run for EVENT plans only (imperative writes, mutations, ingest). Snapshot plans
(query pages, entity refreshes) apply verbatim - server data already carries derived state.

## Reactive reads

```ts
const message = MessageModel.use.row(id);                    // one row
const text = MessageModel.use.field(id, 'text');             // one field - nothing else re-renders it
const chat = MessageModel.use.related(id, 'chat');           // parent row, pinpoint deps
const rows = MessageModel.scopes.thread.use({ chatId });     // sorted members, stable refs
const pager = MessageModel.scopes.thread.useWindow({ chatId }, { pageSize: 20 });
```

Array reads keep referential identity: after a single-row patch, every untouched element keeps
its previous reference. Snapshot reads (`get`, `getWhere`, `getAll`) never subscribe; `getAll` is
the library/maintenance channel - application code stays on scoped reads.

## Queries

```ts
const threadQuery = defineQuery({
  document: MessagesDocument,               // cache key = operation name
  vars: scope => ({ chatId: scope.chatId }),
  page: data => data.messages,              // infinite connection; or `select` for single reads
  into: MessageModel.scopes.thread,
  extract: ({ nodes }) => [{ into: UserModel, rows: authorsOf(nodes) }]
});

const { data, loadingState, hasNextPage, loadMore, refetch } = threadQuery.use({ chatId });
```

TanStack Query is shared through DBLay package exports, while its cache remains hidden from model
storage: it stores only page metadata (cursor, count) and rows live in DBLay planes. `extract` sinks
apply in the same transaction as the main rows. `loadMore` failures land in `error`/`loadingState`,
never as unhandled rejections. `emptyStaleTime` lets empty results expire faster than filled ones.
`invalidate(scope)` targets one scope; `invalidate()` targets every scope of that query only. A
disabled query with local rows stays `ready`.

## Mutations

```ts
const sendMessage = defineMutation({
  document: MessageSendDocument,
  result: 'messageSend',
  optimistic: {
    model: MessageModel,
    build: (input, { tempId }) => buildLocalMessage(input, tempId),
    selectServerNode: data => data.messageSend.message,
    preserveOnCommit: ['localEcho'],        // client-only fields survive the commit
    existingTempId: input => input.retryTempId ?? null
  },
  dedupe: { key: input => input.clientKey },
  onCommit: (data, { tempId, input }) => {}
});

const { mutate, mutateAsync, isPending, error } = sendMessage.use();
await sendMessage.run(input);               // same lifecycle imperatively
```

The lifecycle is: optimistic write (synchronous, before transport) -> transport -> one-transaction
commit (temp-to-server replace + preserved fields + extract sinks in a single epoch) or rollback.
A committed dedupe key is never re-sent; a pending key blocks double-taps; a `null` key disables
dedupe. `existingTempId` is the retry path: it reuses the failed optimistic row and a failed retry
keeps it.

## Ingest (subscriptions)

```ts
const messageIngest = defineIngest(MessageModel, {
  messageCreated: payload => ({ upsert: payload.message, operationId: payload.clientKey }),
  messageDeleted: payload => ({ destroy: payload.id })
});
messageIngest.apply(event.name, event.payload);
```

One event compiles into one plan: rows, destroys, and `extract` sinks apply with relation effects
in a single epoch. Re-delivery is idempotent - an unchanged row emits no notifications and never
re-increments counters. `operationId` is the echo guard: an event whose operation already
committed locally is skipped. Stale-version arbitration lives in the model's
`merge.shouldOverwrite` gate.

## Maintenance and helpers

`pruneOrphanedRows`, `pruneExpiredRows`, `trimRowsPerScope`, `resolveStaleTempRows`, and
`reconcileOptimisticRows` consume any model via its maintenance channel. `patchWhenPresent` and
`waitForRow` defer work until a row appears (commit-bus backed, TTL/abort aware).
`singletonStatics` builds a reactive single-row facade. `useStableProjection`,
`useJoinedEntities`, `useOrderedEntities`, and friends keep derived view arrays referentially
stable.

## Performance contract

Performance is spec'd, not hoped for: `src/__tests__/perf/` runs in the main suite and a perf
failure blocks release like a functional one.

- Counted invariants: one plan = exactly two storage batches (WAL), one journal record, one
  publish; an idempotent re-upsert does zero notify work; a single-field patch re-renders only
  that field's readers; untouched rows keep their references.
- Timed budgets (best-of-3): plan apply at 10k rows, publish fan-out at 1000 subscribers,
  sorted scope reads at 1000 entries, cold hydrate at 10k rows, and a 25-chat/1000-message
  chat-session scenario.

## Testing

Invariant suites (`src/__tests__/invariants/`) cover the planes, journal replay, cross-model
transactions, relation effects, auto-membership, query/mutation/ingest lifecycles, and pinpoint
reactivity with render counters, including property-based interleavings.

# Actions

Model commands are declared with `owner.gql.action` and exposed under `Model.actions`.
When an action reads its owning model, use the factory owner's read-only `find`, `where`, `byIds`,
or named relation methods inside a deferred action callback. The action root remains the only
owner-model writer.

## `owner.gql.action(document, options)`

```ts
send: owner.gql.action(SendMessageDocument, {
  mode: 'request',
  result: 'sendMessage',
  variables: input => ({ input }),
  optimistic: {
    root: {
      insert: {
        select: ({ input, tempId }) => ({ id: tempId, ...input, status: 'sending' })
      }
    }
  },
  root: { insert: { select: ({ data }) => data.sendMessage.message } }
})
```

## `GraphqlActionOptions`

| Option | Purpose |
| --- | --- |
| `result` | Selects the top-level mutation payload. |
| `variables` | Defines the model action input and maps it to generated GraphQL variables. |
| `write` | Plans additional cross-model writes and invalidations in the response envelope. |
| `dedupe` | Declares an idempotency key or disables deduplication. |
| `once` | Persists successful one-time execution. |
| `before` | Runs before the request with the input and operation context. |
| `error` | Runs after rollback with the error, input, and operation context. |
| `track` | Observes a successful commit. |
| `root` | Selects exactly one owner-model insert, update, or destroy root. |
| `optimistic` | Declares the matching optimistic root and optional insert correlation. |
| `mode` | Selects request, durable, or poll execution. |
| `poll` | Declares interval, attempt budget, and terminal classification. |

## `WritePlan`

Actions, remote queries, and live ingest use one `write(context, plan)` callback. The callback
receives one `WritePlan` with exactly `upsert`, `update`, `destroy`, and `invalidate`.

The action root landing and additional writes enter one commit envelope. Invalidation intents run
after a successful commit.

Update patches omit absent fields; an own enumerable field with explicit `undefined` rejects before
commit.

## Request mode

`Model.actions.name.run(input)` returns the selected payload. `Model.actions.name.use()` returns a
`ModelActionHook` with `run`, `isPending`, and `error`. `ModelAction` also exposes `retry` and
`discard` for failed optimistic inserts. The write lifecycle is optimistic planning, transport,
atomic correlation or rollback, cross-model planning, one commit, then invalidation and tracking.

Mutation transport does not retry automatically. An adapter throws
`MutationDeliveryUnknownError` only when it cannot prove whether the server accepted the mutation.
The action keeps its optimistic row and exposes `deliveryUnknown: true`. It never sends that
operation again. Correlation or explicit cancel resolves the operation.

An insert action always lands the row selected by `select`. An optimistic declaration may create a
temporary row before transport; without one, the selected server row still enters the owning model
and its declared scopes during the commit.

## Durable mode

A durable insert starts with `Model.actions.name.start(input)`. It returns a handle with
`operationId`, `tempId`, `execute(transportInput)`, and `cancel()`. The WAL persists the optimistic
root before transport. `resume(operationId)` reconnects to one durable operation after boot.
`open()` returns the typed input and handle for every pending, failed, or unknown-delivery operation.
`execute` accepts pending and failed operations. It returns `null` without transport for an
unknown-delivery operation.

## Poll mode

A poll update exposes `run(input)` and `use(input)`. The hook returns the current phase and
`refresh()`. One keyed scheduler owns attach counts, interval work, retry budget, and cleanup.

Every action writes through the same commit envelope. Direct TanStack collection mutations and a
second transaction coordinator are not public surfaces.

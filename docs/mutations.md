# Actions

Model commands are declared with `gql.action` and exposed under `Model.actions`.
When an action reads or changes its owning model, declare `actions` as a factory and use its typed
model argument.

## `gql.action(document, options)`

```ts
send: gql.action(SendMessageDocument, {
  result: 'sendMessage',
  variables: input => ({ input }),
  kind: 'insert',
  select: data => data.sendMessage.message,
  optimistic: {
    build: (input, { tempId }) => ({ id: tempId, ...input, status: 'sending' })
  }
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
| `kind` | Selects `insert`, `update`, `destroy`, or `custom`. |
| `select` | Selects the returned model row when the command has one. |
| `optimistic` | Declares optimistic build, patch, destruction, retry, or correlation. |
| `id` | Selects the target id for update and destroy commands. |
| `mode` | Selects request, durable, or poll execution. |
| `resume` | Resumes durable work after boot. |
| `poll` | Declares interval, attempt budget, and terminal classification. |

## `WritePlan`

Actions, remote queries, and live ingest use one `write(context, plan)` callback. The callback
receives one `WritePlan` with exactly `upsert`, `update`, `destroy`, and `invalidate`.

The action root landing and additional writes enter one commit envelope. Invalidation intents run
after a successful commit.

## Request mode

`Model.actions.name.run(input)` returns the selected payload. `Model.actions.name.use()` returns a
`ModelActionHook` with `run`, `isPending`, and `error`. `ModelAction` also exposes `retry` and
`discard` for failed optimistic inserts. The write lifecycle is optimistic planning, transport,
atomic correlation or rollback, cross-model planning, one commit, then invalidation and tracking.

An insert action always lands the row selected by `select`. An optimistic declaration may create a
temporary row before transport; without one, the selected server row still enters the owning model
and its declared scopes during the commit.

`MutateCallbacks` describes optional call-site callbacks. `ScopePlacement` describes explicit
placement when a service adapter must target a relation.

## Durable mode

A durable insert returns `{ operationId, tempId }` synchronously, persists its intent, and resumes
through the declared `resume` function after boot. The action owns `complete`, `fail`, `retry`, and
`discard`.

## Poll mode

A poll update exposes `run(input)` and `use(input)`. The hook returns the current phase and
`refresh()`. One keyed scheduler owns attach counts, interval work, retry budget, and cleanup.

## `defineCommand(name, config)`

`defineCommand` remains available for RPC work that belongs to no model and writes no model row.
Model-owned commands always use `gql.action`.

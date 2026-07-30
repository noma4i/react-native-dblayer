# Actions

Model commands are declared with `gql.action` and exposed under `Model.actions`.

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
| `dedupe` | Declares an idempotency key or disables deduplication. |
| `once` | Persists successful one-time execution. |
| `before` | Runs before the request with the input and operation context. |
| `after` | Runs after the atomic commit with the input and response data. |
| `error` | Runs after rollback with the error, input, and operation context. |
| `invalidate` | Invalidates related reads after commit. |
| `track` | Observes a successful commit. |
| `kind` | Selects `insert`, `update`, `destroy`, or `custom`. |
| `select` | Selects the returned model row when the command has one. |
| `optimistic` | Declares optimistic build, patch, destruction, retry, or correlation. |
| `id` | Selects the target id for update and destroy commands. |
| `mode` | Selects request, durable, or poll execution. |
| `resume` | Resumes durable work after boot. |
| `poll` | Declares interval, attempt budget, and terminal classification. |

## Request mode

`Model.actions.name.run(input)` returns the selected payload. `Model.actions.name.use()` returns a
`ModelActionHook` with `run`, `isPending`, and `error`. `ModelAction` also exposes `retry` and
`discard` for failed optimistic inserts. The write lifecycle is optimistic plan, transport,
atomic correlation or rollback, then invalidation and tracking.

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

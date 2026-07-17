# Mutations

`defineMutation` runs a GraphQL mutation as one lifecycle: an optional optimistic local write,
the network call, then a single-transaction commit - with automatic rollback of the optimistic
write if anything throws. Dedupe, extract sinks, and lifecycle callbacks all run through the same
path for both the hook and the direct call.

## `defineMutation(config)`

```ts
import { defineMutation, generateTempId } from '@noma4i/react-native-dblayer';

const sendMessage = defineMutation({
  document: MessageSendDocument,
  result: 'messageSend',
  optimistic: {
    model: MessageModel,
    tempIdPrefix: 'message',
    build: (input: SendMessageInput, ctx) => ({
      id: ctx.tempId!,
      chatId: input.chatId,
      text: input.text,
      kind: 'text',
      createdAt: new Date().toISOString(),
      localEcho: true
    }),
    selectServerNode: data => data.messageSend.message,
    preserveOnCommit: ['localEcho'],
    existingTempId: input => input.retryTempId ?? null
  },
  extract: ({ data }) => [{ into: UserModel, rows: [data.messageSend.message.author] }],
  dedupe: { key: input => input.clientKey },
  mapInput: (input, ctx) => ({ ...input, operationId: ctx.operationId }),
  onCommit: (data, { tempId, input }) => {},
  onError: (error, { input }) => {},
  invalidate: ({ input }) => ChatModel.invalidate({ id: input.chatId }),
  track: ({ input }) => analytics.track('message_sent', { chatId: input.chatId })
});

const { mutate, mutateAsync, isPending, error } = sendMessage.use();
await sendMessage.run(input);   // same lifecycle, imperatively
```

### `MutationConfig`

| Option | Type | Description |
| --- | --- | --- |
| `document` | GraphQL document | The mutation document. |
| `result` | `string` | Response field owning the mutation payload; a null payload is treated as failure and rolls back. |
| `mapInput` | `(input, ctx: OptimisticCtx) => Record<string, unknown>` | Build transport variables from the mutation input and its optimistic operation context. |
| `optimistic` | insert / patch / destroy | Optimistic local write applied before the network call, undone on error/rollback. Omit for mutations with no local write of their own (pure side-effect calls). See below. |
| `extract` | `(ctx: { data }) => ExtractSink[]` | Cross-model sideloads from the response, applied in the SAME transaction as the commit. |
| `dedupe` | `{ key: (input) => string \| null }` | Idempotency: a committed key is never re-sent; a pending key blocks double-taps; a `null` key skips dedupe. |
| `onMutate` | `(input, ctx) => void` | Called synchronously right after the optimistic write (if any), before the transport call starts. |
| `onCommit` | `(data, ctx: OptimisticCtx & { input }) => void` | Called after the response commits successfully, after extract sinks and preserve-on-commit have applied. |
| `onError` | `(error, ctx: OptimisticCtx & { input }) => void` | Called after a failed run has rolled back its optimistic write (if any) and closed the operation. |
| `invalidate` | `(ctx: { input, data }) => void` | Called after a successful commit to invalidate related queries; errors are logged and do not fail the mutation. |
| `track` | `(ctx: { input, data }) => void` | Called after a successful commit for analytics/tracking; errors are logged and do not fail the mutation. |

### Optimistic write variants

`optimistic` is one of three shapes:

| Variant | Shape | Behavior |
| --- | --- | --- |
| Insert | `{ model, build, selectServerNode, tempIdPrefix?, preserveOnCommit?, existingTempId? }` | Writes a temp row immediately (id from `generateTempId(tempIdPrefix)`), then replaces it with the server node on commit (or removes it on error/rollback). `existingTempId(input)` is the retry path: reuse a failed row's temp id instead of inserting a new one; a failed retry keeps it. |
| Patch | `{ method: 'patch', model, selectId, selectPatch }` | Applies a partial update immediately, restoring the previous field values on error. |
| Destroy | `{ method: 'destroy', model, selectId }` | Removes the row immediately, restoring it (and its scope memberships) on error. **Throws at run time** if the model declares a `hasMany` `dependent: 'destroy'` cascade (see [models.md](./models.md#relations)) - a cascaded destroy cannot be rolled back. |

**Temp-id -> server replace.** On a successful insert commit, `selectServerNode(data)` picks the
server-created node; the temp row is replaced by it in the same transaction as any `extract` sinks.
`preserveOnCommit` names client-only fields (visual state, local uris) copied from the optimistic
row onto the committed server row before it lands - use it for fields the server response does not
carry, like `localEcho` above.

**Rollback guarantees.** A thrown transport error (or a null `result` payload) undoes exactly the
optimistic write that ran: an inserted temp row is destroyed (untombstoned, so a later write can
reuse the id cleanly), a patch restores its previous field values, a destroy restores the previous
row and its captured scope memberships. Rollback runs before `onError` and before the mutation
promise rejects.

**Cascade-destroy guard.** `optimistic: { method: 'destroy' }` throws synchronously, before any
network call, if the target model has a `hasMany` relation with `dependent: 'destroy'` - an
optimistic destroy on that model would need to roll back a cascade of children it does not track,
so the guard refuses the mutation outright rather than leaving orphaned or resurrected children.

### `operationId` echo wiring with `defineIngest`

Every mutation run gets a fresh `operationId` (`OptimisticCtx.operationId`), independent of
`dedupe`'s key. Send it to the server (typically via `mapInput`) so the server echoes it back on
the subscription event the mutation itself triggers; pass it through as `operationId` in the
declaration an ingest handler returns (see [configuration.md](./configuration.md#defineingestmodel-handlers)).
`defineIngest` skips the whole event when that `operationId` already committed locally - the
mutation's own commit already applied the row, so the echoed subscription event is a no-op instead
of a duplicate write.

### `use()` result shape

| Field | Type | Description |
| --- | --- | --- |
| `mutate` | `(input, callbacks?: MutateCallbacks) => void` | Fire-and-forget: runs the mutation, invoking `callbacks.onSuccess`/`onError`/`onSettled`. |
| `mutateAsync` | `(input) => Promise<TData \| null>` | Runs the mutation and returns/rejects like `run`, while also reflecting `isPending`/`error` in hook state. |
| `isPending` | `boolean` | `true` while a `mutate`/`mutateAsync` call from this hook instance is in flight. |
| `error` | `Error \| null` | The last error thrown by this hook instance's calls. |

`MutateCallbacks<TData>`: `onSuccess?: (data: TData \| null) => void` (receives `null` when the call
was skipped by dedupe), `onError?: (error: Error) => void` (called after rollback has already run),
`onSettled?: () => void` (called after `onSuccess`/`onError`, regardless of outcome).

`run(input)` (the non-hook path) executes one mutation outside React, resolving to the response
data, or `null` when dedupe skipped it.

## `mergeOptimisticSnapshot`

Merge an optimistic row snapshot with a committed server node - useful inside `onCommit`, or any
custom commit path that needs the same null/empty-string preservation `preserveOnCommit` gives you
for a fixed field list.

```ts
import { mergeOptimisticSnapshot } from '@noma4i/react-native-dblayer';

const merged = mergeOptimisticSnapshot(optimisticRow, serverNode, {
  fields: ['caption', 'localUri'],
  mergers: { localUri: (optimistic, server) => server ?? optimistic }
});
```

`mergeOptimisticSnapshot(optimistic, server, options?)`: for each merged field, the server value
wins **unless** it is `null`, `undefined`, or an empty string while the optimistic row has a value -
in which case the optimistic value is kept. `options.fields` restricts the merge to a field
allowlist (defaults to the union of both objects' keys); `options.mergers` overrides the
per-field rule for specific keys. Returns whichever side exists when the other is nullish.

## Error policy

A thrown mutation error always rejects `run`/`mutateAsync` (and reaches `mutate`'s `onError`
callback) after rollback has completed - errors are never swallowed. Independently, the same error
is reported to `DbDefaults.onSyncError` with `{ source: 'mutation' }` (see
[configuration.md](./configuration.md#onsyncerror-policy)), so app-wide error tracking does not need
to be wired into every call site. `onSyncError` observes the failure; it never changes whether the
mutation rejects.

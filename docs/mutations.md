# Mutations

`Model.mutation(name, config)` runs a GraphQL mutation as one lifecycle: an optional optimistic
local write, the network call, then a single-transaction commit - with automatic rollback of the
optimistic write if anything throws. Dedupe, extract sinks, and lifecycle callbacks all run
through the same path for both the hook and the direct call. `defineCommand(name, config)` is the
model-less counterpart for mutations with no local write of their own.

## `Model.mutation(name, config)`

```ts
import { generateTempId } from '@noma4i/react-native-dblayer';

const sendMessage = MessageModel.mutation('send', {
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

`name` sets the mutation's conventional dedupe key namespace (`<modelId>:<name>:<inputHash>`) -
see Dedupe below.

### `MutationConfig`

| Option | Type | Description |
| --- | --- | --- |
| `document` | GraphQL document | The mutation document. |
| `result` | `string` | Response field owning the mutation payload; a null payload is treated as failure and rolls back. |
| `mapInput` | `(input, ctx: OptimisticCtx) => Record<string, unknown>` | Build transport variables from the mutation input and its optimistic operation context. |
| `optimistic` | insert / patch / destroy | Optimistic local write applied before the network call, undone on error/rollback. Omit for mutations with no local write of their own (pure side-effect calls). See below. |
| `extract` | `(ctx: { data }) => ExtractSink[]` | Cross-model sideloads from the response, applied in the SAME transaction as the commit. |
| `dedupe` | `{ key: (input) => string \| null } \| false` | Idempotency: ON by default with a conventional key (`<modelId>:<name>:<inputHash>`) - a committed key is never re-sent, a pending key blocks double-taps. Pass `false` to opt out entirely, or a custom `{ key }` to override the key derivation. A `null` key from either the default or a custom `key` skips dedupe for that call. See Dedupe below. |
| `onMutate` | `(input, ctx) => void` | Called synchronously right after the optimistic write (if any), before the transport call starts. |
| `onCommit` | `(data, ctx: OptimisticCtx & { input }) => void` | Called after the response commits successfully, after extract sinks and preserve-on-commit have applied. |
| `onError` | `(error, ctx: OptimisticCtx & { input }) => void` | Called after a failed run has rolled back its optimistic write (if any) and closed the operation. |
| `invalidate` | `(ctx: { input, data }) => void` | Called after a successful commit to invalidate related queries; errors are logged and do not fail the mutation. |
| `track` | `(ctx: { input, data }) => void` | Called after a successful commit for analytics/tracking; errors are logged and do not fail the mutation. |

### Optimistic write variants

`optimistic` is one of four shapes:

| Variant | Shape | Behavior |
| --- | --- | --- |
| Insert | `{ model, build, selectServerNode, tempIdPrefix?, preserveOnCommit?, existingTempId?, prependTo?, appendTo? }` | Writes a temp row immediately (id from `generateTempId(tempIdPrefix)`), then replaces it with the server node on commit (or removes it on error/rollback). `existingTempId(input)` is the retry path: reuse a failed row's temp id instead of inserting a new one; a failed retry keeps it. `prependTo`/`appendTo` place the temp row in a server-order scope - see Optimistic scope placement below. |
| Respond | `{ model, selectServerNode, respond, prependTo?, appendTo? }` | Fabricates a full transport-shaped response and runs it through the exact same plan builder as the real one - see Respond variant below. |
| Patch | `{ method: 'patch', model, selectId, selectPatch }` | Applies a partial update immediately, restoring the previous field values on error. |
| Destroy | `{ method: 'destroy', model, selectId }` | Removes the row immediately, restoring it (and its scope memberships) on error. **Throws at run time** if the model declares a `hasMany` `dependent: 'destroy'` cascade (see [models.md](./models.md#relations)) - a cascaded destroy cannot be rolled back. |

**Temp-id -> server replace.** On a successful insert commit, `selectServerNode(data)` picks the
server-created node; the temp row is replaced by it in the same transaction as any `extract` sinks.
`preserveOnCommit` names client-only fields (visual state, local uris) copied from the optimistic
row onto the committed server row before it lands - use it for fields the server response does not
carry, like `localEcho` above.

**Respond variant.** `respond(input, { tempId, operationId })` fabricates a full `TData` response -
shaped exactly like the real mutation response, keyed under the same `result` field - instead of
building one row. The fabricated response is run through the SAME plan builder later used for the
real transport response: `result`-field extraction (`data[config.result]`, throwing the same
`` `${result} returned no data` `` error when missing), `selectServerNode` node selection, and an
empty/missing node id mapping to this run's `tempId` - all identical whether the data came from
`respond` or the transport. `extract` sinks run against the fabricated data optimistically, then run
again against the real data on commit; both passes are plain upserts, so the commit pass overwrites
the optimistic one idempotently rather than duplicating rows. Reach for `respond` instead of `build`
when the optimistic write needs the same nested shape (and `extract` sideloads) the real mutation
produces, not just one row:

```ts
const sendMessage = MessageModel.mutation('send', {
  document: MessageSendDocument,
  result: 'messageSend',
  optimistic: {
    model: MessageModel,
    selectServerNode: data => data.messageSend.message,
    respond: (input: SendMessageInput, ctx) => ({
      messageSend: { message: { id: ctx.tempId, chatId: input.chatId, text: input.text, createdAt: new Date().toISOString() } }
    }),
    prependTo: { scope: MessageModel.scopes.thread, value: input => ({ chatId: input.chatId }) }
  }
});
```

**Respond rollback.** Before the fabricated write applies, its inverse is captured per target - the
selected node's id, plus every `extract` sink row's id: a target with no existing row inverts to a
plain destroy (undoing the fabricated creation); a target that already had a row inverts to restore
that previous row and its captured scope memberships. On a thrown transport error this inverse plan
applies, so `extract`-sideloaded rows the fabricated response created are destroyed the same way the
primary fabricated row is, while any that already existed are restored rather than destroyed.

**Respond define-time validation.** `defineMutation` throws synchronously, before any network call,
if `respond` is combined with `build` or `method` - `{ model, respond }` cannot also declare an
Insert variant's `build` or a Patch/Destroy variant's `method`; `respond` is its own optimistic
shape, not a modifier on the other three.

**Rollback guarantees.** A thrown transport error (or a null `result` payload) undoes exactly the
optimistic write that ran: an inserted temp row is destroyed (untombstoned, so a later write can
reuse the id cleanly), a patch restores its previous field values, a destroy restores the previous
row and its captured scope memberships. Rollback runs before `onError` and before the mutation
promise rejects.

**Optimistic scope placement.** `prependTo`/`appendTo` declaratively place an Insert or Respond
variant's temp row at the top or bottom of a **server-order** scope (`sort: 'server-order'`, the
default - see [models.md](./models.md#scopespec)), instead of leaving it unplaced until the server
response arrives:

```ts
const sendMessage = MessageModel.mutation('send', {
  document: MessageSendDocument,
  result: 'messageSend',
  optimistic: {
    model: MessageModel,
    build: (input: SendMessageInput, ctx) => ({ id: ctx.tempId!, chatId: input.chatId, text: input.text, createdAt: new Date().toISOString() }),
    selectServerNode: data => data.messageSend.message,
    prependTo: { scope: MessageModel.scopes.thread, value: input => ({ chatId: input.chatId }) }
  }
});
```

Both take a `ScopePlacement<TInput>`: `{ scope, value: (input) => scopeValue }`, where `scope` is a
`ScopeHandle` from the SAME model as `optimistic.model` and `value(input)` derives that scope's
concrete value from the mutation input. `prependTo` and `appendTo` are mutually exclusive, and valid
only on the Insert and Respond variants - `defineMutation` throws synchronously, before any network
call, if either is combined with a `method: 'patch'`/`method: 'destroy'` optimistic config, if both
are set at once, if `scope` is not a server-order scope (a `sort: { field, dir }` or
custom-comparator scope rejects it), or if `scope` belongs to a different model than
`optimistic.model`. The assigned position survives the temp-id -> server-node replace - the same
edge/order captured for the temp row is carried over onto the committed server row in the same
transaction, so a message optimistically prepended into a thread stays at the top once the server
response lands. On rollback, destroying the temp row removes it from the scope's membership entirely,
restoring the scope to the order it had before the optimistic insert.

**Cascade-destroy guard.** `optimistic: { method: 'destroy' }` throws synchronously, before any
network call, if the target model has a `hasMany` relation with `dependent: 'destroy'` - an
optimistic destroy on that model would need to roll back a cascade of children it does not track,
so the guard refuses the mutation outright rather than leaving orphaned or resurrected children.

### Dedupe

`Model.mutation` turns dedupe on by default, keyed by `<modelId>:<name>:<inputHash>` (the input
hashed the same way scope values are hashed elsewhere in the DSL) - a committed key is never
re-sent and a pending key blocks a double-tap, with no config needed for the common case. Opt out
for a mutation that genuinely needs to resubmit identical input, e.g. a two-state toggle where a
third press should replay an input already dedupe-committed by the first:

```ts
const toggleRead = MessageModel.mutation('toggle-read', {
  dedupe: false,   // resubmitting the same { messageId } must always re-run - it flips state each time
  optimistic: { method: 'patch', model: MessageModel, selectId: input => input.messageId, selectPatch: input => ({ read: input.read }) },
  document: ToggleMessageReadDocument,
  result: 'messageToggleRead'
});
```

Pass a custom `dedupe: { key }` instead of `false` to keep dedupe on with a different key
derivation - e.g. keying on a subset of the input, or returning `null` to skip dedupe only for
specific inputs.

### `operationId` echo wiring with `Model.ingest`

Every mutation run gets a fresh `operationId` (`OptimisticCtx.operationId`), independent of
`dedupe`'s key. Send it to the server (typically via `mapInput`) so the server echoes it back on
the subscription event the mutation itself triggers; pass it through as `operationId` in the
declaration a `Model.ingest` handler returns (see [models.md](./models.md#modelingestentries)).
`Model.ingest` skips the whole event when that `operationId` already committed locally - the
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

## `defineCommand(name, config)`

The model-less counterpart to `Model.mutation`, for RPC-style mutations with no local optimistic
write of their own (sending a verification email, triggering a server-side export) - the same
lifecycle minus the `optimistic` step.

```ts
import { defineCommand } from '@noma4i/react-native-dblayer';

const resendVerificationEmail = defineCommand('resend-verification-email', {
  document: ResendVerificationEmailDocument,
  result: 'resendVerificationEmail',
  mapInput: (input: { userId: string }) => ({ userId: input.userId })
});

const { mutate, isPending } = resendVerificationEmail.use();
```

Takes the same `MutationConfig` minus `optimistic`, returns the same `{ use, run }` surface, and
gets the same dedupe defaults keyed by `<name>:<inputHash>` (`dedupe: false` to opt out, same as
`Model.mutation`).

## Error policy

A thrown mutation error always rejects `run`/`mutateAsync` (and reaches `mutate`'s `onError`
callback) after rollback has completed - errors are never swallowed. Independently, the same error
is reported to `DbDefaults.onSyncError` with `{ source: 'mutation' }` (see
[configuration.md](./configuration.md#onsyncerror-policy)), so app-wide error tracking does not need
to be wired into every call site. `onSyncError` observes the failure; it never changes whether the
mutation rejects.

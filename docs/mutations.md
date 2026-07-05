# Mutations

`useDbMutation` runs a GraphQL mutation as one transaction: an optimistic local write, the network call, then a
server write-through — with automatic rollback of every local change if anything throws. Returns a
`@tanstack/react-query` mutation (`{ mutate, mutateAsync, isPending, ... }`).

## Variant 1 — custom optimistic (`onMutate` + `onCommit`)

The most flexible form: you insert a temp row, then swap it for the server row.

```tsx
import { useDbMutation, generateTempId } from '@noma4i/react-native-dblayer';
import { SEND_MESSAGE } from './operations';

function useSendMessage() {
  return useDbMutation({
    key: () => ['sendMessage'],
    logPrefix: 'sendMessage',
    mutation: SEND_MESSAGE,
    resultField: 'sendMessage',                  // response.data.sendMessage
    onMutate: (input) => {                        // optimistic — shows instantly
      const temp = { id: generateTempId('msg'), chatId: input.chatId, body: input.body, pending: true };
      MessageModel.insertStored(temp);
      return { tempId: temp.id };                 // context -> onCommit / onError
    },
    onCommit: (data, _input, ctx) => {            // server write-through, inside the tx
      if (data) MessageModel.replaceRaw(ctx.tempId, data); // temp -> server row
    },
  });
}

function Composer({ chatId }: { chatId: string }) {
  const send = useSendMessage();
  return <Button title="Send" onPress={() => send.mutate({ chatId, body: 'hi' })} disabled={send.isPending} />;
}
```

If `SEND_MESSAGE` throws, the optimistic `insertStored` is rolled back automatically and `onError` (if provided)
runs before the error rethrows.

## Variant 2 — declarative patch (`method: 'patch'`)

For simple field updates, skip `onMutate`/`onCommit`:

```ts
const rename = useDbMutation({
  key: () => ['renameUser'],
  logPrefix: 'renameUser',
  mutation: RENAME_USER,
  resultField: 'renameUser',
  method: 'patch',
  model: UserModel,
  selectId: (input) => input.id,
  selectPatch: (input, current) => ({ name: input.name, version: (current?.version ?? 0) + 1 }),
});

rename.mutate({ id, name: 'New name' }); // optimistic patch, rolled back on error
```

## Variant 3 — declarative destroy (`method: 'destroy'`)

```ts
const remove = useDbMutation({
  key: () => ['deleteMessage'],
  logPrefix: 'deleteMessage',
  mutation: DELETE_MESSAGE,
  resultField: 'deleteMessage',
  method: 'destroy',
  model: MessageModel,
  selectId: (input) => input.id,
});

remove.mutate({ id: messageId }); // optimistic delete, restored on error
```

## Config reference

### Shared fields (all variants)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mutation` | `TypedDocumentNode<Record<string, TData>, { input }> \| DocumentNode` | **required** | The GraphQL mutation. |
| `resultField` | `string` | **required** | Field of `response.data` holding the result (e.g. `'sendMessage'`). |
| `key` | `() => readonly unknown[]` | **required** | Key factory (also single-flight de-dupe). |
| `logPrefix` | `string` | **required** | Log tag for `debug`/`error`. |
| `mapInput` | `(input) => unknown` | identity | Transform caller input → the mutation's `variables.input`. |
| `extract` | `DbExtractSpec` (`unknown`) | `—` | Side-load spec → mutation resolver → sink (source `'mutation'`). |
| `onCommit` | `(data, input, context) => void` | `—` | Server write-through. Runs in the tx, after the response, before commit. |
| `invalidate` | `(data, input) => void` | `—` | After commit — invalidate dependent queries. |
| `onError` | `(error, input, context) => void` | `—` | On failure, before rollback rethrows. |

### `method` undefined (Variant 1)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `onMutate` | `(input) => TContext` | `—` | Optimistic write; returns a context passed to `onCommit`/`onError`. |

### `method: 'patch'` (Variant 2)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `{ get, patch }` | **required** | The model to patch. |
| `selectId` | `(input) => string \| null` | **required** | Which row. |
| `selectPatch` | `(input, current?) => Record<string, unknown> \| null` | **required** | The patch; `current` is the existing row. `null` skips. |

### `method: 'destroy'` (Variant 3)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `{ destroy }` | **required** | The model to delete from. |
| `selectId` | `(input) => string \| null` | **required** | Which row to remove. |

### Lifecycle

```
mutate(input)
  → optimistic write        (onMutate | selectPatch/selectId)   [inside tx]
  → transport.mutation(...)  (network)
  → onCommit(...)            (server write-through)              [inside tx]
  → commit                                                        (persist)
  → invalidate(...)          (post-commit)
  ── on any throw ──▶ rollback (all tx writes undone) → onError → rethrow
```

## `useCommand(config)`

Fire-and-forget GraphQL command — no optimistic write, no transaction.

```ts
const track = useCommand({
  key: () => ['trackEvent'],
  logPrefix: 'trackEvent',
  mutation: TRACK_EVENT,
  resultField: 'trackEvent',
});
track.mutate({ name: 'opened_chat', chatId });
```

Resolved-per-input form when the operation depends on the input:

```ts
const doAction = useCommand({
  key: () => ['action'],
  logPrefix: 'action',
  resolve: (input) => ({ mutation: ACTION_MUTATIONS[input.kind], resultField: 'action', input }),
});
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `key` | `() => readonly unknown[]` | **required** | Command key (single-flight). |
| `logPrefix` | `string` | **required** | Log tag. |
| `mutation` | document | **required** (static form) | The mutation. |
| `resultField` | `string` | **required** (static form) | Response field to return. |
| `mapInput` | `(input) => unknown` | identity | Map input → `variables.input`. |
| `resolve` | `(input) => { mutation, resultField, input? }` | — (resolved form) | Per-input operation instead of static `mutation`/`resultField`. |

`useCommandMutation(config: DbCommandConfig)` is the lower-level primitive when you supply your own `mutationFn`
(fields: `key`, `logPrefix`, `mutationFn`, `singleFlightInput?`, `onSuccess?`, `onError?`, `onSettled?`).

## Non-React execution

`runDbMutationDirect(config, input)` runs the same `DbMutationConfig` outside React — same optimistic/commit/extract
logic without a component (e.g. an upload controller committing after a background task):

```ts
import { runDbMutationDirect } from '@noma4i/react-native-dblayer';

await runDbMutationDirect(sendMessageConfig, { chatId, body, attachmentUrl });
```

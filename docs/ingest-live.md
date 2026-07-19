# Ingest and live subscriptions

Subscription handling splits into two layers: **declaration** (what an event does to a model -
`Model.ingest`) and **runtime** (how declared entries subscribe to the transport and dispatch
payloads - `createDbSubscriptionRuntime` and friends). `Model.query`'s colocated `live` option
(see [queries.md](./queries.md#live-subscription-colocation)) is a third way to activate the exact
same declaration/apply pipeline, scoped to a mounted query reader instead of a manually-managed
runtime.

## Contents

- [`Model.ingest(entries)`](#modelingestentries)
- [`createDbSubscriptionRuntime(entries)`](#createdbsubscriptionruntimeentries)
- [`defineDbSubscriptionEntry(entry)`](#definedbsubscriptionentryentry)
- [`createDbSubscriptionEffects(noopEffects)`](#createdbsubscriptioneffectsnoopeffects)
- [Echo semantics](#echo-semantics)

## `Model.ingest(entries)`

Declares model-owned subscription handling: one entry per event name, applying rows, guards,
effects, and custom logic together. `Model.ingest` returns
`{ entries, apply(key, payload) }` - `entries` feeds directly into
`createDbSubscriptionRuntime(entries)` (see below); `apply(key, payload)` dispatches a
payload through the same pipeline imperatively (tests, or a transport delivering events outside the
subscription runtime).

Each entry is one of two forms:

**Handler form** - the exact atomic apply pipeline (rows, destroys, and `extract` sinks apply with
relation side effects in one epoch; stale-version arbitration stays in `merge.shouldOverwrite`, see
[models.md](./models.md#definemodelconfig)):

```ts
const messageIngest = MessageModel.ingest({
  messageCreated: { handler: payload => ({ upsert: payload.message, operationId: payload.clientOperationId }) },
  messageDeleted: { handler: payload => ({ destroy: payload.id, invalidate: true }) }
});
```

`handler(payload)` returns a declaration - `null` skips the event entirely:

| Field          | Type                     | Description                                                                                                                                                                                                               |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsert`       | `unknown \| unknown[]`     | Row(s) to write into this model as an event upsert.                                                                                                                                                                       |
| `destroy`      | `string \| string[]`       | Id(s) to destroy.                                                                                                                                                                                                          |
| `invalidate`   | `boolean`                  | Invalidate the model's registered queries after applying.                                                                                                                                                                 |
| `extract`      | `ExtractSink[]`             | Cross-model sideloads applied in the SAME transaction as the event rows.                                                                                                                                                  |
| `operationId`  | `string \| null`            | Echo guard: when this operation id already committed locally (via a `Model.mutation` run that sent the same id, see [Echo semantics](#echo-semantics) below), the whole event is skipped.                              |

**Fused declarative form** - when `handler` is omitted, `Model.ingest` compiles the subscription
entry and the apply logic from one declaration:

```ts
const messageIngest = MessageModel.ingest({
  messageCreated: {
    document: MessageCreatedDocument,
    payload: data => data.messageCreated,
    apply: 'upsert',
    echoGuard: payload => payload.clientId === localClientId
  },
  messageRead: {
    document: MessageReadDocument,
    guard: 'existing',
    apply: (payload, tools) => tools.model.patch(payload.messageId, { readAt: payload.readAt })
  }
});
```

| Field        | Type                                                  | Description                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `document`   | subscription document                                     | Subscription document passed to the configured transport. Required unless the entry is only ever driven through `apply(key, payload)`.                                                                                                    |
| `payload`    | `(data) => unknown`                                        | Transform the raw transport payload before `guard`/`effect`/`apply` see it.                                                                                                                                                                 |
| `apply`      | `'upsert' \| 'destroy' \| (payload, tools) => void`        | `'upsert'` (default) and `'destroy'` route through the exact handler-form pipeline above. A function gets `tools: { model, invalidate, operations, models }` for full custom logic - `models` is every `defineModel`, keyed by its `name`. |
| `guard`      | `'existing' \| (payload) => boolean`                       | `'existing'` applies only when the row already exists (e.g. read receipts); a function is a custom acceptance predicate.                                                                                                                   |
| `echoGuard`  | `(payload) => boolean`                                     | Return `true` to skip an own-echo subscription payload (an alternative to the handler form's `operationId` guard). See [Echo semantics](#echo-semantics).                                                                                  |
| `debounce`   | `{ ms, keyOf? }`                                            | Trailing debounce, delegated to the subscription runtime. See `createDbSubscriptionRuntime` below.                                                                                                                                          |
| `effect`     | `{ name, when: 'before' \| 'after' }`                       | Invoke a named effect injected via `createDbSubscriptionEffects` immediately before or after `apply`.                                                                                                                                       |

## `createDbSubscriptionRuntime(entries)`

```ts
import { createDbSubscriptionRuntime } from '@noma4i/react-native-dblayer';

const messageIngest = MessageModel.ingest({
  messageCreated: { handler: payload => ({ upsert: payload.message, operationId: payload.clientOperationId }) },
  messageDeleted: { handler: payload => ({ destroy: payload.id, invalidate: true }) }
});

const subscriptions = createDbSubscriptionRuntime(messageIngest.entries);

subscriptions.setActive(true); // requires transport.subscribe
// subscriptions.stop();        // final teardown
```

Runs a plain subscription runtime over the configured `DbTransport` (see
[getting-started.md](./getting-started.md#transport-seam)). Takes a `Model.ingest(...)` call's
`entries`, or a hand-built list of `defineDbSubscriptionEntry` entries. Returns a controller:
`setActive(active)` subscribes/unsubscribes every entry (first activation requires
`transport.subscribe`); `isActive()` reads the runtime-wide flag; `dispatch(key, payload)` manually
injects a payload into the same validate/debounce/handler pipeline transport events use (handy for
tests, and equivalent to calling `Model.ingest(...).apply(key, payload)` directly); `inspect()`
returns per-entry counters (`active`, `eventCount`, `lastEventAt`, `errorCount`); `stop()` is final
teardown for subscriptions and pending timers. A failed entry retries with exponential backoff (1s
up to 30s) while active.

## `defineDbSubscriptionEntry(entry)`

Defines one subscription entry whose key, variables, payload handler, and debounce key resolver are
inferred from a typed GraphQL document. `debounce?: { ms, keyOf? }` trailing-debounces `onData`;
omit `keyOf` to use one global bucket for the entry. Most apps never call this directly - it is the
primitive `Model.ingest`'s fused declarative form compiles down to.

## `createDbSubscriptionEffects(noopEffects)`

Creates an injectable effects channel for subscription entries that need to call into UI code
without importing it: entries call `channel.effects.onX(...)`, and the app injects real
implementations with `channel.configure(overrides)` when its effect owner mounts, calling
`channel.reset()` on teardown. The returned `effects` table and every wrapper keep one identity for
the channel's lifetime, so entries built once at module scope never need to rebind. `Model.ingest`'s
fused form's `effect: { name, when }` field wires into this channel.

## Echo semantics

Every mutation run gets a fresh `operationId` (`OptimisticCtx.operationId`, see
[mutations.md](./mutations.md#modelmutationname-config)), independent of `dedupe`'s key. Send it to
the server (typically via `mapInput`) so the server echoes it back on the subscription event the
mutation itself triggers; pass it through as `operationId` in the declaration a `Model.ingest`
handler returns (handler-form entries), or gate on it directly with `echoGuard` (fused-form
entries). Either way, `Model.ingest` skips the whole event when that operation already committed
locally - the mutation's own commit already applied the row, so the echoed subscription event is a
no-op instead of a duplicate write. See
[`operationId` echo wiring with `Model.ingest`](./mutations.md#operationid-echo-wiring-with-modelingest)
for the mutation-side half of this contract.

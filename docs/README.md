# API reference

Full reference for `@noma4i/react-native-dblayer`. For a guided tour with component examples, see the
[project README](../README.md).

## Contents

- [Configuration](./configuration.md) — `configureDb`, the transport/storage/logger/extract seams,
  `createMutationExtractResolver`, `createExtractSink`, and their adapter interfaces.
- [Models](./models.md) — `defineModel` options and the full `CollectionModel` read/write API.
- [Queries](./queries.md) — `useDbSingleRequest`, `modelDetailRequest`, `useDbInfiniteRequest`,
  `runDbQueryDirect`, their config options, and return shapes.
- [Stable views and list helpers](./queries.md#stable-view-and-list-hooks) — `useStableItems`, `useStableEntity`,
  `useOrderedEntities`, `useWindowedLoadMore`.
- [Mutations](./mutations.md) — `useDbMutation` (default / patch / destroy variants), `useCommand`,
  `runDbCommandDirect`, `runDbMutationDirect`.
- [Runtime primitives](./runtime-primitives.md) — optimistic subscription reconcile, cleanup helpers,
  optimistic ordering sequences, throttled single-flight, nested object patching, and singleton statics.

## Conventions used in these docs

- **Reactive** = a React hook. Call it at the top level of a component (or another hook); it re-renders the
  component when the underlying data changes. Reactive members are called out explicitly.
- **Snapshot** = a synchronous, one-shot read. Safe to call anywhere — event handlers, effects, subscription
  handlers, non-React code.
- **Default** column: `—` means the option is optional with no effect when omitted; a concrete value is the
  effective default the library applies; "TanStack Query" means the underlying `@tanstack/react-query` default
  applies.
- All ids are `string`. Rows must have a `string` `id`; an optional `updatedAt` (ISO string) enables the
  newer-wins timestamp gate on writes.

## One model surface

Drive models through the direct `CollectionModel` API: `Model.find(id)`, `Model.where(...)`,
`Model.applyServerData(...)`, related accessors, and row-level related chains. See [Models](./models.md).

Data is fetched with the [query DSL](./queries.md) and changed with the [mutation DSL](./mutations.md); both write
into the same collections your components read from.

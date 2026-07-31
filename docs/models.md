# Models

`defineModel(key, config)` creates one class-like singleton. The key is the stable storage and
diagnostic identity. The config declares every model-owned capability.

## `defineModel(key, config)`

```ts
const User = defineModel('User', {
  schema: UserSchema,
  relations: {},
  actions: {},
  events: {},
  statics: model => ({
    findByUuid: (uuid: string) => model.where({ uuid }).read()[0]
  })
});
```

Object-only construction is not public. Model capabilities are declared in the config and exposed
through the returned singleton.

## `ModelFacadeConfig`

| Option | Purpose |
| --- | --- |
| `schema` | Defines stored fields and input coercion. |
| `associations` | Lazily declares `belongsTo`, `hasOne`, and `hasMany` relationships. |
| `relations` | Declares flat local or GraphQL-backed relation methods. |
| `actions` | Declares model-owned GraphQL commands. |
| `events` | Declares typed subscription event handlers. |
| `sideloads` | Declares nested payload paths landed into other models. |
| `defaultOrder` | Sets the default local ordering. |
| `rowId` | Extracts an id from non-standard input. |
| `guard` | Rejects invalid model input. |
| `gc` | Marks rows as garbage-collection roots when set to `exempt`. |
| `maintenance` | Declares bounded row and temporary-row cleanup. |
| `write` | Declares field-group merge policy. |
| `statics` | Adds domain methods without exposing storage internals. |

## `RelationSpec`

| Option | Purpose |
| --- | --- |
| `by` | Maps relation parameters to stored fields. |
| `member` | Applies a local membership predicate. |
| `sort` | Uses client ordering or authoritative server order. |
| `retention` | Bounds retained relation members. |
| `remote` | Attaches `gql.connection` or `gql.single`. |

## Fields (`f`)

`defineShape` combines field declarations from `f`. `ModelStored<TModel>` infers the stored row,
`ModelInput<TModel>` infers accepted input, and `InferShapeStored<TShape>` infers directly from a
shape. `projectShape`, `readShape`, and `readShapeOrThrow` implement typed nested projection and
reading.

`scalar` exposes the same field codecs for individual transport values outside model and shape
normalization. `scalar.id.read(value)` returns a normalized string id or `undefined`;
`scalar.id.require(value, label)` returns the id or throws an error naming the input. The `str`,
`num`, `int`, `date`, and `bool` members follow the same contract, while `scalar.enum(values)`
creates a runtime-validating enum boundary. Consumers do not recreate scalar readers through
single-field shapes.

## Associations

```ts
const Message = defineModel('Message', {
  schema: MessageSchema,
  associations: () => ({
    chat: belongsTo(Chat, { foreignKey: 'chatId' }),
    author: belongsTo(User, { foreignKey: 'authorId' })
  })
});
```

`belongsTo`, `hasOne`, `hasMany`, and `references` compile association reads and write effects.
An association becomes a flat method such as `Message.chat(messageId)`, returning a `Relation`.
Dependent destruction, touch projection, and counter caches execute inside the owning write plan.
Use `modelRef<TStored>(key)` instead of a facade target when model associations form a cycle. The
key is the target model's persisted identity and the generic keeps the association result typed.

## GraphQL declarations

`gql.connection` and `gql.single` attach reads to relations. `gql.action` declares commands.
`gql.live` declares subscription events. These declarations do not create a second cache or public
query builder.

## Sideloads

`sideloads` maps nested payload paths to destination models. The ingest planner walks the graph,
deduplicates destinations, and commits all rows with the root row in one transaction.

## Local writes

`insert`, `insertMany`, `update`, `updateAll`, `destroy`, `destroyMany`, and `destroyAll` are
synchronous model methods. `build` applies schema defaults without persisting. All writes use the
same plan and persistence pipeline as network results.

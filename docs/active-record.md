# ActiveRecord DSL

A chainable, ergonomic layer over any `CollectionModel`. Purely additive — it calls the same model methods, so you
can mix it with the direct API freely.

## `query(model, filter?)`

Returns an **immutable** `ModelRelation<T>`. `.where()` returns a new relation (the original is unchanged), so
relations are safe to build and pass around.

```ts
const admins = query(UserModel).where({ role: 'admin' });
```

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `CollectionModel<TInput, TStored>` | **required** | The model to query. |
| `filter` | `Partial<TStored>` | `{}` | Initial filter (equivalent to `.where(filter)`). |

### `ModelRelation<T>`

`.where(filter)` shallow-merges the filter and returns a new relation. Terminals:

**Snapshot (synchronous — safe anywhere):**

| Method | Returns | Description |
| --- | --- | --- |
| `getAll()` | `T[]` | All matching rows. |
| `getFirst()` | `T \| undefined` | First matching row. |
| `getCount()` | `number` | Count of matching rows. |
| `getIds()` | `string[]` | Ids of matching rows. |

**Reactive (React hooks — call at the top level of a component):**

| Method | Returns | Description |
| --- | --- | --- |
| `all()` | `T[]` | Matching rows, live. |
| `first()` | `T \| undefined` | First matching row, live. |
| `count()` | `number` | Count, live. |
| `ids()` | `string[]` | Ids, live. |

**Writes (imperative — call anywhere):**

| Method | Returns | Description |
| --- | --- | --- |
| `update(patch: Partial<T>)` | `number` | Patch every matching row; returns how many were updated. |
| `delete()` | `number` | Delete every matching row; returns how many were removed. An empty filter deletes the whole collection. |

```tsx
// reactive, in a component:
const count = query(UserModel).where({ role: 'admin' }).count();

// snapshot + bulk, anywhere:
query(UserModel).where({ active: false }).update({ archived: true });
query(UserModel).where({ role: 'guest' }).delete();
const ids = query(UserModel).getIds();
```

## `instance(model, id)` / `useInstance(model, id)`

A single-row handle: `ModelInstance<T> = Readonly<T> & { update(patch): boolean; delete(): boolean }`.

| Function | Reactive? | Returns |
| --- | --- | --- |
| `instance(model, id)` | Snapshot | `ModelInstance<T> \| undefined` (undefined if the row is absent) |
| `useInstance(model, id)` | Reactive hook | `ModelInstance<T> \| undefined` (re-renders when the row changes) |

| Argument | Type | Description |
| --- | --- | --- |
| `model` | `CollectionModel<TInput, TStored>` | The model. |
| `id` | `string \| null \| undefined` | Row id; `null`/`undefined` → `undefined`. |

The instance carries the row's fields (read-only) plus:

| Method | Returns | Description |
| --- | --- | --- |
| `update(patch: Partial<T>)` | `boolean` | Patch this row (`model.patch(id, patch)`). `false` if the write is rejected. |
| `delete()` | `boolean` | Delete this row (`model.destroy(id)`). |

```tsx
function UserRow({ id }: { id: string }) {
  const user = useInstance(UserModel, id);
  if (!user) return null;
  return (
    <Row>
      <Text>{user.name}</Text>
      <Button title="Promote" onPress={() => user.update({ role: 'admin' })} />
      <Button title="Remove"  onPress={() => user.delete()} />
    </Row>
  );
}
```

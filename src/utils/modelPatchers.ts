import type { AnyDbShape, IdArrayPatcher, InferShapeStored, KeyedArrayPatcher, NestedObjectPatcher, PatchModel, RowId } from '../types';
import { readShapeOrThrow } from '../schema/shape';
import { isRecord } from './normalizeHelpers';

/**
 * Create immutable patch helpers for an array of keyed shape sub-rows.
 *
 * @param shape Shape used to normalize incoming sub-rows.
 * @param options Key field used for replacement/removal.
 * @returns Immutable `upsert` and `remove` helpers for nullable arrays.
 */
export const createKeyedArrayPatcher = <TShape extends AnyDbShape, TSub extends InferShapeStored<TShape>, TKey extends Extract<keyof TSub, string>>(
  shape: TShape,
  options: { key: TKey }
): KeyedArrayPatcher<TSub, TKey> => ({
  upsert(rows, input) {
    const next = readShapeOrThrow(shape, input, 'Keyed array patch item') as TSub;
    const keyValue = next[options.key];
    return [...(rows ?? []).filter(entry => entry[options.key] !== keyValue), next];
  },
  remove(rows, keyValue) {
    return (rows ?? []).filter(entry => entry[options.key] !== keyValue);
  }
});

/**
 * Create immutable patch helpers for id arrays.
 *
 * @returns Immutable `upsert` and `remove` helpers that tolerate nullish arrays.
 */
export const createIdArrayPatcher = (): IdArrayPatcher => ({
  upsert(ids, id, position) {
    const next = (ids ?? []).filter(existingId => existingId !== id);
    return position === 'prepend' ? [id, ...next] : [...next, id];
  },
  remove(ids, id) {
    return (ids ?? []).filter(existingId => existingId !== id);
  }
});

/**
 * Create a shallow patcher for a nullable nested object field.
 *
 * @param model Model used to read and patch the containing row.
 * @param field Nested object field to patch.
 * @param transform Function that derives a partial nested update from the current nested value and caller args.
 * @returns A patcher that returns `false` when the row or nested object is missing.
 */
export const createNestedObjectPatcher = <
  TRow extends RowId,
  TField extends Extract<keyof TRow, string>,
  TArgs extends unknown[],
  TNested extends object = NonNullable<TRow[TField]> & object
>(
  model: PatchModel<TRow>,
  field: TField,
  transform: (current: TNested, ...args: TArgs) => Partial<TNested>
): NestedObjectPatcher<TRow, TField, TArgs> => {
  return (id, ...args) => {
    const row = model.find(id);
    const current = row?.[field];
    if (!isRecord(current)) return false;

    model.update(id, {
      [field]: {
        ...(current as TNested),
        ...transform(current as TNested, ...args)
      }
    } as Partial<TRow>);
    return true;
  };
};

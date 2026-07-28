import type { AnyDbShape, IdArrayPatcher, InferShapeStored, KeyedArrayPatcher, NestedObjectPatcher, PatchModel, RowId } from '../types';
/**
 * Create immutable patch helpers for an array of keyed shape sub-rows.
 *
 * @param shape Shape used to normalize incoming sub-rows.
 * @param options Key field used for replacement/removal.
 * @returns Immutable `upsert` and `remove` helpers for nullable arrays.
 */
export declare const createKeyedArrayPatcher: <TShape extends AnyDbShape, TSub extends InferShapeStored<TShape>, TKey extends Extract<keyof TSub, string>>(shape: TShape, options: {
    key: TKey;
}) => KeyedArrayPatcher<TSub, TKey>;
/**
 * Create immutable patch helpers for id arrays.
 *
 * @returns Immutable `upsert` and `remove` helpers that tolerate nullish arrays.
 */
export declare const createIdArrayPatcher: () => IdArrayPatcher;
/**
 * Create a shallow patcher for a nullable nested object field.
 *
 * @param model Model used to read and patch the containing row.
 * @param field Nested object field to patch.
 * @param transform Function that derives a partial nested update from the current nested value and caller args.
 * @returns A patcher that returns `false` when the row or nested object is missing.
 */
export declare const createNestedObjectPatcher: <TRow extends RowId, TField extends Extract<keyof TRow, string>, TArgs extends unknown[], TNested extends object = NonNullable<TRow[TField]> & object>(model: PatchModel<TRow>, field: TField, transform: (current: TNested, ...args: TArgs) => Partial<TNested>) => NestedObjectPatcher<TRow, TField, TArgs>;
//# sourceMappingURL=modelPatchers.d.ts.map
import type { EmptyDefaultFieldSpec, FieldSpec } from './fieldSpec';
import type { AnyDbShape } from './infer';
import type { InferShapeStored } from './infer';
type ArrayItem = AnyDbShape | FieldSpec<any, any, any, any>;
type ArrayItemOut<TItem extends ArrayItem> = TItem extends AnyDbShape ? InferShapeStored<TItem> : TItem extends FieldSpec<any, infer TOut, any, any> ? TOut : never;
/**
 * Build field specs for declarative `defineModel({ fields })` schemas.
 *
 * Each builder reads from `input[key]` unless `.from(...)` changes the source.
 */
export declare const f: {
    /**
     * Read string values and skip every other input type.
     *
     * `null` is skipped until `.nullable()` or `.nullDefault()` is applied.
     *
     * @returns A field spec that stores `string`.
     */
    str: () => FieldSpec<unknown, string, "required", false>;
    /**
     * Read number values and skip every other input type.
     *
     * `null` is skipped until `.nullable()` or `.nullDefault()` is applied.
     *
     * @returns A field spec that stores `number`.
     */
    num: () => FieldSpec<unknown, number, "required", false>;
    /**
     * ISO-8601 date-time string field. Strings are kept as-is when parseable; `Date` instances and
     * epoch-milliseconds numbers are stored as `toISOString()`; unparseable values are dropped.
     * Stored as a string, so codepoint ordering (orderBy, DbWhereOp gt/lt) is chronological for
     * same-format ISO values.
     */
    date: () => FieldSpec<unknown, string, "required", false>;
    /**
     * Read boolean values and skip every other input type.
     *
     * `null` is skipped until `.nullable()` is applied.
     *
     * @returns A field spec that stores `boolean`.
     */
    bool: () => FieldSpec<unknown, boolean, "required", false>;
    /**
     * Read string or number ids and normalize them to strings.
     *
     * Empty, nullish, and non-scalar values are skipped.
     *
     * @returns A field spec that stores a string id.
     */
    id: () => FieldSpec<unknown, string, "required", false>;
    /**
     * Enum field with runtime validation: only the declared string values are stored; any other value
     * is dropped like other unreadable values. The stored type is the union of the declared literals -
     * pass an explicit generic for codegen enums: `f.enum<GqlKind>(Object.values(GqlKind))`.
     */
    enum: <TValue extends string>(values: readonly TValue[]) => FieldSpec<unknown, TValue, "required", false>;
    /**
     * Pass through any non-nullish raw value as the supplied TypeScript type.
     *
     * Use for JSON blobs or arrays that should not be normalized by field readers.
     *
     * @returns A field spec that stores the supplied raw type.
     */
    raw: <T>() => FieldSpec<unknown, T, "required", false>;
    /**
     * Read a value from the whole input object with a custom selector.
     *
     * Returning `undefined` skips the field; returning `null` is preserved only after `.nullable()`.
     *
     * @param read Selector that receives the full input object.
     * @returns A field spec that stores the selector output type.
     */
    custom: <TOut, TInput = unknown>(read: (input: TInput) => TOut | null | undefined) => FieldSpec<TInput, TOut, "required", false>;
    /**
     * Read a nested object through a reusable shape.
     *
     * Non-object and null inputs are skipped unless `.nullable()` or `.emptyDefault()` changes build-time behavior.
     *
     * @param shape Shape created by `defineShape`.
     * @returns A field spec that stores the shape output object.
     */
    object: <TShape extends AnyDbShape>(shape: TShape) => EmptyDefaultFieldSpec<unknown, InferShapeStored<TShape>, "required", false>;
    /**
     * Read arrays of shapes or scalar field specs and drop unreadable elements.
     *
     * Non-array inputs are skipped; null elements are never kept.
     *
     * @param item Shape or scalar field spec used to read each array element.
     * @returns A field spec that stores an array of readable element outputs.
     */
    array: <TItem extends ArrayItem>(item: TItem) => FieldSpec<unknown, ArrayItemOut<TItem>[], "required", false>;
};
export {};
//# sourceMappingURL=f.d.ts.map
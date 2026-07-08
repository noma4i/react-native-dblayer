export type FieldMode = 'required' | 'nullable' | 'optional' | 'optionalNullable';
export type FieldDefault<TOut> = TOut | (() => TOut);
type NullableMode<TMode extends FieldMode> = TMode extends 'optional' | 'optionalNullable' ? 'optionalNullable' : 'nullable';
type OptionalMode<TMode extends FieldMode> = TMode extends 'nullable' | 'optionalNullable' ? 'optionalNullable' : 'optional';
export interface FieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> {
    /** Read this field from a full input object and object key. */
    read: (input: TInput, key: string) => TOut | null | undefined;
    /** Read this field from an already-selected raw value. */
    readValue: FieldValueReader<TOut>;
    /** Current presence mode used by normalize and buildStored. */
    mode: TMode;
    /** Factory-time default used by buildStored when the caller omits this key. */
    factoryDefault?: FieldDefault<TOut>;
    /**
     * Preserve explicit `null` during normalize while still skipping `undefined`.
     *
     * buildStored fills omitted nullable fields with `null` unless `.default(...)` is present.
     *
     * @returns A field spec whose stored type includes `null`.
     */
    nullable: () => FieldSpec<TInput, TOut, NullableMode<TMode>, THasDefault>;
    /**
     * Allow normalize and buildStored to omit this key.
     *
     * Optional fields are not required by buildStored and receive no implicit value.
     *
     * @returns A field spec whose stored key is optional.
     */
    optional: () => FieldSpec<TInput, TOut, OptionalMode<TMode>, THasDefault>;
    /**
     * Convert missing or undefined normalize input to `null`.
     *
     * buildStored also fills omitted nullable fields with `null` unless `.default(...)` is present.
     *
     * @returns A nullable field spec that defaults missing normalize input to `null`.
     */
    nullDefault: () => FieldSpec<TInput, TOut, 'nullable', THasDefault>;
    /**
     * Provide a buildStored-only default for omitted fields.
     *
     * normalize still uses the reader/nullability rules; lazy defaults run for each buildStored call.
     *
     * @param value Stored value or factory used when buildStored omits the key.
     * @returns A field spec that no longer requires this key in buildStored input.
     */
    default: (value: FieldDefault<TOut>) => FieldSpec<TInput, TOut, TMode, true>;
    /**
     * Read this field from a selector result instead of `input[key]`.
     *
     * The selected value is passed to the same field reader and nullability rules.
     *
     * @param selector Source selector that receives the full input object.
     * @returns A field spec with the same output rules and a new input type.
     */
    from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode, THasDefault>;
}
export interface EmptyDefaultFieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> extends FieldSpec<TInput, TOut, TMode, THasDefault> {
    /**
     * Provide a buildStored-only zero-state default for nested object fields.
     *
     * The default is produced by reading the object shape from `{}` and is recomputed per buildStored call.
     *
     * @returns An object field spec that no longer requires this key in buildStored input.
     */
    emptyDefault: () => EmptyDefaultFieldSpec<TInput, TOut, TMode, true>;
}
/** Read a selected raw value into a stored field value. */
export type FieldValueReader<TOut> = (value: unknown) => TOut | null | undefined;
/** Select the raw source value for a field from an input object and key. */
export type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;
type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
    mode: TMode;
    selectSource: FieldSourceSelector<TInput>;
    readValue: FieldValueReader<TOut>;
    readNullableValue: FieldValueReader<TOut>;
    defaultNull: boolean;
    factoryDefault?: FieldDefault<TOut>;
};
/** Read `input[key]` when input is an object, otherwise return undefined. */
export declare const readObjectField: <TInput>(input: TInput, key: string) => unknown;
/** Wrap a value reader so explicit null is preserved. */
export declare const preserveNull: <TOut>(readValue: FieldValueReader<TOut>) => FieldValueReader<TOut>;
/** Create a chainable field spec from low-level reader functions. */
export declare const createFieldSpec: <TInput, TOut, TMode extends FieldMode, THasDefault extends boolean = false>(options: FieldSpecOptions<TInput, TOut, TMode>) => FieldSpec<TInput, TOut, TMode, THasDefault>;
export {};
//# sourceMappingURL=fieldSpec.d.ts.map
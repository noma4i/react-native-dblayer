import type { FieldDefault, FieldMode, FieldSpec, FieldValueReader } from '../types';
/** Select the raw source value for a field from an input object and key. */
type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;
export declare const fieldSpecSparseRead: unique symbol;
type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
    kind: string;
    mode: TMode;
    selectSource: FieldSourceSelector<TInput>;
    readValue: FieldValueReader<TOut>;
    readNullableValue: FieldValueReader<TOut>;
    derived?: boolean;
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
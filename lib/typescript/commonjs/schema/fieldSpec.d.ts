export type FieldMode = 'required' | 'nullable' | 'optional' | 'optionalNullable';
export type FieldDefault<TOut> = TOut | (() => TOut);
type NullableMode<TMode extends FieldMode> = TMode extends 'optional' | 'optionalNullable' ? 'optionalNullable' : 'nullable';
type OptionalMode<TMode extends FieldMode> = TMode extends 'nullable' | 'optionalNullable' ? 'optionalNullable' : 'optional';
export interface FieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> {
    read: (input: TInput, key: string) => TOut | null | undefined;
    readValue: FieldValueReader<TOut>;
    mode: TMode;
    factoryDefault?: FieldDefault<TOut>;
    nullable: () => FieldSpec<TInput, TOut, NullableMode<TMode>, THasDefault>;
    optional: () => FieldSpec<TInput, TOut, OptionalMode<TMode>, THasDefault>;
    nullDefault: () => FieldSpec<TInput, TOut, 'nullable', THasDefault>;
    default: (value: FieldDefault<TOut>) => FieldSpec<TInput, TOut, TMode, true>;
    from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode, THasDefault>;
}
export interface EmptyDefaultFieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> extends FieldSpec<TInput, TOut, TMode, THasDefault> {
    emptyDefault: () => EmptyDefaultFieldSpec<TInput, TOut, TMode, true>;
}
export type FieldValueReader<TOut> = (value: unknown) => TOut | null | undefined;
export type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;
type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
    mode: TMode;
    selectSource: FieldSourceSelector<TInput>;
    readValue: FieldValueReader<TOut>;
    readNullableValue: FieldValueReader<TOut>;
    defaultNull: boolean;
    factoryDefault?: FieldDefault<TOut>;
};
export declare const readObjectField: <TInput>(input: TInput, key: string) => unknown;
export declare const preserveNull: <TOut>(readValue: FieldValueReader<TOut>) => FieldValueReader<TOut>;
export declare const createFieldSpec: <TInput, TOut, TMode extends FieldMode, THasDefault extends boolean = false>(options: FieldSpecOptions<TInput, TOut, TMode>) => FieldSpec<TInput, TOut, TMode, THasDefault>;
export {};
//# sourceMappingURL=fieldSpec.d.ts.map
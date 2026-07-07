export type FieldMode = 'required' | 'nullable' | 'optional' | 'optionalNullable';
type NullableMode<TMode extends FieldMode> = TMode extends 'optional' | 'optionalNullable' ? 'optionalNullable' : 'nullable';
type OptionalMode<TMode extends FieldMode> = TMode extends 'nullable' | 'optionalNullable' ? 'optionalNullable' : 'optional';
export interface FieldSpec<TInput, TOut, TMode extends FieldMode = 'required'> {
    read: (input: TInput, key: string) => TOut | null | undefined;
    readValue: FieldValueReader<TOut>;
    mode: TMode;
    nullable: () => FieldSpec<TInput, TOut, NullableMode<TMode>>;
    optional: () => FieldSpec<TInput, TOut, OptionalMode<TMode>>;
    nullDefault: () => FieldSpec<TInput, TOut, 'nullable'>;
    from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode>;
}
export type FieldValueReader<TOut> = (value: unknown) => TOut | null | undefined;
export type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;
type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
    mode: TMode;
    selectSource: FieldSourceSelector<TInput>;
    readValue: FieldValueReader<TOut>;
    readNullableValue: FieldValueReader<TOut>;
    defaultNull: boolean;
};
export declare const readObjectField: <TInput>(input: TInput, key: string) => unknown;
export declare const preserveNull: <TOut>(readValue: FieldValueReader<TOut>) => FieldValueReader<TOut>;
export declare const createFieldSpec: <TInput, TOut, TMode extends FieldMode>(options: FieldSpecOptions<TInput, TOut, TMode>) => FieldSpec<TInput, TOut, TMode>;
export {};
//# sourceMappingURL=fieldSpec.d.ts.map
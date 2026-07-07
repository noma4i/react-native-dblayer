import type { FieldSpec } from './fieldSpec';
import type { InferStoredFields } from './infer';
type SchemaFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;
export type DbSchema<TInput, TFields extends SchemaFields<TInput>> = {
    fields: TFields;
    normalize: (input: TInput) => (Partial<InferStoredFields<TFields>> & {
        id: string;
    }) | null;
};
export declare const compositeId: <TInput>(...selectors: Array<(input: TInput) => unknown>) => ((input: TInput) => string | null);
export declare const createSchema: <TInput, TFields extends SchemaFields<TInput>>(config: {
    fields: TFields;
    rowId?: (input: TInput) => string | null | undefined;
    guard?: (input: TInput) => boolean;
}) => DbSchema<TInput, TFields>;
export {};
//# sourceMappingURL=schema.d.ts.map
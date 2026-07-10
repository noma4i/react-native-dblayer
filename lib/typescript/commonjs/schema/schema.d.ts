import type { FieldSpec } from './fieldSpec';
import type { InferStoredFields } from './infer';
type SchemaFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;
export type DbSchema<TInput, TFields extends SchemaFields<TInput>> = {
    fields: TFields;
    normalize: (input: TInput) => (Partial<InferStoredFields<TFields>> & {
        id: string;
    }) | null;
};
/**
 * Build a row-id resolver by joining normalized own-key reads or selector outputs with `:`.
 *
 * @param parts Own-property keys or functions that read id parts from an input object.
 * @returns A resolver that returns `null` when any key/selector is unreadable or yields an empty part.
 */
export declare function compositeId(...keys: string[]): (input: unknown) => string | null;
export declare function compositeId<TInput>(...selectors: Array<(input: TInput) => unknown>): (input: TInput) => string | null;
export declare const createSchema: <TInput, TFields extends SchemaFields<TInput>>(config: {
    fields: TFields;
    rowId?: (input: TInput) => string | null | undefined;
    guard?: (input: TInput) => boolean;
}) => DbSchema<TInput, TFields>;
export {};
//# sourceMappingURL=schema.d.ts.map
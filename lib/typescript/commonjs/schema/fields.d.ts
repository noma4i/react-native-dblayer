import type { FieldSpec } from './fieldSpec';
declare const fieldsInputType: unique symbol;
type FieldMap = Record<string, FieldSpec<any, any, any, any>>;
/** Field map carrying the raw input type used by model normalization. */
export type DefinedFields<TInput, TFields extends FieldMap> = TFields & {
    readonly [fieldsInputType]: (input: TInput) => TInput;
};
export {};
//# sourceMappingURL=fields.d.ts.map
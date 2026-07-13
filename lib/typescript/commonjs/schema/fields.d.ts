import type { FieldSpec } from './fieldSpec';
declare const fieldsInputType: unique symbol;
type FieldMap = Record<string, FieldSpec<any, any, any, any>>;
/** Field map carrying the raw input type used by model normalization. */
export type DefinedFields<TInput, TFields extends FieldMap> = TFields & {
    readonly [fieldsInputType]: (input: TInput) => TInput;
};
/** Infer the branded raw input type of a field map, or `unknown` for a plain map. */
export type InferFieldsInput<TFields, TFallback = unknown> = TFields extends {
    readonly [fieldsInputType]: (input: infer TInput) => infer TInput;
} ? TInput : TFallback;
export {};
//# sourceMappingURL=fields.d.ts.map
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
/**
 * Attach a raw input type to a declarative field map without changing it at runtime.
 *
 * Plain field maps remain valid and normalize `unknown`. Use this helper when callers of
 * `Model.normalize` should be checked against a concrete transport or domain input contract.
 *
 * @returns A field-map factory that preserves the provided fields and brands their input type.
 */
export declare const defineFields: <TInput>() => <TFields extends FieldMap>(fields: TFields) => DefinedFields<TInput, TFields>;
export {};
//# sourceMappingURL=fields.d.ts.map
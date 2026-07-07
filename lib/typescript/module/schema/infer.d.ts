import type { FieldMode, FieldSpec } from './fieldSpec';
import type { DbSchema } from './schema';
import type { DbShape } from './shape';
type Simplify<T> = {
    [K in keyof T]: T[K];
} & {};
export type AnyFieldSpec = FieldSpec<any, any, any, any>;
export type AnyFields = Record<string, AnyFieldSpec>;
type FieldValue<TField> = TField extends FieldSpec<any, infer TOut, any, any> ? TOut : never;
type FieldSpecMode<TField> = TField extends FieldSpec<any, any, infer TMode, any> ? TMode : never;
type FieldSpecHasDefault<TField> = TField extends FieldSpec<any, any, any, infer THasDefault> ? THasDefault : false;
type RequiredKeys<TFields extends AnyFields> = {
    [K in keyof TFields]: FieldSpecMode<TFields[K]> extends 'required' | 'nullable' ? K : never;
}[keyof TFields];
type OptionalKeys<TFields extends AnyFields> = {
    [K in keyof TFields]: FieldSpecMode<TFields[K]> extends 'optional' | 'optionalNullable' ? K : never;
}[keyof TFields];
type RequiredKeysWithoutDefaults<TFields extends AnyFields> = {
    [K in keyof TFields]: FieldSpecMode<TFields[K]> extends 'required' ? (FieldSpecHasDefault<TFields[K]> extends true ? never : K) : never;
}[keyof TFields];
type RequiredFieldValue<TField> = FieldSpecMode<TField> extends 'nullable' ? FieldValue<TField> | null : FieldValue<TField>;
type OptionalFieldValue<TField> = FieldSpecMode<TField> extends 'optionalNullable' ? FieldValue<TField> | null : FieldValue<TField>;
export type FieldModeValue<TValue, TMode extends FieldMode> = TMode extends 'nullable' ? TValue | null : TMode extends 'optionalNullable' ? TValue | null : TValue;
type InferFieldObject<TFields extends AnyFields> = Simplify<{
    [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>;
} & {
    [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]>;
}>;
export type InferStoredFields<TFields extends AnyFields> = Simplify<{
    id: string;
} & InferFieldObject<TFields>>;
type BuildStoredRequiredKeys<TFields extends AnyFields> = 'id' | Extract<RequiredKeysWithoutDefaults<TFields>, keyof InferStoredFields<TFields>>;
export type InferBuildStoredInput<TFields extends AnyFields> = Simplify<Partial<InferStoredFields<TFields>> & Pick<InferStoredFields<TFields>, BuildStoredRequiredKeys<TFields>>>;
export type AnyDbSchema = DbSchema<any, AnyFields>;
export type AnyDbShape = DbShape<any, AnyFields>;
export type InferStored<S extends AnyDbSchema> = S extends DbSchema<any, infer TFields> ? InferStoredFields<TFields> : never;
export type InferInput<S extends AnyDbSchema> = S extends DbSchema<infer TInput, any> ? TInput : never;
export type InferSparseInput<S extends AnyDbSchema> = Simplify<Partial<InferStored<S>> & {
    id: string;
}>;
export type InferShapeStored<S extends AnyDbShape> = S extends DbShape<any, infer TFields> ? InferFieldObject<TFields> : never;
export type ModelStored<M> = M extends {
    getAll: () => Array<infer TStored>;
} ? TStored : never;
export type ModelInput<M> = Simplify<Partial<ModelStored<M>> & {
    id: string;
}>;
export {};
//# sourceMappingURL=infer.d.ts.map
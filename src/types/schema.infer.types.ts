import type { FieldSpec } from './schema.fieldSpec.types';
import type { DbShape } from './schema.shape.types';

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type FieldKeys<TFields extends AnyFields> = Extract<keyof TFields, string>;
type FieldValue<TField> = TField extends FieldSpec<any, infer TOut, any, any> ? TOut : never;
type FieldSpecMode<TField> = TField extends FieldSpec<any, any, infer TMode, any> ? TMode : never;
type FieldSpecHasDefault<TField> = TField extends FieldSpec<any, any, any, infer THasDefault> ? THasDefault : false;
type RequiredKeys<TFields extends AnyFields> = {
  [K in FieldKeys<TFields>]: FieldSpecMode<TFields[K]> extends 'required' | 'nullable' ? K : never;
}[FieldKeys<TFields>];
type OptionalKeys<TFields extends AnyFields> = {
  [K in FieldKeys<TFields>]: FieldSpecMode<TFields[K]> extends 'optional' | 'optionalNullable' ? K : never;
}[FieldKeys<TFields>];
type RequiredKeysWithoutDefaults<TFields extends AnyFields> = {
  [K in FieldKeys<TFields>]: FieldSpecMode<TFields[K]> extends 'required' ? (FieldSpecHasDefault<TFields[K]> extends true ? never : K) : never;
}[FieldKeys<TFields>];
type RequiredFieldValue<TField> = FieldSpecMode<TField> extends 'nullable' ? FieldValue<TField> | null : FieldValue<TField>;
type OptionalFieldValue<TField> = FieldSpecMode<TField> extends 'optionalNullable' ? FieldValue<TField> | null : FieldValue<TField>;
type InferFieldObject<TFields extends AnyFields> = Simplify<
  {
    [K in RequiredKeys<TFields>]: RequiredFieldValue<TFields[K]>;
  } & {
    [K in OptionalKeys<TFields>]?: OptionalFieldValue<TFields[K]>;
  }
>;
type BuildRequiredKeys<TFields extends AnyFields> = 'id' | Extract<RequiredKeysWithoutDefaults<TFields>, keyof InferStoredFields<TFields>>;

export type AnyFieldSpec = FieldSpec<any, any, any, any>;
export type AnyFields = Record<string, AnyFieldSpec>;
export type InferStoredFields<TFields extends AnyFields> = Simplify<{ id: string } & InferFieldObject<TFields>>;
export type InferBuildInput<TFields extends AnyFields> = Simplify<Partial<InferStoredFields<TFields>> & Pick<InferStoredFields<TFields>, BuildRequiredKeys<TFields>>>;
export type AnyDbShape = DbShape<any, AnyFields>;
export type InferShapeStored<S extends AnyDbShape> = S extends DbShape<any, infer TFields> ? InferFieldObject<TFields> : never;
type MethodResult<TMethod> = TMethod extends (...args: never[]) => infer TResult ? TResult : never;

export type ModelStored<M> = M extends { find: infer TFind }
  ? NonNullable<MethodResult<TFind>>
  : M extends { all: () => Array<infer TStored> }
    ? TStored
    : never;
export type ModelInput<M> = M extends { insert(row: infer TInput): void } ? TInput : Simplify<Partial<ModelStored<M>> & { id: string }>;

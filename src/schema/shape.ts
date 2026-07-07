import type { FieldSpec } from './fieldSpec';
import type { InferShapeStored } from './infer';

type ShapeFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;

export type DbShape<TInput, TFields extends ShapeFields<TInput>> = {
  fields: TFields;
};

export type AnyDbShape = DbShape<any, ShapeFields<any>>;

const isReadableObject = (input: unknown): input is Record<string, unknown> => typeof input === 'object' && input !== null && !Array.isArray(input);

export const defineShape =
  <TInput = unknown>() =>
  <TFields extends ShapeFields<TInput>>(fields: TFields): DbShape<TInput, TFields> => ({
    fields
  });

export const readShape = <TInput, TFields extends ShapeFields<TInput>>(shape: DbShape<TInput, TFields>, input: unknown): InferShapeStored<DbShape<TInput, TFields>> | undefined => {
  if (!isReadableObject(input)) return undefined;

  const output: Record<string, unknown> = {};

  for (const key of Object.keys(shape.fields)) {
    const value = shape.fields[key]!.read(input as TInput, key);
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output as InferShapeStored<DbShape<TInput, TFields>>;
};

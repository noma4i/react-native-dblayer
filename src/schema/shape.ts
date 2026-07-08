import type { FieldSpec } from './fieldSpec';
import type { InferShapeStored } from './infer';

type ShapeFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;

export type DbShape<TInput, TFields extends ShapeFields<TInput>> = {
  fields: TFields;
};

export type AnyDbShape = DbShape<any, ShapeFields<any>>;

const isReadableObject = (input: unknown): input is Record<string, unknown> => typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * Define a reusable nested field group for object and array fields.
 *
 * @param fields Field specs keyed by stored nested-object properties.
 * @returns Shape metadata consumable by `f.object`, `f.array`, and shape readers.
 */
export const defineShape =
  <TInput = unknown>() =>
  <TFields extends ShapeFields<TInput>>(fields: TFields): DbShape<TInput, TFields> => ({
    fields
  });

/**
 * Read an unknown payload through a shape and drop unreadable fields.
 *
 * @param shape Shape created by `defineShape`.
 * @param input Candidate object payload; non-objects and arrays return `undefined`.
 * @returns The normalized shape object, or `undefined` when the payload is not an object.
 */
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

/**
 * Read an unknown payload through a shape or throw a labelled error.
 *
 * @param shape Shape created by `defineShape`.
 * @param input Candidate object payload.
 * @param label Error prefix used when the payload is unreadable.
 * @returns The normalized shape object.
 */
export const readShapeOrThrow = <TInput, TFields extends ShapeFields<TInput>>(shape: DbShape<TInput, TFields>, input: unknown, label: string): InferShapeStored<DbShape<TInput, TFields>> => {
  const result = readShape(shape, input);
  if (result == null) {
    throw new Error(`${label}: invalid shape payload`);
  }
  return result;
};

/**
 * Project a wider source object into a shape's field set and apply overrides last.
 *
 * @param shape Shape created by `defineShape`.
 * @param source Source object containing at least some shape fields.
 * @param overrides Typed stored-field overrides that win over source values.
 * @returns The normalized shape projection.
 */
export const projectShape = <TInput, TFields extends ShapeFields<TInput>>(
  shape: DbShape<TInput, TFields>,
  source: object,
  overrides?: Partial<InferShapeStored<DbShape<TInput, TFields>>>
): InferShapeStored<DbShape<TInput, TFields>> => readShape(shape, { ...source, ...overrides }) as InferShapeStored<DbShape<TInput, TFields>>;

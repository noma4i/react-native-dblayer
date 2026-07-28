import type { AnyFields } from './schema.infer.types';

/** Field-map constraint carrying the raw input type parameter of a shape. */
export type ShapeFields<_TInput> = AnyFields;

export type DbShape<TInput, TFields extends ShapeFields<TInput>> = {
  fields: TFields;
};

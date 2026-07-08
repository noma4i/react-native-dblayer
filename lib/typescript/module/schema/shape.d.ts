import type { FieldSpec } from './fieldSpec';
import type { InferShapeStored } from './infer';
type ShapeFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;
export type DbShape<TInput, TFields extends ShapeFields<TInput>> = {
    fields: TFields;
};
export type AnyDbShape = DbShape<any, ShapeFields<any>>;
/**
 * Define a reusable nested field group for object and array fields.
 *
 * @param fields Field specs keyed by stored nested-object properties.
 * @returns Shape metadata consumable by `f.object`, `f.array`, and shape readers.
 */
export declare const defineShape: <TInput = unknown>() => <TFields extends ShapeFields<TInput>>(fields: TFields) => DbShape<TInput, TFields>;
/**
 * Read an unknown payload through a shape and drop unreadable fields.
 *
 * @param shape Shape created by `defineShape`.
 * @param input Candidate object payload; non-objects and arrays return `undefined`.
 * @returns The normalized shape object, or `undefined` when the payload is not an object.
 */
export declare const readShape: <TInput, TFields extends ShapeFields<TInput>>(shape: DbShape<TInput, TFields>, input: unknown) => InferShapeStored<DbShape<TInput, TFields>> | undefined;
/**
 * Read an unknown payload through a shape or throw a labelled error.
 *
 * @param shape Shape created by `defineShape`.
 * @param input Candidate object payload.
 * @param label Error prefix used when the payload is unreadable.
 * @returns The normalized shape object.
 */
export declare const readShapeOrThrow: <TInput, TFields extends ShapeFields<TInput>>(shape: DbShape<TInput, TFields>, input: unknown, label: string) => InferShapeStored<DbShape<TInput, TFields>>;
/**
 * Project a wider source object into a shape's field set and apply overrides last.
 *
 * @param shape Shape created by `defineShape`.
 * @param source Source object containing at least some shape fields.
 * @param overrides Typed stored-field overrides that win over source values.
 * @returns The normalized shape projection.
 */
export declare const projectShape: <TInput, TFields extends ShapeFields<TInput>>(shape: DbShape<TInput, TFields>, source: object, overrides?: Partial<InferShapeStored<DbShape<TInput, TFields>>>) => InferShapeStored<DbShape<TInput, TFields>>;
export {};
//# sourceMappingURL=shape.d.ts.map
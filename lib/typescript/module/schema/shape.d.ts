import type { FieldSpec } from './fieldSpec';
import type { DefinedFields } from './fields';
import type { InferShapeStored } from './infer';
type ShapeFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;
export type DbShape<TInput, TFields extends ShapeFields<TInput>> = {
    fields: TFields;
};
export type AnyDbShape = DbShape<any, ShapeFields<any>>;
/**
 * Define a reusable field group for model fields, object fields, and array items.
 *
 * @param fields Field specs keyed by stored nested-object properties.
 * @returns Shape metadata whose type-only branded `fields` retain `TInput` when passed to `defineModel`.
 */
export declare const defineShape: <TInput = unknown>() => <TFields extends ShapeFields<TInput>>(fields: TFields) => DbShape<TInput, DefinedFields<TInput, TFields>>;
/**
 * Read an unknown payload through a shape and drop unreadable fields.
 *
 * Shape reads are dense row projections: field-level null defaults and other
 * reader defaults are applied to build a full shape object.
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
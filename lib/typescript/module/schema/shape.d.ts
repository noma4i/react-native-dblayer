import type { FieldSpec } from './fieldSpec';
import type { InferShapeStored } from './infer';
type ShapeFields<TInput> = Record<string, FieldSpec<TInput, any, any>>;
export type DbShape<TInput, TFields extends ShapeFields<TInput>> = {
    fields: TFields;
};
export type AnyDbShape = DbShape<any, ShapeFields<any>>;
export declare const defineShape: <TInput = unknown>() => <TFields extends ShapeFields<TInput>>(fields: TFields) => DbShape<TInput, TFields>;
export declare const readShape: <TInput, TFields extends ShapeFields<TInput>>(shape: DbShape<TInput, TFields>, input: unknown) => InferShapeStored<DbShape<TInput, TFields>> | undefined;
export {};
//# sourceMappingURL=shape.d.ts.map
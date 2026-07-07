import type { FieldSpec } from './fieldSpec';
import type { AnyDbShape } from './infer';
import type { InferShapeStored } from './infer';
type ArrayItem = AnyDbShape | FieldSpec<any, any, any>;
type ArrayItemOut<TItem extends ArrayItem> = TItem extends AnyDbShape ? InferShapeStored<TItem> : TItem extends FieldSpec<any, infer TOut, any> ? TOut : never;
export declare const f: {
    str: () => FieldSpec<unknown, string, "required">;
    num: () => FieldSpec<unknown, number, "required">;
    bool: () => FieldSpec<unknown, boolean, "required">;
    id: () => FieldSpec<unknown, string, "required">;
    enum: <T>() => FieldSpec<unknown, T, "required">;
    raw: <T>() => FieldSpec<unknown, T, "required">;
    custom: <TOut, TInput = unknown>(read: (input: TInput) => TOut | null | undefined) => FieldSpec<TInput, TOut, "required">;
    object: <TShape extends AnyDbShape>(shape: TShape) => FieldSpec<unknown, InferShapeStored<TShape>, "required">;
    array: <TItem extends ArrayItem>(item: TItem) => FieldSpec<unknown, ArrayItemOut<TItem>[], "required">;
};
export {};
//# sourceMappingURL=f.d.ts.map
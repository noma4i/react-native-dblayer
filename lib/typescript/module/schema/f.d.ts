import type { FieldSpec } from './fieldSpec';
import type { AnyDbShape } from './infer';
import type { InferShapeStored } from './infer';
type ArrayItem = AnyDbShape | FieldSpec<any, any, any, any>;
type ArrayItemOut<TItem extends ArrayItem> = TItem extends AnyDbShape ? InferShapeStored<TItem> : TItem extends FieldSpec<any, infer TOut, any, any> ? TOut : never;
export declare const f: {
    str: () => FieldSpec<unknown, string, "required", false>;
    num: () => FieldSpec<unknown, number, "required", false>;
    bool: () => FieldSpec<unknown, boolean, "required", false>;
    id: () => FieldSpec<unknown, string, "required", false>;
    enum: <T>() => FieldSpec<unknown, T, "required", false>;
    raw: <T>() => FieldSpec<unknown, T, "required", false>;
    custom: <TOut, TInput = unknown>(read: (input: TInput) => TOut | null | undefined) => FieldSpec<TInput, TOut, "required", false>;
    object: <TShape extends AnyDbShape>(shape: TShape) => FieldSpec<unknown, InferShapeStored<TShape>, "required", false>;
    array: <TItem extends ArrayItem>(item: TItem) => FieldSpec<unknown, ArrayItemOut<TItem>[], "required", false>;
};
export {};
//# sourceMappingURL=f.d.ts.map
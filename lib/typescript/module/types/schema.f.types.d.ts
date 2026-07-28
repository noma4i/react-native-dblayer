import type { FieldSpec } from './schema.fieldSpec.types';
import type { AnyDbShape, InferShapeStored } from './schema.infer.types';
/** One `f.array` item declaration: a shape or a field spec. */
export type ArrayItem = AnyDbShape | FieldSpec<any, any, any, any>;
/** Stored output type for one `f.array` item declaration. */
export type ArrayItemOut<TItem extends ArrayItem> = TItem extends AnyDbShape ? InferShapeStored<TItem> : TItem extends FieldSpec<any, infer TOut, any, any> ? TOut : never;
//# sourceMappingURL=schema.f.types.d.ts.map
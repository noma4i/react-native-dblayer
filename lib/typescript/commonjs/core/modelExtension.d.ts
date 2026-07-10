import type { ModelExtension } from '../types';
/**
 * Define a named model extension that contributes class-level behavior.
 *
 * Every extension receives the unextended base model, so extensions cannot depend on declaration order.
 * `defineModel` merges extensions with `statics` and rejects duplicate or base-model keys.
 *
 * @param name Stable extension name included in collision errors.
 * @param extend Factory that builds the extension from the base model DSL.
 * @returns Extension descriptor accepted by `defineModel({ extensions: [...] })`.
 */
export declare const defineModelExtension: <TModel, TExtension extends object>(name: string, extend: (model: TModel) => TExtension) => ModelExtension<TModel, TExtension>;
//# sourceMappingURL=modelExtension.d.ts.map
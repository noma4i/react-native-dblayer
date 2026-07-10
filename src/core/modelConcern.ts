import type { ModelConcern } from '../types';

/**
 * Define a named model concern that contributes cohesive class-level behavior.
 *
 * Every concern receives the unextended base model, so concerns cannot depend on declaration order.
 * `defineModel` merges concern extensions with `statics` and rejects duplicate or base-model keys.
 *
 * @param name Stable concern name included in collision errors.
 * @param extend Factory that builds the concern extension from the base model DSL.
 * @returns Concern descriptor accepted by `defineModel({ concerns: [...] })`.
 */
export const defineModelConcern = <TModel, TExtension extends object>(
  name: string,
  extend: (model: TModel) => TExtension
): ModelConcern<TModel, TExtension> => ({ name, extend });

"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModelConcern = void 0;
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
const defineModelConcern = (name, extend) => ({
  name,
  extend
});
exports.defineModelConcern = defineModelConcern;
//# sourceMappingURL=modelConcern.js.map
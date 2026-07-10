"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModelExtension = void 0;
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
const defineModelExtension = (name, extend) => ({
  name,
  extend
});
exports.defineModelExtension = defineModelExtension;
//# sourceMappingURL=modelExtension.js.map
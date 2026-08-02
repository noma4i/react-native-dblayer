"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineCommand = void 0;
var _compileDbWhere = require("../core/compileDbWhere.js");
var _serialize = require("../core/serialize.js");
var _defineMutation = require("./defineMutation.js");
/**
 * Define a model-less GraphQL command with a conventional input-sensitive in-flight guard. Commands use
 * the standard mutation runner and hook lifecycle but cannot perform an optimistic model write. Set
 * `once: true` to retain committed keys until reset, or `dedupe: false` to disable the guard.
 *
 * @param name Stable command namespace used by the default dedupe key.
 * @param config Mutation document, response result field, optional dedupe/once policy, mapping, response WritePlan, and lifecycle callbacks.
 * @returns The same `{ run, retry, discard, use }` surface as `defineMutation`.
 */
const defineCommand = (name, config) => {
  const dedupe = config.dedupe === false ? false : config.dedupe ?? {
    key: input => (0, _serialize.compositeKey)(name, (0, _compileDbWhere.buildScopeKey)(input))
  };
  return (0, _defineMutation.defineMutation)({
    ...config,
    dedupe
  });
};
exports.defineCommand = defineCommand;
//# sourceMappingURL=defineCommand.js.map
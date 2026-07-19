"use strict";

import { buildScopeKey } from "../core/compileDbWhere.js";
import { defineMutation } from "./defineMutation.js";
/**
 * Define a model-less GraphQL command with a conventional input-sensitive in-flight guard. Commands use
 * the standard mutation runner and hook lifecycle but cannot perform an optimistic model write. Set
 * `once: true` to retain committed keys until reset, or `dedupe: false` to disable the guard.
 *
 * @param name Stable command namespace used by the default dedupe key.
 * @param config Mutation document, response result field, optional dedupe/once policy, mapping/extract, and lifecycle callbacks.
 * @returns The same `{ run, use }` surface as `defineMutation`.
 */
export const defineCommand = (name, config) => {
  const dedupe = config.dedupe === false ? false : config.dedupe ?? {
    key: input => `${name}:${buildScopeKey(input)}`
  };
  return defineMutation({
    ...config,
    dedupe
  });
};
//# sourceMappingURL=defineCommand.js.map
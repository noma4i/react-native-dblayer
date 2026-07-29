"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineMutation = exports.defineModelMutation = void 0;
var _mutationRuntime = require("./mutationRuntime.js");
var _mutationConfiguration = require("./mutationConfiguration.js");
var _mutationHook = require("./mutationHook.js");
var _serialize = require("../core/serialize.js");
const createDefinedMutation = (config, definitionId) => {
  (0, _mutationConfiguration.validateMutationConfig)(config);
  const runtime = (0, _mutationRuntime.createMutationRuntime)(config, definitionId);
  return {
    run: runtime.run,
    retry: runtime.retry,
    discard: runtime.discard,
    use: () => (0, _mutationHook.useMutationHandle)(runtime.run)
  };
};
const defineModelMutation = (definitionId, config) => createDefinedMutation(config, definitionId);

/**
 * Define hook and imperative mutation paths with one lifecycle: optimistic write -> transport call ->
 * single-transaction commit (or rollback of the optimistic write on error/dedupe-skip). Dedupe, extract
 * sinks, and lifecycle callbacks (`onMutate`/`onCommit`/`onError`/`invalidate`/`track`) all run through
 * the same `run` path for both the hook and the direct call.
 *
 * @param config Document, result field, optional optimistic write, in-flight dedupe key, `once` retention, extract sinks, and lifecycle callbacks.
 * @returns `{ run, use }`. `run(input)` executes one mutation outside React, resolving to the non-null payload
 * at the declared `result` field, or `null` when dedupe skipped it. `use()` is a hook returning `{ mutate, mutateAsync, isPending, error }`,
 * where `mutate` fires-and-forgets with optional `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
exports.defineModelMutation = defineModelMutation;
const defineMutation = config => {
  const modelId = config.optimistic?.model.modelId ?? '';
  return createDefinedMutation(config, (0, _serialize.compositeKey)(modelId, config.result));
};
exports.defineMutation = defineMutation;
//# sourceMappingURL=defineMutation.js.map
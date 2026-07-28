"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineMutation = void 0;
var _mutationRuntime = require("./mutationRuntime.js");
var _mutationConfiguration = require("./mutationConfiguration.js");
var _mutationHook = require("./mutationHook.js");
/**
 * Define hook and imperative mutation paths with one lifecycle: optimistic write -> transport call ->
 * single-transaction commit (or rollback of the optimistic write on error/dedupe-skip). Dedupe, extract
 * sinks, and lifecycle callbacks (`onMutate`/`onCommit`/`onError`/`invalidate`/`track`) all run through
 * the same `run` path for both the hook and the direct call.
 *
 * @param config Document, result field, optional optimistic write, in-flight dedupe key, `once` retention, extract sinks, and lifecycle callbacks.
 * @returns `{ run, use }`. `run(input)` executes one mutation outside React, resolving to the response data,
 * or `null` when dedupe skipped it. `use()` is a hook returning `{ mutate, mutateAsync, isPending, error }`,
 * where `mutate` fires-and-forgets with optional `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
const defineMutation = config => {
  (0, _mutationConfiguration.validateMutationConfig)(config);
  const runtime = (0, _mutationRuntime.createMutationRuntime)(config);
  return {
    run: runtime.run,
    retry: runtime.retry,
    discard: runtime.discard,
    use: () => (0, _mutationHook.useMutationHandle)(runtime.run)
  };
};
exports.defineMutation = defineMutation;
//# sourceMappingURL=defineMutation.js.map
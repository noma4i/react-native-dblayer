"use strict";

import { createMutationRuntime } from "./mutationRuntime.js";
import { validateMutationConfig } from "./mutationConfiguration.js";
import { useMutationHandle } from "./mutationHook.js";
import { compositeKey } from "../core/serialize.js";
const createDefinedMutation = (config, definitionId) => {
  validateMutationConfig(config);
  const runtime = createMutationRuntime(config, definitionId);
  return {
    run: runtime.run,
    retry: runtime.retry,
    discard: runtime.discard,
    use: () => useMutationHandle(runtime.run)
  };
};
export const defineModelMutation = (definitionId, config) => createDefinedMutation(config, definitionId);

/**
 * Define hook and imperative mutation paths with one lifecycle: optimistic write -> transport call ->
 * single-transaction commit (or rollback of the optimistic write on error/dedupe-skip). Dedupe, extract
 * sinks, and lifecycle callbacks (`onMutate`/`onCommit`/`onError`/`invalidate`/`track`) all run through
 * the same `run` path for both the hook and the direct call.
 *
 * @param config Document, result field, optional optimistic write, in-flight dedupe key, `once` retention, extract sinks, and lifecycle callbacks.
 * @returns `{ run, retry, discard, use }`. `run(input)` executes one mutation outside React, resolving to the non-null payload
 * at the declared `result` field, or `null` when dedupe skipped it. `retry(operationId)` re-runs a FAILED optimistic
 * operation from its persisted input; `discard(operationId)` drops a failed operation and its optimistic row. `use()` is a
 * hook returning `{ mutate, mutateAsync, isPending, error }`, where `mutate` fires-and-forgets with optional
 * `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
export const defineMutation = config => {
  const modelId = config.optimistic?.model.modelId ?? '';
  return createDefinedMutation(config, compositeKey(modelId, config.result));
};
//# sourceMappingURL=defineMutation.js.map
"use strict";

import { createMutationRuntime } from "./mutationRuntime.js";
import { validateMutationConfig } from "./mutationConfiguration.js";
import { useMutationHandle } from "./mutationHook.js";
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
export const defineMutation = config => {
  validateMutationConfig(config);
  const runtime = createMutationRuntime(config);
  return {
    run: runtime.run,
    retry: runtime.retry,
    discard: runtime.discard,
    use: () => useMutationHandle(runtime.run)
  };
};
//# sourceMappingURL=defineMutation.js.map
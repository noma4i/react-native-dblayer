import { createMutationRuntime } from './mutationRuntime';
import { validateMutationConfig } from './mutationConfiguration';
import { useMutationHandle, type MutationHandle } from './mutationHook';
import type { MutateCallbacks as MutationMutateCallbacks, MutationConfig, ScopePlacement as MutationScopePlacement } from '../types/dsl.mutation.types';

export type MutateCallbacks<TData> = MutationMutateCallbacks<TData>;
export type ScopePlacement<TInput> = MutationScopePlacement<TInput>;
export type DefinedMutation<TData, TInput> = {
  run(input: TInput): Promise<TData | null>;
  retry(tempId: string): Promise<TData | null>;
  discard(tempId: string): void;
  use(): MutationHandle<TData, TInput>;
};

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
export const defineMutation = <TData, TInput, TStored extends { id: string }, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>): DefinedMutation<TData, TInput> => {
  validateMutationConfig(config);
  const runtime = createMutationRuntime(config);
  return { run: runtime.run, retry: runtime.retry, discard: runtime.discard, use: () => useMutationHandle(runtime.run) };
};

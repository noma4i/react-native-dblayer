import type { DefinedMutation, MutationConfig } from '../types';
export declare const defineModelMutation: <TData, TInput, TStored extends {
    id: string;
}, TNode>(definitionId: string, config: MutationConfig<TData, TInput, TStored, TNode>) => DefinedMutation<TData, TInput>;
/**
 * Define hook and imperative mutation paths with one lifecycle: optimistic write -> transport call ->
 * single-transaction commit (or rollback of the optimistic write on error/dedupe-skip). Dedupe, response
 * WritePlan, and lifecycle callbacks (`onMutate`/`onError`/`track`) all run through
 * the same `run` path for both the hook and the direct call.
 *
 * @param config Document, result field, optional optimistic write, in-flight dedupe key, `once` retention, response WritePlan, and lifecycle callbacks.
 * @returns `{ run, retry, discard, use }`. `run(input)` executes one mutation outside React, resolving to the non-null payload
 * at the declared `result` field, or `null` when dedupe skipped it. `retry(operationId)` re-runs a FAILED optimistic
 * operation from its persisted input; `discard(operationId)` drops a failed operation and its optimistic row. `use()` is a
 * hook returning `{ mutate, mutateAsync, isPending, error }`, where `mutate` fires-and-forgets with optional
 * `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
export declare const defineMutation: <TData, TInput, TStored extends {
    id: string;
}, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => DefinedMutation<TData, TInput>;
//# sourceMappingURL=defineMutation.d.ts.map
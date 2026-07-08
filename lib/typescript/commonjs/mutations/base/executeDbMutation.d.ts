import type { DbMutationConfig } from '../../types';
/**
 * Execute only the network request portion of a DB mutation config.
 * @param config Mutation config containing the document and result field.
 * @param mappedInput Input already transformed for `variables.input`.
 * @returns Mutation result field or null.
 */
export declare const executeDbMutationRequest: <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>, mappedInput: unknown) => Promise<TData | null>;
/**
 * Apply extract side-loads and commit callback for a DB mutation result.
 * @param config Mutation config containing extract and commit callbacks.
 * @param result Mutation result field or null.
 * @param input Original caller input.
 * @param context Optimistic mutation context.
 * @returns void
 */
export declare const applyDbMutationCommit: <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>, result: TData | null, input: TInput, context: TContext) => void;
/**
 * Run a DB mutation config outside React without optimistic transaction handling.
 * Patch configs apply `selectPatch` and destroy configs remove the local row via `selectId` before the
 * transport call; neither rolls back when the request fails - the local write is unconditional and
 * permanent regardless of the transport outcome, same asymmetry as the `useDbMutation` hook path.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context passed to `onCommit`.
 * @returns Mutation result field or null.
 */
export declare const runDbMutationDirect: <TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown, TExtractSpec = unknown>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>, input: TInput, context?: TContext) => Promise<TData | null>;
//# sourceMappingURL=executeDbMutation.d.ts.map
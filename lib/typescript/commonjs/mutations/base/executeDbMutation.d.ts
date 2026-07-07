import type { DbMutationConfig } from '../../types';
/**
 * Execute only the network request portion of a DB mutation config.
 * @param config Mutation config containing the document and result field.
 * @param mappedInput Input already transformed for `variables.input`.
 * @returns Mutation result field or null.
 */
export declare const executeDbMutationRequest: <TData, TInput, TContext, TStored, TServerNode>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>, mappedInput: unknown) => Promise<TData | null>;
/**
 * Apply extract side-loads and commit callback for a DB mutation result.
 * @param config Mutation config containing extract and commit callbacks.
 * @param result Mutation result field or null.
 * @param input Original caller input.
 * @param context Optimistic mutation context.
 * @returns void
 */
export declare const applyDbMutationCommit: <TData, TInput, TContext, TStored, TServerNode>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>, result: TData | null, input: TInput, context: TContext) => void;
/**
 * Run a DB mutation config outside React without optimistic transaction handling.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context passed to `onCommit`.
 * @returns Mutation result field or null.
 */
export declare const runDbMutationDirect: <TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>, input: TInput, context?: TContext) => Promise<TData | null>;
//# sourceMappingURL=executeDbMutation.d.ts.map
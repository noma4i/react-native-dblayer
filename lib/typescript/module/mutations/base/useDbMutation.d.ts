import type { DbMutationConfig } from '../../types';
/**
 * React hook that runs a transactional GraphQL mutation with optimistic writes and rollback.
 * @param config Mutation document, optimistic variant, commit, extract, and invalidation options.
 * @returns React Query mutation result.
 *
 * @example
 * const sendMessage = useDbMutation({
 *   key: () => ['sendMessage'],
 *   logPrefix: 'sendMessage',
 *   mutation: SEND_MESSAGE,
 *   resultField: 'sendMessage',
 *   onMutate: input => {
 *     const tempId = generateTempId('message');
 *     MessageModel.insertStored({ id: tempId, body: input.body, pending: true });
 *     return { tempId };
 *   },
 *   onCommit: (message, _input, context) => {
 *     if (message) MessageModel.replaceRaw(context.tempId, message);
 *   }
 * });
 */
export declare const useDbMutation: <TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>) => import("@tanstack/react-query").UseMutationResult<TData | null, Error, TInput, unknown>;
//# sourceMappingURL=useDbMutation.d.ts.map
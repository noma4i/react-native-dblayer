import type { DbCommandMutationConfig } from '../../types';
/**
 * React hook for fire-and-forget GraphQL commands without optimistic writes.
 * @param config Static or per-input command mutation config.
 * @returns React Query mutation result.
 *
 * @example
 * const track = useCommand({
 *   key: () => ['trackEvent'],
 *   logPrefix: 'trackEvent',
 *   mutation: TRACK_EVENT,
 *   resultField: 'trackEvent'
 * });
 */
export declare const useCommand: <TData, TInput>(config: DbCommandMutationConfig<TInput, TData>) => import("@tanstack/react-query").UseMutationResult<TData, Error, TInput, unknown>;
//# sourceMappingURL=useCommand.d.ts.map
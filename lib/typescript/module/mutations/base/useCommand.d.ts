import type { DbCommandMutationConfig } from '../../types';
/**
 * Run a command mutation outside React without optimistic writes or invalidation.
 * @param config Same config accepted by `useCommand`; `key` and `logPrefix` are hook-only.
 * @param input Caller input.
 * @returns Command result field or null when the response field is missing.
 */
export declare const runDbCommandDirect: <TData, TInput, TExtractSpec = unknown>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>, input: TInput) => Promise<TData | null>;
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
export declare const useCommand: <TData, TInput, TExtractSpec = unknown>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>) => import("@tanstack/react-query").UseMutationResult<TData, Error, TInput, unknown>;
//# sourceMappingURL=useCommand.d.ts.map
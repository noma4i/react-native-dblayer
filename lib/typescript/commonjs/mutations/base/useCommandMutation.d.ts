import type { DbCommandConfig } from '../../types';
/**
 * React hook primitive for command-style mutations with opt-in single-flight dedupe.
 * @param config Command mutation function, key, logging, and lifecycle callbacks.
 * @returns React Query mutation result.
 */
export declare const useCommandMutation: <TData, TInput>(config: DbCommandConfig<TData, TInput>) => import("@tanstack/react-query").UseMutationResult<TData, Error, TInput, unknown>;
//# sourceMappingURL=useCommandMutation.d.ts.map
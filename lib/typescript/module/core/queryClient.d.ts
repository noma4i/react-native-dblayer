import type { QueryClient } from '@tanstack/react-query';
import type { CollectionModel } from '../types';
export declare const setDbQueryClient: (queryClient: QueryClient | null | undefined) => void;
/**
 * Read the configured QueryClient used by imperative DB request helpers.
 *
 * @returns The current QueryClient, or `null` when not configured.
 */
export declare const getDbQueryClient: () => QueryClient | null;
/**
 * Invalidate React Query entries for a DB request key.
 *
 * @param key Query key to invalidate.
 * @returns A promise that resolves after invalidation finishes or immediately when no QueryClient is configured.
 */
export declare const invalidateDbRequests: (key: readonly unknown[]) => Promise<void>;
/**
 * Clear model freshness metadata and invalidate the derived request key.
 *
 * @param model Collection model whose derived key and freshness metadata should be invalidated.
 * @param scope Optional stored-row filter scope; omit to invalidate every scope for the model.
 */
export declare const invalidateModel: (model: CollectionModel<any, any>, scope?: object) => void;
/**
 * Refetch React Query entries for a DB request key.
 *
 * @param key Query key to refetch.
 * @param opts Optional exact-match setting passed to React Query.
 * @returns A promise that resolves after refetch finishes or immediately when no QueryClient is configured.
 */
export declare const refetchDbRequests: (key: readonly unknown[], opts?: {
    exact?: boolean;
}) => Promise<void>;
/**
 * Cancel and clear every query in the configured QueryClient.
 *
 * @returns A promise that resolves after reset finishes or immediately when no QueryClient is configured.
 */
export declare const resetDbQueryRuntime: () => Promise<void>;
//# sourceMappingURL=queryClient.d.ts.map
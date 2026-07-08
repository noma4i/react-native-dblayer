import type { QueryClient } from '@tanstack/react-query';
import { deriveDbKey } from './deriveDbKey';
import { clearCollectionFetchStates } from './freshnessStorage';
import { getDbLogger } from './logger';
import type { CollectionModel } from '../types';

let dbQueryClient: QueryClient | null = null;

export const setDbQueryClient = (queryClient: QueryClient | null | undefined): void => {
  dbQueryClient = queryClient ?? null;
};

/**
 * Read the configured QueryClient used by imperative DB request helpers.
 *
 * @returns The current QueryClient, or `null` when not configured.
 */
export const getDbQueryClient = (): QueryClient | null => dbQueryClient;

const withDbQueryClient = (operation: string): QueryClient | null => {
  const queryClient = getDbQueryClient();
  if (!queryClient) {
    getDbLogger().error(`[${operation}] configureDb({ queryClient }) is required for imperative query operations.`);
    return null;
  }
  return queryClient;
};

/**
 * Invalidate React Query entries for a DB request key.
 *
 * @param key Query key to invalidate.
 * @returns A promise that resolves after invalidation finishes or immediately when no QueryClient is configured.
 */
export const invalidateDbRequests = async (key: readonly unknown[]): Promise<void> => {
  const queryClient = withDbQueryClient('invalidateDbRequests');
  if (!queryClient) return;
  await queryClient.invalidateQueries({ queryKey: key });
};

/**
 * Clear model freshness metadata and invalidate the derived request key.
 *
 * @param model Collection model whose derived key and freshness metadata should be invalidated.
 * @param scope Optional stored-row filter scope; omit to invalidate every scope for the model.
 */
export const invalidateModel = (model: CollectionModel<any, any>, scope?: object): void => {
  if (scope) {
    model.clearFetchState(scope);
  } else {
    getDbLogger().debug('db', 'freshness:clear', { model: model.collection.id, scope: undefined });
    clearCollectionFetchStates(model.collection.id);
  }
  void invalidateDbRequests(deriveDbKey(model, scope));
};

/**
 * Refetch React Query entries for a DB request key.
 *
 * @param key Query key to refetch.
 * @param opts Optional exact-match setting passed to React Query.
 * @returns A promise that resolves after refetch finishes or immediately when no QueryClient is configured.
 */
export const refetchDbRequests = async (key: readonly unknown[], opts?: { exact?: boolean }): Promise<void> => {
  const queryClient = withDbQueryClient('refetchDbRequests');
  if (!queryClient) return;
  await queryClient.refetchQueries({ queryKey: key, exact: opts?.exact ?? false });
};

/**
 * Cancel and clear every query in the configured QueryClient.
 *
 * @returns A promise that resolves after reset finishes or immediately when no QueryClient is configured.
 */
export const resetDbQueryRuntime = async (): Promise<void> => {
  const queryClient = withDbQueryClient('resetDbQueryRuntime');
  if (!queryClient) return;
  await queryClient.cancelQueries();
  queryClient.clear();
};

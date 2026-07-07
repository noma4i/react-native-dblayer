import type { QueryClient } from '@tanstack/react-query';
import { deriveDbKey } from './deriveDbKey';
import { getDbLogger } from './logger';
import type { CollectionModel } from '../types';

let dbQueryClient: QueryClient | null = null;

export const setDbQueryClient = (queryClient: QueryClient | null | undefined): void => {
  dbQueryClient = queryClient ?? null;
};

export const getDbQueryClient = (): QueryClient | null => dbQueryClient;

const withDbQueryClient = (operation: string): QueryClient | null => {
  const queryClient = getDbQueryClient();
  if (!queryClient) {
    getDbLogger().error(`[${operation}] configureDb({ queryClient }) is required for imperative query operations.`);
    return null;
  }
  return queryClient;
};

export const invalidateDbRequests = async (key: readonly unknown[]): Promise<void> => {
  const queryClient = withDbQueryClient('invalidateDbRequests');
  if (!queryClient) return;
  await queryClient.invalidateQueries({ queryKey: key });
};

export const invalidateModel = (model: CollectionModel<any, any>, scope?: object): void => {
  void invalidateDbRequests(deriveDbKey(model, scope));
};

export const refetchDbRequests = async (key: readonly unknown[], opts?: { exact?: boolean }): Promise<void> => {
  const queryClient = withDbQueryClient('refetchDbRequests');
  if (!queryClient) return;
  await queryClient.refetchQueries({ queryKey: key, exact: opts?.exact ?? false });
};

export const resetDbQueryRuntime = async (): Promise<void> => {
  const queryClient = withDbQueryClient('resetDbQueryRuntime');
  if (!queryClient) return;
  await queryClient.cancelQueries();
  queryClient.clear();
};

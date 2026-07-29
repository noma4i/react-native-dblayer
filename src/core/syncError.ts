import { getDbRuntimeConfig } from '../dsl/configure';
import type { DbDefaults } from '../types';
import { getDbLogger } from './logger';

/** Report one contained pipeline failure without allowing either the observer or logger to alter control flow. */
export const reportSyncError = (
  error: unknown,
  context: Parameters<NonNullable<DbDefaults['onSyncError']>>[1],
  owner: string
): Error => {
  const reported = error instanceof Error ? error : new Error(String(error));
  try {
    getDbRuntimeConfig().defaults.onSyncError?.(reported, context);
  } catch (observerError) {
    try {
      getDbLogger().error(`${owner} onSyncError failed`, { error: observerError });
    } catch {
      // Error observers and loggers cannot change the owning pipeline's outcome.
    }
  }
  return reported;
};

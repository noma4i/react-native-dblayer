import type { DbRetryPolicy } from '../../types';

/** The ONE exponential backoff formula behind every retry surface (query/mutation policy and subscription reconnects). */
export const backoffDelayMs = (attempt: number, baseMs = 1000, maxMs = 30000): number => Math.min(baseMs * Math.pow(2, attempt), maxMs);

export const retryDelayMs = (policy: DbRetryPolicy, error: unknown, attempt: number): number | null => {
  const classification = policy.classify?.(error) ?? 'fatal';
  if (classification === 'fatal' || attempt > (policy.budgets?.[classification] ?? 0)) return null;
  return backoffDelayMs(attempt, policy.backoff?.baseMs ?? 1000, policy.backoff?.maxMs ?? 30000);
};

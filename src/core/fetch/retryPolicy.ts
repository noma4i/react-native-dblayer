import type { DbRetryPolicy } from '../../types';

export const retryDelayMs = (policy: DbRetryPolicy, error: unknown, attempt: number): number | null => {
  const classification = policy.classify?.(error) ?? 'fatal';
  if (classification === 'fatal' || attempt > (policy.budgets?.[classification] ?? 0)) return null;
  const baseMs = policy.backoff?.baseMs ?? 1000;
  const maxMs = policy.backoff?.maxMs ?? 30000;
  return Math.min(baseMs * Math.pow(2, attempt), maxMs);
};

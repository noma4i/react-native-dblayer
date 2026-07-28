"use strict";

/** The ONE exponential backoff formula behind every retry surface (query/mutation policy and subscription reconnects). */
export const backoffDelayMs = (attempt, baseMs = 1000, maxMs = 30000) => Math.min(baseMs * Math.pow(2, attempt), maxMs);
export const retryDelayMs = (policy, error, attempt) => {
  const classification = policy.classify?.(error) ?? 'fatal';
  if (classification === 'fatal' || attempt > (policy.budgets?.[classification] ?? 0)) return null;
  return backoffDelayMs(attempt, policy.backoff?.baseMs ?? 1000, policy.backoff?.maxMs ?? 30000);
};
//# sourceMappingURL=retryPolicy.js.map
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.retryDelayMs = void 0;
const retryDelayMs = (policy, error, attempt) => {
  const classification = policy.classify?.(error) ?? 'fatal';
  if (classification === 'fatal' || attempt > (policy.budgets?.[classification] ?? 0)) return null;
  const baseMs = policy.backoff?.baseMs ?? 1000;
  const maxMs = policy.backoff?.maxMs ?? 30000;
  return Math.min(baseMs * Math.pow(2, attempt), maxMs);
};
exports.retryDelayMs = retryDelayMs;
//# sourceMappingURL=retryPolicy.js.map
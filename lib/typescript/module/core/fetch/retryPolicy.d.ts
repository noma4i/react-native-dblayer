import type { DbRetryPolicy } from '../../types';
/** The ONE exponential backoff formula behind every retry surface (query/mutation policy and subscription reconnects). */
export declare const backoffDelayMs: (attempt: number, baseMs?: number, maxMs?: number) => number;
export declare const retryDelayMs: (policy: DbRetryPolicy, error: unknown, attempt: number) => number | null;
//# sourceMappingURL=retryPolicy.d.ts.map
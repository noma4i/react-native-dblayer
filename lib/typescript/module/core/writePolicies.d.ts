import type { WriteCtx, WriteGroup } from '../types';
/**
 * Compile a closed, model-owned write declaration into the sole entity write gate.
 *
 * Monotonic policies run only for `snapshot` and `event` unless `on` narrows those origins; replace
 * remains authoritative. `server` uses incoming values, `continuity` retains nullish values,
 * `snapshot` shallow-folds objects, and nested-key policies protect declared object keys. `newerBy`
 * normalizes values through the date field codec before `isIncomingNewer`.
 */
export declare const compileWritePolicies: <TRow extends Record<string, unknown>>(groups: readonly WriteGroup[], modelId: string) => (previous: TRow, incoming: TRow, ctx: WriteCtx) => TRow;
//# sourceMappingURL=writePolicies.d.ts.map
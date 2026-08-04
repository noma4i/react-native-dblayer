import type { RowRecord, ScopeProjectionOptions, ScopeSortMeta, ScopeWindowSnapshot } from '../types';
export declare function useScopeReadRows<TOutput extends Record<string, unknown> = RowRecord>(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, isResolved: () => boolean, options: ScopeProjectionOptions<TOutput>): TOutput[];
/** One count for one row set: the same engine source that feeds `use()`/`useWindow` (`totalCount`), so a membership without a materialized row is never counted. */
export declare function useScopeReadCount(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, isResolved: () => boolean): number;
export declare function useScopeReadWindowRows(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, windowSize: number, isResolved: () => boolean, options: ScopeProjectionOptions<Record<string, unknown>>): ScopeWindowSnapshot;
//# sourceMappingURL=scopeReadEngine.d.ts.map
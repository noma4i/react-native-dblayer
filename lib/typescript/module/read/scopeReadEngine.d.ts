import type { ProjectionOptions } from '../types';
type StoredRowShape = {
    id: string;
} & Record<string, unknown>;
type ScopeSortMeta = {
    kind: 'server-order';
} | {
    kind: 'field';
    field: string;
    dir: 'asc' | 'desc';
} | {
    kind: 'comparator';
};
type ScopeProjectionOptions<TOutput extends Record<string, unknown>> = ProjectionOptions<StoredRowShape, TOutput> & {
    keepPrevious?: boolean;
    require?: ReadonlyArray<string>;
};
type ScopeWindowSnapshot = {
    rows: StoredRowShape[];
    totalCount: number;
    isPreviousData: boolean;
    resolved: boolean;
};
export declare function useScopeReadRows<TOutput extends Record<string, unknown> = StoredRowShape>(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, isResolved: () => boolean, options?: ScopeProjectionOptions<TOutput>): TOutput[];
export declare function useScopeReadWindowRows(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, windowSize: number, isResolved: () => boolean, options?: ScopeProjectionOptions<Record<string, unknown>>): ScopeWindowSnapshot;
export {};
//# sourceMappingURL=scopeReadEngine.d.ts.map
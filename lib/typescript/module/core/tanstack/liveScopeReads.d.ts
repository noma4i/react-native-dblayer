import type { ApplyTarget } from '../apply/transaction';
import { type ProjectionOptions } from '../../read/projectionGate';
import { type StoredRowShape } from './facade';
type ScopeSortMeta = ReturnType<ApplyTarget[`scopeSortMeta`]>;
type ScopeLiveWindowSnapshot = {
    rows: StoredRowShape[];
    totalCount: number;
    isPreviousData: boolean;
    resolved: boolean;
};
type ScopeProjectionOptions<TOutput extends Record<string, unknown>> = ProjectionOptions<StoredRowShape, TOutput> & {
    keepPrevious?: boolean;
};
/**
 * Reads one scope through a shared TanStack live query projection.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @returns Ordered stored rows with stable identities until their content changes.
 */
export declare function useScopeLiveRows<TOutput extends Record<string, unknown> = StoredRowShape>(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, isResolved: () => boolean, options?: ScopeProjectionOptions<TOutput>): TOutput[];
/**
 * Reads a stable local window from one shared TanStack live query projection.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @param windowSize Number of leading rows included in the local window.
 * @returns Stable window rows and the complete shared scope count.
 */
export declare function useScopeLiveWindowRows(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, windowSize: number, isResolved: () => boolean, options?: ScopeProjectionOptions<Record<string, unknown>>): ScopeLiveWindowSnapshot;
export {};
//# sourceMappingURL=liveScopeReads.d.ts.map
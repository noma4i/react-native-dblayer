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
    /** Only rows with every one of these fields present render; a partial row (transient sideload/incomplete write) is held back until it lands. */
    require?: ReadonlyArray<string>;
};
/**
 * Reads one scope through a shared TanStack live query projection.
 *
 * `options.require` is a render-completeness contract: a row transiently missing one of those fields
 * (mid sideload/partial write, before the full row lands) is held back rather than handed to a
 * consumer that assumes the field is guaranteed. It reappears in this same read, through the same
 * snapshot/subscription path, the moment the missing field commits - no separate fetch or remount.
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
 * `options.require` gates rows the same way as `useScopeLiveRows` - a row missing a required field is
 * excluded before windowing, so `totalCount`/`hasMore` reflect the filtered set (a transiently partial
 * row never opens a hole in pagination), and it reappears once the field lands.
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
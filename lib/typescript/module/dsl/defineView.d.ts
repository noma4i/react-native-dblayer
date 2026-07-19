import { type KeepPreviousOption } from '../read/scopeRetention';
import type { ModelCore, ScopeHandle } from './defineModel';
type Row = {
    id: string;
    [key: string]: unknown;
};
type Included = Record<string, unknown>;
type ComputedInclude = [ModelCore<Row>, (row: Row) => string | string[] | null];
type RelationInclude = {
    require: readonly string[];
};
type IdInclude = {
    model: ModelCore<Row>;
    ids: (row: Row) => string | string[] | null;
    require?: readonly string[];
};
type IncludeConfig = string | ComputedInclude | RelationInclude | IdInclude;
export type ViewConfig<TItem> = {
    /** Declared scope name or scope handle on the model that owns the view. */
    source: string | ScopeHandle<Row, Record<string, unknown>>;
    /** Declared relation names or explicit target-model id resolvers keyed by the projection alias. An include may require stored fields: `undefined` is missing and `null` is present; incomplete related rows are delivered as absent. */
    include: Record<string, IncludeConfig>;
    /** Build one view item from a source row, resolved includes, and its source index. */
    select?: (row: Row, included: Included, ctx: {
        index: number;
    }) => TItem;
    /** Preserve an item reference while all listed projected keys are unchanged. */
    renderKeys?: string[];
};
export type ViewHandle<TItem, TScope> = {
    /** Reactively read every projected item; `keepPrevious` is opt-in for unresolved key handoffs. */
    use(scopeValue: TScope | null | undefined, opts?: KeepPreviousOption): TItem[];
    /** Reactively read a local window over the projected source scope. */
    useWindow(scopeValue: TScope | null | undefined, opts?: {
        pageSize?: number;
    } & KeepPreviousOption): ViewWindowResult<TItem>;
};
type ViewWindowResult<TItem> = {
    /** Current-key items, or retained previous-key items while `isPreviousData` is true. */
    rows: TItem[];
    /** Total count for the snapshot represented by `rows`. */
    totalCount: number;
    /** Whether more locally-synced items exist beyond the current window. */
    hasMore: boolean;
    /** Grow the local view window by one page without fetching from the network. */
    fetchNextPage: () => void;
    /** True only while rows belong to the previous scope key and the current key is unresolved. */
    isPreviousData: boolean;
};
/**
 * Compose a model scope with declared relations or computed target ids into one pinpoint-reactive view.
 *
 * @param model Source model that owns the named scope and declared relation includes.
 * @param name Stable view name used in validation errors.
 * @param config Source scope, include declarations, projection, and optional render identity keys.
 * @returns A hook handle with full-scope and local-window reads.
 */
export declare const defineView: <TItem, TScope>(model: ModelCore<Row>, name: string, config: ViewConfig<TItem>) => ViewHandle<TItem, TScope>;
export {};
//# sourceMappingURL=defineView.d.ts.map
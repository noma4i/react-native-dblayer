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
    /** Reactively read every projected item in the source scope. */
    use(scopeValue: TScope | null | undefined): TItem[];
    /** Reactively read a local window over the projected source scope. */
    useWindow(scopeValue: TScope | null | undefined, opts?: {
        pageSize?: number;
    }): {
        rows: TItem[];
        totalCount: number;
        hasMore: boolean;
        fetchNextPage: () => void;
    };
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
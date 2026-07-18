import type { StoragePlane } from './storagePlane';
export type ScopeCoverage = 'complete' | 'page' | 'delta';
export type ScopeEntry = {
    id: string;
    order: number;
    seq: number;
    edge?: Record<string, unknown>;
};
export type ScopeIndexValue = {
    generation: number;
    coverage: ScopeCoverage;
    entries: ScopeEntry[];
};
export type IncomingScopeRow = {
    id: string;
    edge?: Record<string, unknown>;
    order?: number;
};
export type ReconcileResult = {
    next: ScopeIndexValue;
    detachedIds: string[];
};
export type ScopeIndex = {
    read(key: string): ScopeIndexValue;
    write(key: string, next: ScopeIndexValue): void;
    /**
     * Reconcile a server response against the scope membership ledger.
     * - 'complete': incoming rows become the exact membership in server order; previous members
     *   absent from the response are DETACHED (returned in detachedIds; entity rows untouched).
     * - 'page': incoming rows upsert into membership (existing keep their order, new append in
     *   server order); nothing is detached.
     *   With opts.resetOrder (a first-page refetch) incoming rows become the new head order and previous members keep relative order after them.
     * - 'delta': same merge semantics as 'page' (single-row/subscription-driven updates).
     */
    reconcile(key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: {
        resetOrder?: boolean;
    }): ReconcileResult;
    reconcileNext(key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: {
        resetOrder?: boolean;
    }): ReconcileResult;
    detach(key: string, ids: string[]): ScopeIndexValue;
    trim(key: string, maxRows: number): string[];
    trimValue(value: ScopeIndexValue, maxRows: number): {
        next: ScopeIndexValue;
        trimmedIds: string[];
    };
    trimNext(key: string, maxRows: number): {
        next: ScopeIndexValue;
        trimmedIds: string[];
    };
    /** Drop a scope key entirely (GC of empty/dead scopes); persisted entry is deleted on next flush. */
    remove(key: string): void;
    keys(): string[];
    /** O(1) membership check backed by the derived member index. */
    has(key: string, id: string): boolean;
    /** All scope keys containing the row - the reverse membership index. */
    keysOf(id: string): string[];
    /** Ephemeral read revision used by reactive scope subscribers; never persisted. */
    reactiveEpoch(key: string): number;
    orderRevision(key: string): number;
    /** Bump the revisions of scopes that currently contain one of these rows. */
    touchMembers(ids: string[]): string[];
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    hydrate(): void;
    reset(): void;
};
export declare const createScopeIndex: (options: {
    modelId: string;
    scopeNames?: string[];
    storage: StoragePlane;
    prefix: () => string;
}) => ScopeIndex;
//# sourceMappingURL=scopeIndex.d.ts.map
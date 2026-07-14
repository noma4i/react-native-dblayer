import type { StoragePlane } from './storagePlane';
export type Coverage = 'complete' | 'page' | 'delta';
export type ScopeEntry = {
    id: string;
    order: number;
    seq: number;
    edge?: Record<string, unknown>;
};
export type ScopeIndexValue = {
    generation: number;
    coverage: Coverage;
    entries: ScopeEntry[];
};
export type IncomingScopeRow = {
    id: string;
    edge?: Record<string, unknown>;
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
     * - 'delta': same merge semantics as 'page' (single-row/subscription-driven updates).
     */
    reconcile(key: string, coverage: Coverage, incoming: IncomingScopeRow[]): ReconcileResult;
    detach(key: string, ids: string[]): ScopeIndexValue;
    trim(key: string, maxRows: number): string[];
    keys(): string[];
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    hydrate(): void;
    reset(): void;
};
export declare const createScopeIndex: (options: {
    modelId: string;
    storage: StoragePlane;
    prefix: () => string;
}) => ScopeIndex;
//# sourceMappingURL=scopeIndex.d.ts.map
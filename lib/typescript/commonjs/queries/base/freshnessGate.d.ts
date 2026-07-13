import type { CollectionFetchState } from '../../types';
/** Freshness decision consumed by base query hooks before the initial fetch. */
export type FreshnessGateDecision = {
    fetchState: CollectionFetchState | null;
    shouldSkip: boolean;
};
/** Log one freshness skip decision for a model scope. */
export declare const logFreshnessSkip: (model: string | undefined, scopeKey: string, fetchState: CollectionFetchState | null) => void;
/** Subscribe to a collection's fetch-state version, or a constant 0 when no collection is bound. */
export declare const useCollectionFetchStateVersion: (collectionId: string | undefined) => number;
//# sourceMappingURL=freshnessGate.d.ts.map
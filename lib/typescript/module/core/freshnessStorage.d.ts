import type { CollectionFetchState, FetchStateRemovalListener } from '../types';
/** Default maximum age before persisted fetch-state metadata is pruned. */
export declare const DEFAULT_FETCH_STATE_MAX_AGE_MS: number;
/** Read persisted fetch-state metadata for a collection scope. */
export declare const getCollectionFetchState: (collectionId: string, scopeKey?: string) => CollectionFetchState | null;
/** Persist fetch-state metadata for a collection scope. */
export declare const setCollectionFetchState: (collectionId: string, state: CollectionFetchState, scopeKey?: string) => void;
/** Clear fetch-state metadata for one collection scope. */
export declare const clearCollectionFetchState: (collectionId: string, scopeKey?: string) => void;
/** Clear fetch-state metadata for every scope in one collection. */
export declare const clearCollectionFetchStates: (collectionId: string) => void;
/** Clear all persisted fetch-state metadata. */
export declare const clearAllFreshnessMetadata: () => void;
/** Register an in-memory cache listener for freshness removals. */
export declare const registerCollectionFetchStateCache: (collectionId: string, listener: FetchStateRemovalListener) => void;
/** Remove stale or invalid fetch-state metadata and return the number removed. */
export declare const pruneStaleFetchStates: (maxAgeMs?: number) => number;
//# sourceMappingURL=freshnessStorage.d.ts.map
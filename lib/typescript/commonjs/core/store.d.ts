import type { IncrementalCommitBatch, ModelStore, RowRecord, StoragePlane, StoreScopeCollection, StoreScopeSyncSource, WriteCtx } from '../types';
export declare const registerModelStoreFactory: <T extends RowRecord>(modelId: string, factory: () => ModelStore<T>) => void;
/**
 * Run one apply pass with batched collection flushes: every store write inside `run` lands in a
 * per-store transactional buffer (readable through the store immediately) and is committed to the
 * collections as one sync-feed transaction per store when the pass ends, so live queries observe
 * one consistent tick instead of per-row churn. Flushing in `finally` deliberately preserves the
 * partial-application semantics of a mid-batch failure.
 */
export declare const runInApplyBatch: <T>(run: () => T) => T;
export declare const createModelStore: <T extends RowRecord>(options: {
    modelId: string;
    now: () => number;
    storage: StoragePlane;
    prefix: () => string;
    applyWriteGate: (previous: T, incoming: T, ctx: WriteCtx) => T;
    ownedFields?: (rowId: string, excludeOperationId?: string) => ReadonlySet<string>;
}) => ModelStore<T>;
/** Project this commit batch's scope changes into the membership collections (rows are already in the entity collections). */
export declare const syncStoreScopes: (batch: IncrementalCommitBatch, getSource: (model: string) => StoreScopeSyncSource, readyAfterApply?: boolean) => void;
/** Boot-time projection: rebuild every persisted scope's membership rows from the hydrated stores. */
export declare const hydrateStoreScopes: (sources: ReadonlyArray<readonly [string, StoreScopeSyncSource & {
    readAllScopeKeys(): string[];
}]>) => void;
export declare const markStoresReady: () => void;
export declare const resetStores: () => void;
export declare const storeScopeCollection: (model: string, scopeKey: string) => StoreScopeCollection;
//# sourceMappingURL=store.d.ts.map
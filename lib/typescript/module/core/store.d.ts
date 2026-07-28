import type { IncrementalCommitBatch, ModelStore, RowRecord, StoragePlane, StoreScopeCollection, WriteCtx } from '../types';
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
/**
 * THE publish seam: project this batch's scope changes into the membership collections, then
 * publish on the commit bus. Every scope-carrying batch - commit, replay, and GC - goes through
 * here, so a scope-plane mutation can never bypass the store projection.
 */
export declare const publishProjectedBatch: (bus: {
    publish(batch: IncrementalCommitBatch): void;
}, batch: IncrementalCommitBatch, options?: {
    readyAfterApply?: boolean;
}) => void;
/** Boot-time projection: rebuild every persisted scope's membership rows straight from persisted entries. */
export declare const hydrateStoreScopes: (sources: ReadonlyArray<readonly [string, {
    readScopeEntries(scopeKey: string): Array<{
        id: string;
        orderKey: string;
    }>;
    readAllScopeKeys(): string[];
}]>) => void;
export declare const markStoresReady: () => void;
export declare const resetStores: () => void;
export declare const storeScopeCollection: (model: string, scopeKey: string) => StoreScopeCollection;
//# sourceMappingURL=store.d.ts.map
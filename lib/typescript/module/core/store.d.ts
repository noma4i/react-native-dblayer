import type { IncrementalCommitBatch, ModelQueryHandle, ModelQuerySpec, ModelStore, RowRecord, StoragePlane, StoreScopeCollection, WriteCtx } from '../types';
export { runInApplyBatch, poisonStoreReads, restoreStoreReads, runInStoreTransaction } from './storeSync';
export declare const registerModelStoreFactory: <T extends RowRecord>(modelId: string, factory: () => ModelStore<T>) => void;
/**
 * Per-model primary store facade: composes the entity plane (rows, transactional buffer,
 * tombstones, persistence) with the scope plane (membership collection, live scope collections)
 * into the `ModelStore` contract. Both planes are private to this composition.
 */
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
}, build: () => IncrementalCommitBatch, options?: {
    readyAfterApply?: boolean;
}) => IncrementalCommitBatch;
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
/** Hold one declared model read as a live query of the engine; the caller releases it when its reader leaves. */
export declare const storeModelQuery: <TStored extends RowRecord>(model: string, key: string, spec: ModelQuerySpec<TStored>) => ModelQueryHandle;
//# sourceMappingURL=store.d.ts.map
import type { ModelQueryHandle, ModelQuerySpec } from './core.modelQueries.types';
import type { ScopeProjectionStep } from './core.apply.commitBus.types';
import type { ChangeMessage, ChangeMessageOrDeleteKeyMessage, Collection } from '@tanstack/db';
import type { WriteCtx } from './core.writePolicies.types';
import type { RowRecord } from './db.types';
import type { StoragePlane } from './core.planes.storagePlane.types';
type UpsertResult = {
    changedFields: string[] | null;
};
export type PreparedUpsert<T> = {
    row: T;
    changedFields: string[] | null;
};
/** Row read/write contract of the per-model primary store (implemented by `createModelStore`). */
export type EntityState<T extends {
    id: string;
}> = {
    read(id: string): T | undefined;
    values(): T[];
    /** Resolve one write without mutating the collection, tombstones, or dirty state. */
    previewUpsert(row: T, options: {
        previous: T | undefined;
        mergeBase?: T;
        ctx?: WriteCtx;
    }): PreparedUpsert<T>;
    /** Apply an already-resolved row verbatim without invoking write policies. */
    put(row: T): UpsertResult;
    /** Returns changed top-level fields vs the previous row, or null when the row is new. */
    upsert(row: T, options?: {
        mergeBase?: T;
        ctx?: WriteCtx;
    }): UpsertResult;
    destroy(id: string, options?: {
        tombstone?: boolean;
    }): void;
    /** Cache eviction - removes the row WITHOUT a tombstone; a later server row resurrects it. */
    evict(id: string): boolean;
    isTombstoned(id: string): boolean;
    pruneTombstones(): number;
    /** Serialize rows+tombstones into storage entries for the transaction's single persist batch. */
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    ackPersist(): void;
    hydrate(): void;
    reset(): void;
};
/** One scope-projected row served by a live scope collection (entity fields plus orderKey). */
export type StoreScopeRow = {
    id?: string;
    orderKey: string;
};
export type StoreScopeChange = ChangeMessage<StoreScopeRow, string | number>;
export type StoreScopeCollection = {
    toArray(): StoreScopeRow[];
    subscribe(listener: (changes: StoreScopeChange[]) => void): () => void;
};
/** One scope membership row in the per-model membership collection. */
export type StoreMembershipRow = {
    scopeKey: string;
    entityId: string;
    orderKey: string;
};
/** One scope projection instruction: ready-made keys only - the store never computes order. Steps apply in order. */
export type StoreScopeSyncChange = {
    scopeKey: string;
    steps: ScopeProjectionStep[];
};
/**
 * Per-model primary store: the TanStack DB collection pair (entities + scope memberships) behind
 * the EntityState contract, plus the scope-projection surface consumed by reactive readers.
 */
export type ModelStore<T extends {
    id: string;
}> = EntityState<T> & {
    scopeCollection(scopeKey: string): StoreScopeCollection;
    modelQuery<TQueried extends RowRecord>(key: string, spec: ModelQuerySpec<TQueried>): ModelQueryHandle;
    applyScopeChanges(changes: readonly StoreScopeSyncChange[]): void;
    markReady(): void;
    dispose(): void;
};
/** Entity half of a model store: rows, transactional buffer, tombstones, persistence (implemented by `createEntityPlane`). */
export type EntityPlane = EntityState<RowRecord> & {
    /** Committed-only read (no transactional-buffer overlay) for scope projections. */
    readCommitted(id: string): RowRecord | undefined;
    /** The TanStack entities collection, exposed only for the scope plane's live-query join. */
    entities: Collection<RowRecord>;
    markReady(): void;
    dispose(): void;
};
export type EntityPlaneOptions = {
    modelId: string;
    storeId: number;
    now: () => number;
    storage: StoragePlane;
    prefix: () => string;
    applyWriteGate: (previous: RowRecord, incoming: RowRecord, ctx: WriteCtx) => RowRecord;
    ownedFields?: (rowId: string, excludeOperationId?: string) => ReadonlySet<string>;
};
/** Scope half of a model store: membership collection, live scope collections, projection (implemented by `createScopePlane`). */
export type ScopePlane = {
    scopeCollection(scopeKey: string): StoreScopeCollection;
    applyScopeChanges(changes: readonly StoreScopeSyncChange[]): void;
    markReady(): void;
    reset(): void;
    dispose(): void;
};
export type ScopePlaneOptions = {
    modelId: string;
    storeId: number;
    entities: Collection<RowRecord>;
    readCommitted(id: string): RowRecord | undefined;
    isReady(): boolean;
};
/** Collection sync-feed controls: transactional begin/write/commit plus readiness and truncate. */
export type StoreSyncMethods<T extends object> = {
    begin: () => void;
    write: (message: ChangeMessageOrDeleteKeyMessage<T, string>) => void;
    commit: () => void;
    markReady: () => void;
    truncate: () => void;
};
/** Tombstone marker for a destroyed row, stamped for age-based pruning. */
export type Tombstone = {
    at: number;
};
export {};
//# sourceMappingURL=core.store.types.d.ts.map
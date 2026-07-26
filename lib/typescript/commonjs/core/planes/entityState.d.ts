import type { WriteCtx } from '../../dsl/defineModel';
import type { StoragePlane } from './storagePlane';
type UpsertResult = {
    changedFields: string[] | null;
};
export type EntityState<T extends {
    id: string;
}> = {
    read(id: string): T | undefined;
    values(): T[];
    /** Returns changed top-level fields vs the previous row, or null when the row is new. */
    upsert(row: T, options?: {
        mergeBase?: T;
        ctx?: WriteCtx;
    }): UpsertResult;
    destroy(id: string, options?: {
        tombstone?: boolean;
    }): void;
    /** Cache eviction (GC) - removes the row WITHOUT a tombstone; a later server row resurrects it. */
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
export declare const createEntityState: <T extends {
    id: string;
}>(options: {
    modelId: string;
    now: () => number;
    storage: StoragePlane;
    prefix: () => string;
    applyWriteGate?: (previous: T, incoming: T, ctx: WriteCtx) => T | null;
    ownedFields?: (rowId: string, excludeOperationId?: string) => ReadonlySet<string>;
}) => EntityState<T>;
export {};
//# sourceMappingURL=entityState.d.ts.map
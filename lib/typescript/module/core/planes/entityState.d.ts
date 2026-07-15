import type { StoragePlane } from './storagePlane';
export type EntityClock = {
    next(): number;
    current(): number;
    restore(value: number): void;
};
export type Tombstone = {
    seq: number;
    at: number;
};
export type UpsertResult = {
    seq: number;
    changedFields: string[] | null;
};
export type EntityState<T extends {
    id: string;
}> = {
    read(id: string): T | undefined;
    values(): T[];
    /** Returns changed top-level fields vs the previous row, or null when the row is new. */
    upsert(row: T): UpsertResult;
    destroy(id: string, options?: {
        tombstone?: boolean;
    }): number;
    /** Cache eviction (GC) - removes the row WITHOUT a tombstone; a later server row resurrects it. */
    evict(id: string): boolean;
    isTombstoned(id: string): boolean;
    snapshot(): number;
    wasWrittenAfter(id: string, capture: number): boolean;
    wasDestroyedAfter(id: string, capture: number): boolean;
    pruneTombstones(): number;
    /** Serialize rows+tombstones into storage entries for the transaction's single persist batch. */
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    hydrate(): void;
    reset(): void;
};
export declare const createEntityState: <T extends {
    id: string;
}>(options: {
    modelId: string;
    clock: EntityClock;
    now: () => number;
    storage: StoragePlane;
    prefix: () => string;
}) => EntityState<T>;
export declare const createEntityClock: () => EntityClock;
//# sourceMappingURL=entityState.d.ts.map
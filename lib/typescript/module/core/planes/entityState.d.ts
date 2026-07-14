export type EntityClock = {
    next(): number;
    current(): number;
};
export type Tombstone = {
    seq: number;
    at: number;
};
export type EntityState<T extends {
    id: string;
}> = {
    read(id: string): T | undefined;
    values(): T[];
    upsert(row: T): number;
    destroy(id: string): number;
    isTombstoned(id: string): boolean;
    snapshot(): number;
    wasWrittenAfter(id: string, capture: number): boolean;
    wasDestroyedAfter(id: string, capture: number): boolean;
    reset(): void;
};
export declare const createEntityState: <T extends {
    id: string;
}>(clock: EntityClock, now: () => number) => EntityState<T>;
export declare const createEntityClock: () => EntityClock;
//# sourceMappingURL=entityState.d.ts.map
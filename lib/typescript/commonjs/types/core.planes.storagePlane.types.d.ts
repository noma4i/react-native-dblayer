/** Atomic-enough synchronous storage seam used by all state planes. */
export interface StoragePlane {
    get(key: string): string | undefined;
    set(entries: Array<{
        key: string;
        value: string | null;
    }>): void;
    keys(prefix: string): string[];
}
//# sourceMappingURL=core.planes.storagePlane.types.d.ts.map
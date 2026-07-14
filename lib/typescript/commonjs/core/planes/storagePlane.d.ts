/** Atomic-enough synchronous storage seam used by all v6 state planes. */
export interface StoragePlane {
    get(key: string): string | undefined;
    set(entries: Array<{
        key: string;
        value: string | null;
    }>): void;
    keys(prefix: string): string[];
}
export declare const mmkvStoragePlane: () => StoragePlane;
//# sourceMappingURL=storagePlane.d.ts.map
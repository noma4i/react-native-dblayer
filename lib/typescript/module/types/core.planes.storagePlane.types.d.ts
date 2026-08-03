/** Synchronous single-key storage seam. Multi-key atomicity is never implied. */
export interface StoragePlane {
    get(key: string): string | undefined;
    set(key: string, value: string | null): void;
    keys(prefix: string): string[];
}
//# sourceMappingURL=core.planes.storagePlane.types.d.ts.map
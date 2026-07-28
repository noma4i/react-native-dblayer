export type GcReport = {
    evicted: Record<string, number>;
    scopesRemoved: Record<string, number>;
};
/** Per-model surface the garbage collector walks: rows, scopes, references and eviction. */
export type GcHost = {
    modelId: string;
    exempt: boolean;
    rowIds(): string[];
    hasRow(id: string): boolean;
    scopeKeys(): string[];
    scopeEntryIds(key: string): string[];
    detachScopeEntries(key: string, ids: string[]): void;
    scopeEntryCount(key: string): number;
    removeScope(key: string): void;
    idleScopeAfterMs?(): number | undefined;
    scopeLastAccess?(key: string): number | undefined;
    evict(id: string): boolean;
    referencesOf(id: string): Array<{
        model: string;
        id: string;
    }>;
};
//# sourceMappingURL=core.gc.types.d.ts.map
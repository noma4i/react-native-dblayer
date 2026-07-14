export type Coverage = 'complete' | 'page' | 'delta';
export type ScopeEntry = {
    id: string;
    order: number;
    seq: number;
    edge?: Record<string, unknown>;
};
export type ScopeIndexValue = {
    generation: number;
    coverage: Coverage;
    entries: ScopeEntry[];
};
export type ScopeIndex = {
    read(key: string): ScopeIndexValue;
    write(key: string, next: ScopeIndexValue): void;
    reconcile(key: string, coverage: Coverage, ids: string[]): ScopeIndexValue;
    reset(): void;
};
export declare const createScopeIndex: () => ScopeIndex;
//# sourceMappingURL=scopeIndex.d.ts.map
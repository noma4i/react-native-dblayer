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
    evict(id: string): boolean;
    referencesOf(id: string): Array<{
        model: string;
        id: string;
    }>;
};
/** Registered once per defineModel; survives resetRuntime like apply targets. */
export declare const registerGcHost: (modelId: string, host: GcHost) => (() => void);
export type GcReport = {
    evicted: Record<string, number>;
    scopesRemoved: Record<string, number>;
};
/**
 * Reachability GC over all registered models. Roots: scope members, exempt models, pending
 * operations. Edges: belongsTo/references of live rows. Unreached rows are evicted (no
 * tombstones), dead scope entries detached, empty scope keys removed, then persistence flushes.
 * Run at startup after replayJournal - NOT while UI renders unscoped detail rows.
 *
 * `bootDb`/`suspendDb` call this for you as part of the recommended startup/teardown sequence; call it
 * directly only for a different sweep cadence.
 */
export declare const collectGarbage: () => GcReport;
//# sourceMappingURL=gc.d.ts.map
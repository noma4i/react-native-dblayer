export type RowChange = {
    model: string;
    id: string;
    fields: string[] | null;
};
export type ScopeChange = {
    model: string;
    scopeKey: string;
};
export type PendingChange = {
    model: string;
    id: string;
};
export type CommitBatch = {
    rows: RowChange[];
    scopes: ScopeChange[];
    pending?: PendingChange[];
};
export type IncrementalBatchMode = 'delta' | 'bulk' | 'replace' | 'maintenance';
export type IncrementalScopeChange = {
    model: string;
    scopeKey: string;
    ids?: string[];
    appendIds?: string[];
    /** Sparse orders of appended rows, carried from scope-delta ops for O(delta) mirroring. */
    appendEntries?: Array<{
        id: string;
        order: number;
    }>;
    detachIds?: string[];
    rebuild?: boolean;
};
export type IncrementalCommitBatch = CommitBatch & {
    mode?: IncrementalBatchMode;
    scopeChanges?: IncrementalScopeChange[];
    maintenanceModels?: string[];
};
export type Dependency = {
    kind: 'row';
    model: string;
    id: string;
    fields?: ReadonlyArray<string>;
} | {
    kind: 'scope';
    model: string;
    scopeKey: string;
} | {
    kind: 'model';
    model: string;
} | {
    kind: 'pending';
    model: string;
    id: string;
};
export type CommitSubscription = {
    setDeps(deps: ReadonlyArray<Dependency>): void;
    unsubscribe(): void;
};
/**
 * Semantic commit bus: one batched publish per applied plan; each subscriber declares a dependency
 * set (per-row, per-field, per-scope, per-pending-id, or whole-model) and is notified at most once per batch,
 * only when the batch intersects its dependencies.
 */
export declare const createCommitBus: () => {
    subscribe: (notify: () => void, deps?: ReadonlyArray<Dependency>, onBatch?: (batch: IncrementalCommitBatch | null) => void) => CommitSubscription;
    subscribeIncremental: (notify: () => void, deps: ReadonlyArray<Dependency>, onBatch: (batch: IncrementalCommitBatch | null) => void) => CommitSubscription;
    subscribeAll: (onBatch: (batch: IncrementalCommitBatch) => void) => (() => void);
    /** Snapshot of live reader dependencies, used as garbage-collection roots. */
    activeDependencies: () => ReadonlyArray<Dependency>;
    publish: (batch: IncrementalCommitBatch) => void;
    publishAll: () => void;
    subscriberCount: () => number;
};
export type CommitBus = ReturnType<typeof createCommitBus>;
//# sourceMappingURL=commitBus.d.ts.map
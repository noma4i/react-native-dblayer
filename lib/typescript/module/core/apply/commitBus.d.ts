export type RowChange = {
    model: string;
    id: string;
    fields: string[] | null;
};
export type ScopeChange = {
    model: string;
    scopeKey: string;
};
export type CommitBatch = {
    rows: RowChange[];
    scopes: ScopeChange[];
};
export type IncrementalBatchMode = 'delta' | 'bulk' | 'replace' | 'maintenance';
export type IncrementalScopeChange = {
    model: string;
    scopeKey: string;
    ids?: string[];
    appendIds?: string[];
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
};
export type CommitSubscription = {
    setDeps(deps: ReadonlyArray<Dependency>): void;
    unsubscribe(): void;
};
/**
 * Semantic commit bus: one batched publish per applied plan; each subscriber declares a dependency
 * set (per-row, per-field, per-scope, or whole-model) and is notified at most once per batch,
 * only when the batch intersects its dependencies.
 */
export declare const createCommitBus: () => {
    subscribe: (notify: () => void, deps?: ReadonlyArray<Dependency>, onBatch?: (batch: IncrementalCommitBatch | null) => void) => CommitSubscription;
    subscribeIncremental: (notify: () => void, deps: ReadonlyArray<Dependency>, onBatch: (batch: IncrementalCommitBatch | null) => void) => CommitSubscription;
    publish: (batch: IncrementalCommitBatch) => void;
    publishAll: () => void;
    subscriberCount: () => number;
};
export type CommitBus = ReturnType<typeof createCommitBus>;
//# sourceMappingURL=commitBus.d.ts.map
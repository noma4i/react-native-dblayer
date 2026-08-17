export type RowChange = {
    model: string;
    id: string;
    fields: string[] | null;
    kind?: 'upsert' | 'destroy';
    replacedBy?: string;
};
type ScopeChange = {
    model: string;
    scopeKey: string;
};
type PendingChange = {
    model: string;
    id: string;
};
export type CommitBatch = {
    rows: RowChange[];
    scopes: ScopeChange[];
    pending?: PendingChange[];
};
/** One projection step of a scope within one envelope, in op order. */
export type ScopeProjectionStep = 
/** Full ordered membership (a rebuild); the store diffs it against the rows as projected so far. */
{
    entries: Array<{
        id: string;
        orderKey: string;
    }>;
}
/** Point upserts carrying final order keys (insertions and repositions) and detaches. */
 | {
    upserts: Array<{
        id: string;
        orderKey: string;
    }>;
    detachIds: string[];
};
export type IncrementalScopeChange = {
    model: string;
    scopeKey: string;
    steps: ScopeProjectionStep[];
};
export type IncrementalCommitBatch = CommitBatch & {
    scopeChanges?: IncrementalScopeChange[];
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
    unsubscribe(): void;
};
export type CommitBus = {
    subscribe(notify: () => void, deps?: ReadonlyArray<Dependency>, onBatch?: (batch: IncrementalCommitBatch | null) => void): CommitSubscription;
    subscribeIncremental(notify: () => void, deps: ReadonlyArray<Dependency>, onBatch: (batch: IncrementalCommitBatch | null) => void): CommitSubscription;
    subscribeAll(onBatch: (batch: IncrementalCommitBatch) => void): () => void;
    activeDependencies(): ReadonlyArray<Dependency>;
    /** Declare rows held by a reader that receives its changes outside the bus; returns the release. */
    retain(deps: ReadonlyArray<Dependency>): () => void;
    publish(batch: IncrementalCommitBatch): void;
    publishAll(): void;
    /** Count of publishes so far: a value read at sequence N is current while sequence() is still N. */
    sequence(): number;
    subscriberCount(): number;
};
/** One commit-bus subscriber: its dependency set and notification callbacks. */
export type CommitSubscriber = {
    deps: ReadonlyArray<Dependency>;
    notify: () => void;
    onBatch?: (batch: IncrementalCommitBatch | null) => void;
};
export {};
//# sourceMappingURL=core.apply.commitBus.types.d.ts.map
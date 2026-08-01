/** Scope coverage mode used by scope membership reconciliation. */
export type ScopeCoverage = 'complete' | 'page' | 'delta';
/** One persisted scope membership entry; `orderKey` is a lexical fractional key from `core/orderKey.ts`. */
export type ScopeEntry = {
    id: string;
    orderKey: string;
};
/** Persisted scope index snapshot used by the membership ledger. */
export type ScopeIndexValue = {
    generation: number;
    coverage: ScopeCoverage;
    entries: ScopeEntry[];
};
/** One incoming row for scope membership reconciliation; a present `orderKey` (placement/restore) is authoritative. */
export type IncomingScopeRow = {
    id: string;
    orderKey?: string;
};
/** Reconciliation outcome: the next persisted snapshot plus members detached by it. */
export type ReconcileResult = {
    next: ScopeIndexValue;
    detachedIds: string[];
};
export type ScopeIndex = {
    /** Begin one apply-owned overlay. Nested apply transactions are forbidden. */
    beginApply(): void;
    /** Publish the current apply overlay into the live membership indexes. */
    commitApply(): void;
    /** Discard the current apply overlay without changing live membership state. */
    abortApply(): void;
    read(key: string): ScopeIndexValue;
    write(key: string, next: ScopeIndexValue): void;
    /**
     * PLANNING-ONLY reconciliation of an incoming payload against the membership ledger; order keys
     * are computed here (or accepted from `IncomingScopeRow.orderKey`), never during apply.
     * - 'complete': incoming rows become the exact membership; an unchanged id sequence keeps every
     *   existing key (zero downstream work); previous members absent from the payload are DETACHED,
     *   except members in `opts.protectedIds` (rows held by open operations - a server snapshot can
     *   neither confirm nor deny an unresolved local write), which keep their entries and keys.
     * - 'page' with opts.resetOrder: the caller supplies final reset order. Server-order callers pass
     *   the incoming head; declaratively sorted callers pass the globally sorted retained union.
     * - 'page'/'delta' merge: existing members keep their keys, rows carrying `orderKey` land on it,
     *   new key-less rows get tail keys.
     */
    reconcileNext(key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: {
        resetOrder?: boolean;
        protectedIds?: ReadonlySet<string>;
    }): ReconcileResult;
    /** APPLY-side mechanical delta: upsert entries carrying final keys, then detach ids; no key computation. */
    applyDelta(key: string, append: ScopeEntry[], detach: string[]): ScopeIndexValue;
    detach(key: string, ids: string[]): ScopeIndexValue;
    /** Cut entries past `maxRows`; entries in `protectedIds` are never cut and do not consume the budget. */
    trimValue(value: ScopeIndexValue, maxRows: number, protectedIds?: ReadonlySet<string>): {
        next: ScopeIndexValue;
        trimmedIds: string[];
    };
    /** Drop a scope key entirely; persisted entry is deleted on next flush. */
    remove(key: string): void;
    keys(): string[];
    /** Record an in-memory read timestamp for one scope key. */
    noteAccess(key: string): void;
    /** Return the most recent in-memory read timestamp for one scope key. */
    lastAccess(key: string): number | undefined;
    /** O(1) membership check backed by the derived member index. */
    has(key: string, id: string): boolean;
    /** All scope keys containing the row - the reverse membership index. */
    keysOf(id: string): string[];
    /** Rows still holding a reverse membership entry - a gauge, so an entry left behind is visible. */
    residentRowKeys(): number;
    orderRevision(key: string): number;
    /** Bump the revisions of scopes that currently contain one of these rows. */
    touchMembers(ids: string[]): string[];
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    ackPersist(): void;
    hydrate(): void;
    reset(): void;
};
//# sourceMappingURL=core.planes.scopeIndex.types.d.ts.map
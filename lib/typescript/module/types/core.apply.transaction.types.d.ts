import type { CommitBatch } from './core.apply.commitBus.types';
import type { AppliedOp } from './core.apply.ops.types';
import type { WriteOrigin } from './core.writePolicies.types';
import type { StoredRow } from './core.relations.types';
import type { OperationTransition } from './core.planes.operationState.types';
import type { ScopeSortMeta } from './read.scopeReadEngine.types';
declare const commitEnvelopeBrand: unique symbol;
/** Complete write plan accepted by the sole runtime write entry point. */
export type CommitEnvelope = {
    schemaVersion: 1;
    txId: string;
    epoch: number;
    entityOps: AppliedOp[];
    scopeOps: AppliedOp[];
    operationTransitions: OperationTransition[];
    readonly [commitEnvelopeBrand]: true;
};
/** Pure preview of one row write after normalization, ownership overlay, and write-policy evaluation. */
export type PreparedRowWrite = {
    row: StoredRow;
    changedFields: string[] | null;
};
/**
 * Model-owned application target. Planning methods are pure; `put`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to coalesced cache snapshot flushes.
 */
export type ApplyTarget = {
    readRow(id: string): Record<string, unknown> | undefined;
    readAllRows(): Array<Record<string, unknown>>;
    /** Mechanical read of the persisted membership entries (id + final order key); never computes order. */
    readScopeEntries(scopeKey: string): Array<{
        id: string;
        orderKey: string;
    }>;
    /**
     * PLANNING-ONLY: compute final order keys for these ids in this scope (sort-aware for
     * field/comparator scopes, tail keys for server order). `readRow` sees plan-overlay rows.
     */
    planScopePlacement(scopeKey: string, ids: readonly string[], readRow: (model: string, id: string) => Record<string, unknown> | undefined): Array<{
        id: string;
        orderKey: string;
    }>;
    readScopeOrderRevision(scopeKey: string): number;
    readScopeGeneration(scopeKey: string): number;
    scopeOrderAffected(scopeKey: string, id: string, fields: string[] | null): boolean;
    scopeSortMeta(scopeKey: string): ScopeSortMeta;
    /** Declared row comparator for a client-sorted scope; `null` for server-order scopes. */
    compareScopeRows(scopeKey: string): ((left: Record<string, unknown>, right: Record<string, unknown>) => number) | null;
    readAllScopeKeys(): string[];
    prepareUpsert(row: unknown, previous: StoredRow | undefined, origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: StoredRow, operationId?: string, baseRevision?: number): PreparedRowWrite | null;
    preparePatch(id: string, patch: Record<string, unknown>, previous: StoredRow | undefined, operationId?: string, remove?: readonly string[], baseRevision?: number): PreparedRowWrite | null;
    admitDestroy(id: string, baseRevision?: number): boolean;
    /** Begin, publish, or discard the target's apply-owned scope overlay. */
    beginApply(epoch: number): void;
    commitApply(): void;
    abortApply(): void;
    put(rows: StoredRow[]): Array<{
        id: string;
        changedFields: string[] | null;
    }>;
    destroy(ids: string[], tombstone?: boolean): string[];
    scope(scopeKey: string, next: unknown): void;
    scopeDelta(scopeKey: string, delta: {
        append: Array<{
            id: string;
            orderKey: string;
        }>;
        detach: string[];
    }): void;
    reactiveScopes?(ids: string[]): string[];
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    /** Clears the dirty markers captured by the last persistEntries; called only after a successful storage write. */
    ackPersist(): void;
};
export type ApplyRuntime = {
    /**
     * Apply one callback-free plan. All normalization, write policies, relation callbacks, cascade
     * discovery, and storage-entry producers have already completed before the commit.
     */
    commit(envelope: CommitEnvelope): CommitBatch;
    /** Write every coalesced dirty cache snapshot NOW instead of on the scheduled tick. */
    flushCacheSnapshots(): void;
    /** Boot roll-forward: apply every persisted delta op not yet covered by its model snapshot. Returns the replayed delta count. */
    replayPersistedDeltas(): number;
    currentEpoch(): number;
};
export {};
//# sourceMappingURL=core.apply.transaction.types.d.ts.map
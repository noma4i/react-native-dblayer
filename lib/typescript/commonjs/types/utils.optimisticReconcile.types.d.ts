import type { RowId } from './utils.singletonStatics.types';
import type { TimestampInput } from './utils.normalizeHelpers.types';
/** Row shape carrying the optional creation timestamp used by reconciliation windows and temp-row cleanup. */
export type CreatedAtRow = RowId & {
    createdAt?: TimestampInput;
};
/** Read surface reconciliation needs from the owning model. */
export type SnapshotModel<TStored extends RowId> = {
    find(id: string | undefined | null): TStored | undefined;
    all(): TStored[];
    where(filter: Partial<TStored>): TStored[];
};
export type ReconcileScopeFields<TStored extends RowId, TNode extends RowId> = {
    fields: ReadonlyArray<Extract<keyof TStored & keyof TNode, string>>;
} | {
    fieldMap: Partial<Record<Extract<keyof TStored, string>, Extract<keyof TNode, string>>>;
};
export type ReconcileOptimisticRowsOptions<TStored extends CreatedAtRow, TNode extends CreatedAtRow> = {
    /** Candidate resolver, or a scope-field shorthand backed by `model.where`. */
    resolveCandidates: ((node: TNode) => TStored[]) | ReconcileScopeFields<TStored, TNode>;
    /** Extra candidate predicate. Temp ids are always considered candidates. */
    isCandidate?: (candidate: TStored, node: TNode) => boolean;
    /** Domain equality check between an optimistic row and a server node. */
    match: (candidate: TStored, node: TNode) => boolean;
    /** Drop matches whose created-at timestamps are farther apart than this window. */
    createdAtWindowMs?: number;
    /** Commit a matched optimistic row to the server node. */
    commit: (tempId: string, node: TNode) => void;
    /**
     * How to handle an incoming node whose id already exists in the model.
     *
     * - `'drop'` (default): the node is silently skipped - neither returned nor committed. This is the
     *   original behavior; callers that need to apply an existing-id node as an update have to pre-check
     *   `model.find(node.id)` themselves before calling this function.
     * - `'return'`: the node is pushed into the returned array as-is, with no candidate matching attempted
     *   and no `commit` call - e.g. a subscription echo of a row already applied by its own mutation
     *   response. The caller decides how to apply it (patch, replace, or ignore).
     *
     * @default 'drop'
     */
    onExisting?: 'drop' | 'return';
};
//# sourceMappingURL=utils.optimisticReconcile.types.d.ts.map
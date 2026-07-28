import type { CreatedAtRow, ReconcileOptimisticRowsOptions, SnapshotModel } from '../types';
/**
 * Reconcile incoming server nodes with matching optimistic rows.
 *
 * @param model Snapshot model used to check existing rows and scoped optimistic candidates.
 * @param nodes Incoming server nodes.
 * @param options Candidate resolution, matching, timestamp window, commit callback, and `onExisting`
 * policy for nodes whose id already exists in the model.
 * @returns Server nodes that were not matched, plus (with `onExisting: 'return'`) nodes whose id already
 * existed in the model.
 */
export declare const reconcileOptimisticRows: <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(model: SnapshotModel<TStored>, nodes: TNode[], options: ReconcileOptimisticRowsOptions<TStored, TNode>) => TNode[];
//# sourceMappingURL=optimisticReconcile.d.ts.map
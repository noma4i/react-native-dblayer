import type { CommitBus } from '../../types';
/**
 * Semantic commit bus: one batched publish per applied plan; each subscriber declares a dependency
 * set (per-row, per-field, per-scope, per-pending-id, or whole-model) and is notified at most once per batch,
 * only when the batch intersects its dependencies.
 */
export declare const createCommitBus: () => CommitBus;
//# sourceMappingURL=commitBus.d.ts.map
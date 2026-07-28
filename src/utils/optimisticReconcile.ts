import { isTempId } from './generateTempId';
import { toTimestamp } from './normalizeHelpers';
import type { CreatedAtRow, ReconcileOptimisticRowsOptions, ReconcileScopeFields, RowId, SnapshotModel } from '../types';

/**
 * Absolute `createdAt` gap between a candidate and an incoming node, in milliseconds. Missing or
 * unparseable `createdAt` on either side makes `toTimestamp` return `NaN`, which propagates through
 * `Math.abs` to a `NaN` delta - the `!Number.isFinite(delta)` guard in `findBestOptimisticCandidate`
 * deliberately excludes a NaN delta from candidate ranking (never treated as a 0 or best match).
 */
const createdAtDelta = (candidate: CreatedAtRow, node: CreatedAtRow): number => Math.abs(toTimestamp(candidate.createdAt) - toTimestamp(node.createdAt));

const resolveScopedCandidates = <TStored extends RowId, TNode extends RowId>(
  model: SnapshotModel<TStored>,
  scope: ReconcileScopeFields<TStored, TNode>,
  node: TNode
): TStored[] => {
  const filter: Partial<TStored> = {};

  if ('fields' in scope) {
    for (const field of scope.fields) {
      (filter as Record<string, unknown>)[field] = (node as Record<string, unknown>)[field];
    }
  } else {
    for (const [storedField, nodeField] of Object.entries(scope.fieldMap)) {
      if (!nodeField) continue;
      (filter as Record<string, unknown>)[storedField] = (node as Record<string, unknown>)[nodeField];
    }
  }

  return model.where(filter);
};

const candidateAllowed = <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(
  candidate: TStored,
  node: TNode,
  isCandidate?: (candidate: TStored, node: TNode) => boolean
): boolean => isTempId(candidate.id) || Boolean(isCandidate?.(candidate, node));

const findBestOptimisticCandidate = <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(
  candidates: TStored[],
  node: TNode,
  options: ReconcileOptimisticRowsOptions<TStored, TNode>
): TStored | null => {
  let bestCandidate: TStored | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (!candidateAllowed(candidate, node, options.isCandidate)) continue;
    if (!options.match(candidate, node)) continue;

    const delta = createdAtDelta(candidate, node);
    if (!Number.isFinite(delta)) continue;
    if (options.createdAtWindowMs !== undefined && delta > options.createdAtWindowMs) continue;

    if (delta < bestDelta) {
      bestDelta = delta;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
};

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
export const reconcileOptimisticRows = <TStored extends CreatedAtRow, TNode extends CreatedAtRow>(
  model: SnapshotModel<TStored>,
  nodes: TNode[],
  options: ReconcileOptimisticRowsOptions<TStored, TNode>
): TNode[] => {
  const unmatched: TNode[] = [];

  for (const node of nodes) {
    if (model.find(node.id)) {
      if (options.onExisting === 'return') {
        unmatched.push(node);
      }
      continue;
    }

    const candidates =
      typeof options.resolveCandidates === 'function'
        ? options.resolveCandidates(node)
        : resolveScopedCandidates(model, options.resolveCandidates, node);
    const bestCandidate = findBestOptimisticCandidate(candidates, node, options);

    if (!bestCandidate) {
      unmatched.push(node);
      continue;
    }

    options.commit(bestCandidate.id, node);
  }

  return unmatched;
};

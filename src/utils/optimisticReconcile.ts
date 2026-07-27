import { isTempId } from './generateTempId';

type RowId = { id: string };
type CreatedAtLike = string | number | Date | null | undefined;
type CreatedAtRow = RowId & { createdAt?: CreatedAtLike };

type SnapshotModel<TStored extends RowId> = {
  find(id: string | undefined | null): TStored | undefined;
  all(): TStored[];
  where(filter: Partial<TStored>): TStored[];
};

export type ReconcileScopeFields<TStored extends RowId, TNode extends RowId> =
  | { fields: ReadonlyArray<Extract<keyof TStored & keyof TNode, string>> }
  | { fieldMap: Partial<Record<Extract<keyof TStored, string>, Extract<keyof TNode, string>>> };

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

const toTimestamp = (value: CreatedAtLike): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
};

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

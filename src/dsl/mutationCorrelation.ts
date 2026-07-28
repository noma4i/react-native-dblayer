import type { MutationCorrelate, OperationRecord } from '../types';
import { isTempId } from '../utils/generateTempId';
import { toTimestamp } from '../utils/normalizeHelpers';
import { getOperationState } from './configure';

/**
 * Definition registry of declarative temp-row correlators (one entry per insert-optimistic mutation
 * that declares `correlate`). Definition registries deliberately survive `resetRuntime`, matching
 * the model/maintenance registries: declarations describe the schema of behavior, not runtime rows.
 */
const correlators = new Map<string, MutationCorrelate[]>();

export const registerMutationCorrelator = (modelId: string, correlate: MutationCorrelate): void => {
  const entries = correlators.get(modelId) ?? [];
  entries.push(correlate);
  correlators.set(modelId, entries);
};

/** Fast hot-path gate: models without a declared correlator skip normalization and candidate scans entirely. */
export const modelHasCorrelators = (modelId: string): boolean => (correlators.get(modelId)?.length ?? 0) > 0;

const rowTimestamp = (row: Record<string, unknown>): number => {
  const value = row.createdAt;
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date ? toTimestamp(value) : Number.NaN;
};

const candidateMatches = (correlate: MutationCorrelate, candidate: Record<string, unknown>, incoming: Record<string, unknown>): boolean => {
  for (const field of correlate.fields) {
    if (!Object.is(candidate[field], incoming[field])) return false;
  }
  if (correlate.match && !correlate.match(candidate, incoming)) return false;
  if (correlate.createdAtWindowMs !== undefined) {
    const delta = Math.abs(rowTimestamp(candidate) - rowTimestamp(incoming));
    if (!Number.isFinite(delta) || delta > correlate.createdAtWindowMs) return false;
  }
  return true;
};

/**
 * Resolve the still-open temp row an incoming server row logically IS, per the model's declared
 * correlators. Candidates come from the durable ledger (open insert operations), never from a
 * whole-model scan; ties resolve to the oldest operation (FIFO - servers confirm sends in order).
 * Returns null for temp ids, rows already present, models without correlators, or no match.
 */
export const correlateIncomingRow = (
  modelId: string,
  incoming: Record<string, unknown> & { id: string },
  options: { readRow: (id: string) => Record<string, unknown> | undefined; claimedTempIds: ReadonlySet<string> }
): { tempId: string; operation: OperationRecord } | null => {
  const declared = correlators.get(modelId);
  if (!declared || declared.length === 0) return null;
  if (isTempId(incoming.id)) return null;
  if (options.readRow(incoming.id) !== undefined) return null;
  let best: { tempId: string; operation: OperationRecord } | null = null;
  for (const operation of getOperationState().openInsertsFor(modelId)) {
    const tempId = operation.tempIds[0];
    if (tempId === undefined || options.claimedTempIds.has(tempId)) continue;
    const candidate = options.readRow(tempId);
    if (!candidate) continue;
    if (!declared.some(correlate => candidateMatches(correlate, candidate, incoming))) continue;
    if (!best || operation.createdAt < best.operation.createdAt || (operation.createdAt === best.operation.createdAt && operation.operationId < best.operation.operationId)) {
      best = { tempId, operation };
    }
  }
  return best;
};

/** Close a correlated pending operation as committed: its row was confirmed through another channel. */
export const closeCorrelatedOperation = (operation: OperationRecord): void => {
  if (operation.status === 'pending') getOperationState().close(operation.operationId, 'committed');
};

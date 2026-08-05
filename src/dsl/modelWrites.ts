import type { EntityState, ModelMembership, ModelRevisionOwner, ModelWriteResult, ModelWrites, OperationRecord, OperationTransition, WriteOp, WriteOrigin } from '../types';
import { noteDataLoss, noteReplaceRejected } from '../core/diagnostics';
import { getDbLogger } from '../core/logger';
import { putQuarantine } from '../core/quarantine';
import { diffTopLevelFields } from '../core/storeUpsertResolver';
import { isRecord } from '../utils/normalizeHelpers';
import { correlateIncomingRow, modelHasCorrelators } from './mutationCorrelation';
import { getOperationState } from './configure';

export const createModelWrites = <TStored extends { id: string } & Record<string, unknown>>(options: {
  modelId: string;
  modelName: string;
  entityState(): EntityState<TStored>;
  normalize(input: unknown): TStored;
  admitPlanRow(input: unknown): TStored | undefined;
  revisions: ModelRevisionOwner<TStored>;
  captureMembership(id: string): ModelMembership[];
}): ModelWrites<TStored> => {
  const prepareRow = (
    value: unknown,
    previous: TStored | undefined,
    origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>,
    mergeBase?: TStored,
    operationId?: string,
    baseRevision?: number
  ) => {
    const incoming = options.normalize(value);
    if (origin === undefined && options.entityState().isTombstoned(incoming.id)) return null;
    // Replace is a server identity fact: it never fails the causal gate. When the server row
    // already landed through another channel, the response merges into it under snapshot-mode
    // policies instead of leaving the temp row behind.
    const replaceOntoLanded = origin === 'replace' && (previous !== undefined || options.entityState().read(incoming.id) !== undefined);
    const admitted = options.revisions.admitRow(incoming, previous, origin === 'replace' ? undefined : baseRevision);
    if (!admitted) return null;
    return options.entityState().previewUpsert(admitted, {
      previous,
      mergeBase: origin === 'replace' && !replaceOntoLanded ? mergeBase : undefined,
      ctx: { origin: replaceOntoLanded ? 'snapshot' : (origin ?? 'snapshot'), operationId }
    });
  };
  const preparePatch = (
    id: string,
    patch: Record<string, unknown>,
    previous: TStored | undefined,
    operationId?: string,
    remove: readonly string[] = [],
    baseRevision?: number
  ) => {
    const admitted = options.revisions.admitPatch(id, patch, remove, previous, baseRevision);
    if (!previous || !admitted) return null;
    const prepared = options.entityState().previewUpsert({ ...admitted.patch, id: String(id) } as TStored, {
      previous,
      ctx: { origin: 'patch', operationId }
    });
    const row = { ...prepared.row };
    for (const key of admitted.remove) delete row[key];
    return { row, changedFields: diffTopLevelFields(previous, row) };
  };
  const putRows = (rows: TStored[]): ModelWriteResult[] => {
    const changes: ModelWriteResult[] = [];
    for (const row of rows) {
      const result = options.entityState().put(row);
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({ id: row.id, changedFields: result.changedFields });
    }
    return changes;
  };
  const restoreMembership = (nextId: string, memberships: ModelMembership[]): WriteOp[] =>
    memberships.map(membership => ({
      kind: 'scope-delta',
      model: options.modelId,
      scopeKey: membership.scopeKey,
      append: [{ id: nextId, orderKey: membership.orderKey }],
      detach: nextId === membership.id ? [] : [membership.id]
    }));
  const planReplace = (oldId: string, next: unknown, correlatedOperation?: OperationRecord): WriteOp[] => {
    let normalized: TStored;
    try {
      normalized = options.normalize(next);
    } catch (error) {
      getDbLogger().error('replace rejected', { model: options.modelId, oldId, error });
      noteReplaceRejected();
      noteDataLoss('replacement-rejected', options.modelId, 1);
      putQuarantine({ kind: 'row', model: options.modelId, id: isRecord(next) && next.id !== undefined ? String(next.id) : '', raw: next, reason: 'replace-normalize-rejected' });
      throw new Error(`replace rejected for ${options.modelId}:${oldId}`);
    }
    const failedOperation = getOperationState().failedFor(options.modelId, oldId);
    const operationTransitions: OperationTransition[] =
      correlatedOperation?.status === 'pending'
        ? [{ kind: 'close', operationId: correlatedOperation.operationId, status: 'committed' }]
        : failedOperation
          ? [{ kind: 'remove', operationId: failedOperation.operationId, expectedStatus: 'failed' }]
          : [];
    const destroyLeg: WriteOp = {
      kind: 'destroy',
      model: options.modelId,
      ids: normalized.id === oldId ? [] : [oldId],
      origin: 'replace',
      ...(operationTransitions.length > 0 ? { operationTransitions } : {})
    };
    // Deletion wins over the landing swap: when the user destroyed this identity while the
    // request was in flight, the temp leg is destroyed too and the server row never lands.
    if (options.entityState().isTombstoned(normalized.id)) return [destroyLeg];
    const mergeBase = options.entityState().read(oldId);
    const memberships = options.captureMembership(oldId);
    return [
      { kind: 'upsert', model: options.modelId, rows: [normalized], origin: 'replace', mergeBase },
      destroyLeg,
      ...restoreMembership(normalized.id, memberships)
    ];
  };
  /**
   * Channel-agnostic temp correlation seam: split already-accepted rows into plain upserts and
   * replace plans for rows that logically ARE a still-open optimistic temp row (per the owning
   * mutation's `correlate` declaration). Every planner of upsert rows (model plans and scope
   * landings alike) routes through this split, so no delivery channel can create a duplicate.
   */
  const splitCorrelatedRows = (accepted: unknown[]): { plain: unknown[]; replaceOps: WriteOp[] } => {
    if (!modelHasCorrelators(options.modelId)) return { plain: accepted, replaceOps: [] };
    const plain: unknown[] = [];
    const replaceOps: WriteOp[] = [];
    const claimedTempIds = new Set<string>();
    for (const value of accepted) {
      const normalized = options.normalize(value);
      const correlation = correlateIncomingRow(options.modelId, normalized, { readRow: id => options.entityState().read(id), claimedTempIds });
      if (!correlation) {
        plain.push(normalized);
        continue;
      }
      claimedTempIds.add(correlation.tempId);
      replaceOps.push(...planReplace(correlation.tempId, normalized, correlation.operation));
    }
    return { plain, replaceOps };
  };
  const planRows = (rows: unknown[], planOptions?: { origin?: 'event' }): WriteOp[] => {
    const split = splitCorrelatedRows(rows.filter(row => options.admitPlanRow(row) !== undefined));
    const upsert: WriteOp[] = split.plain.length > 0 || split.replaceOps.length === 0 ? [{ kind: 'upsert', model: options.modelId, rows: split.plain, ...(planOptions?.origin ? { origin: planOptions.origin } : {}) }] : [];
    return [...upsert, ...split.replaceOps];
  };
  return { prepareRow, preparePatch, putRows, planRows, planReplace, splitCorrelatedRows, planRestore: (next: unknown, memberships: ModelMembership[]): WriteOp[] => {
    const normalized = options.normalize(next);
    return [{ kind: 'upsert', model: options.modelId, rows: [normalized], origin: 'replace' }, ...restoreMembership(normalized.id, memberships)];
  } };
};

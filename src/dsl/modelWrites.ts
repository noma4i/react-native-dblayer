import type { EntityState, ModelMembership, ModelWriteResult, ModelWrites, OperationRecord, OperationTransition, WriteOp, WriteOrigin } from '../types';
import { noteDataLoss, noteReplaceRejected } from '../core/diagnostics';
import { getDbLogger } from '../core/logger';
import { diffTopLevelFields } from '../core/storeUpsertResolver';
import { correlateIncomingRow, modelHasCorrelators } from './mutationCorrelation';
import { getOperationState } from './configure';

export const createModelWrites = <TStored extends { id: string } & Record<string, unknown>>(options: {
  modelId: string;
  modelName: string;
  entityState(): EntityState<TStored>;
  normalize(input: unknown): TStored;
  isPlanRow(input: unknown): boolean;
  bumpRevision(): void;
  captureMembership(id: string): ModelMembership[];
}): ModelWrites<TStored> => {
  const prepareRow = (
    value: unknown,
    previous: TStored | undefined,
    origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>,
    mergeBase?: TStored,
    operationId?: string
  ) => {
    const incoming = options.normalize(value);
    if (origin === undefined && options.entityState().isTombstoned(incoming.id)) return null;
    return options.entityState().previewUpsert(incoming, {
      previous,
      mergeBase: origin === 'replace' ? mergeBase : undefined,
      ctx: { origin: origin ?? 'snapshot', operationId }
    });
  };
  const preparePatch = (id: string, patch: Record<string, unknown>, previous: TStored | undefined, operationId?: string, remove: readonly string[] = []) => {
    if (!previous) return null;
    const prepared = options.entityState().previewUpsert({ ...patch, id: String(id) } as TStored, {
      previous,
      ctx: { origin: 'patch', operationId }
    });
    const row = { ...prepared.row };
    for (const key of remove) delete row[key];
    return { row, changedFields: diffTopLevelFields(previous, row) };
  };
  const putRows = (rows: TStored[]): ModelWriteResult[] => {
    const changes: ModelWriteResult[] = [];
    for (const row of rows) {
      const result = options.entityState().put(row);
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({ id: row.id, changedFields: result.changedFields });
    }
    if (changes.length > 0) options.bumpRevision();
    return changes;
  };
  const restoreMembership = (nextId: string, memberships: ModelMembership[]): WriteOp[] => memberships.map(membership => ({ kind: 'scope-delta', model: options.modelId, scopeKey: membership.scopeKey, append: [{ id: nextId, orderKey: membership.orderKey }], detach: [membership.id] }));
  const planReplace = (oldId: string, next: unknown, correlatedOperation?: OperationRecord): WriteOp[] => {
    let normalized: TStored;
    try {
      normalized = options.normalize(next);
    } catch (error) {
      getDbLogger().error('replace rejected', { model: options.modelId, oldId, error });
      noteReplaceRejected();
      noteDataLoss('replacement-rejected', options.modelId, 1);
      throw new Error(`replace rejected for ${options.modelId}:${oldId}`);
    }
    const failedOperation = getOperationState().failedFor(options.modelId, oldId);
    const operationTransitions: OperationTransition[] =
      correlatedOperation?.status === 'pending'
        ? [{ kind: 'close', operationId: correlatedOperation.operationId, status: 'committed' }]
        : failedOperation
          ? [{ kind: 'remove', operationId: failedOperation.operationId, expectedStatus: 'failed' }]
          : [];
    const mergeBase = options.entityState().read(oldId);
    const memberships = options.captureMembership(oldId);
    return [
      {
        kind: 'destroy',
        model: options.modelId,
        ids: [oldId],
        origin: 'replace',
        ...(operationTransitions.length > 0 ? { operationTransitions } : {})
      },
      { kind: 'upsert', model: options.modelId, rows: [normalized], origin: 'replace', mergeBase },
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
    const split = splitCorrelatedRows(rows.filter(options.isPlanRow));
    const upsert: WriteOp[] = split.plain.length > 0 || split.replaceOps.length === 0 ? [{ kind: 'upsert', model: options.modelId, rows: split.plain, ...(planOptions?.origin ? { origin: planOptions.origin } : {}) }] : [];
    return [...upsert, ...split.replaceOps];
  };
  return { prepareRow, preparePatch, putRows, planRows, planReplace, splitCorrelatedRows, planRestore: (next: unknown, memberships: ModelMembership[]): WriteOp[] => {
    const normalized = options.normalize(next);
    return [{ kind: 'upsert', model: options.modelId, rows: [normalized], origin: 'replace' }, ...restoreMembership(normalized.id, memberships)];
  } };
};

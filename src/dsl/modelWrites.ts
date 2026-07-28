import type { EntityState, JournalOp, ModelMembership, ModelWriteResult, ModelWrites, WriteOrigin } from '../types';
import { noteDataLoss, noteReplaceRejected } from '../core/diagnostics';
import { getDbLogger } from '../core/logger';
import { closeCorrelatedOperation, correlateIncomingRow, modelHasCorrelators } from './mutationCorrelation';
import { clearFailedOptimisticMutation } from './mutationRuntime';

export const createModelWrites = <TStored extends { id: string } & Record<string, unknown>>(options: {
  modelId: string;
  modelName: string;
  entityState(): EntityState<TStored>;
  normalize(input: unknown): TStored;
  isPlanRow(input: unknown): boolean;
  bumpRevision(): void;
  captureMembership(id: string): ModelMembership[];
}): ModelWrites<TStored> => {
  const writeRows = (rows: unknown[], origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: TStored, operationId?: string): ModelWriteResult[] => {
    const changes: ModelWriteResult[] = [];
    for (const value of rows) {
      let incoming: TStored;
      try {
        incoming = options.normalize(value);
      } catch (error) {
        getDbLogger().error(`[${options.modelName}] apply row rejected`, { error });
        continue;
      }
      if (origin === undefined && options.entityState().isTombstoned(incoming.id)) continue;
      const result = options.entityState().upsert(incoming, { mergeBase: origin === 'replace' ? mergeBase : undefined, ctx: { origin: origin ?? 'snapshot', operationId } });
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({ id: incoming.id, changedFields: result.changedFields });
    }
    if (changes.length > 0) options.bumpRevision();
    return changes;
  };
  const patchRow = (id: string, patch: Record<string, unknown>, operationId?: string): ModelWriteResult | null => {
    const key = String(id);
    if (!options.entityState().read(key)) return null;
    const result = options.entityState().upsert({ ...patch, id: key } as TStored, { ctx: { origin: 'patch', operationId } });
    if (result.changedFields !== null && result.changedFields.length === 0) return null;
    options.bumpRevision();
    return { id: key, changedFields: result.changedFields };
  };
  const restoreMembership = (nextId: string, memberships: ModelMembership[]): JournalOp[] => memberships.map(membership => ({ kind: 'scope-delta', model: options.modelId, scopeKey: membership.scopeKey, append: [{ id: nextId, order: membership.order, edge: membership.edge }], detach: [membership.id] }));
  const replacementId = (next: unknown): string | null => {
    try {
      return options.normalize(next).id;
    } catch {
      return null;
    }
  };
  const planReplace = (oldId: string, next: unknown): JournalOp[] => {
    let normalized: TStored;
    try {
      normalized = options.normalize(next);
    } catch (error) {
      getDbLogger().error('replace rejected', { model: options.modelId, oldId, error });
      noteReplaceRejected();
      noteDataLoss('replacement-rejected', options.modelId, 1);
      throw new Error(`replace rejected for ${options.modelId}:${oldId}`);
    }
    clearFailedOptimisticMutation(options.modelId, oldId);
    const mergeBase = options.entityState().read(oldId);
    const memberships = options.captureMembership(oldId);
    return [{ kind: 'destroy', model: options.modelId, ids: [oldId], origin: 'replace' }, { kind: 'upsert', model: options.modelId, rows: [next], origin: 'replace', mergeBase }, ...restoreMembership(normalized.id, memberships)];
  };
  /**
   * Channel-agnostic temp correlation seam: split already-accepted rows into plain upserts and
   * replace plans for rows that logically ARE a still-open optimistic temp row (per the owning
   * mutation's `correlate` declaration). Every planner of upsert rows (model plans and scope
   * landings alike) routes through this split, so no delivery channel can create a duplicate.
   */
  const splitCorrelatedRows = (accepted: unknown[]): { plain: unknown[]; replaceOps: JournalOp[] } => {
    if (!modelHasCorrelators(options.modelId)) return { plain: accepted, replaceOps: [] };
    const plain: unknown[] = [];
    const replaceOps: JournalOp[] = [];
    const claimedTempIds = new Set<string>();
    for (const value of accepted) {
      let normalized: TStored | null;
      try {
        normalized = options.normalize(value);
      } catch {
        normalized = null; // writeRows rejects and logs it at apply time
      }
      const correlation = normalized
        ? correlateIncomingRow(options.modelId, normalized, { readRow: id => options.entityState().read(id), claimedTempIds })
        : null;
      if (!correlation) {
        plain.push(value);
        continue;
      }
      claimedTempIds.add(correlation.tempId);
      replaceOps.push(...planReplace(correlation.tempId, value));
      closeCorrelatedOperation(correlation.operation);
    }
    return { plain, replaceOps };
  };
  const planRows = (rows: unknown[], planOptions?: { origin?: 'event' }): JournalOp[] => {
    const split = splitCorrelatedRows(rows.filter(options.isPlanRow));
    const upsert: JournalOp[] = split.plain.length > 0 || split.replaceOps.length === 0 ? [{ kind: 'upsert', model: options.modelId, rows: split.plain, ...(planOptions?.origin ? { origin: planOptions.origin } : {}) }] : [];
    return [...upsert, ...split.replaceOps];
  };
  return { writeRows, patchRow, planRows, planReplace, splitCorrelatedRows, planRestore: (next: unknown, memberships: ModelMembership[]): JournalOp[] => {
    const nextId = replacementId(next);
    return [{ kind: 'upsert', model: options.modelId, rows: [next], origin: 'replace' }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
  } };
};

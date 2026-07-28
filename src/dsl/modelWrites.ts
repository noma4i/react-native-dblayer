import type { EntityState, JournalOp, WriteOrigin } from '../types';
import { noteDataLoss, noteReplaceRejected } from '../core/diagnostics';
import { getDbLogger } from '../core/logger';
import { clearFailedOptimisticMutation } from './mutationRuntime';

type Membership = { id: string; scopeKey: string; order: number; edge?: Record<string, unknown> };

export const createModelWrites = <TStored extends { id: string } & Record<string, unknown>>(options: {
  modelId: string;
  modelName: string;
  entityState(): EntityState<TStored>;
  normalize(input: unknown): TStored;
  isPlanRow(input: unknown): boolean;
  bumpRevision(): void;
  captureMembership(id: string): Membership[];
}) => {
  const writeRows = (rows: unknown[], origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: TStored, operationId?: string): Array<{ id: string; changedFields: string[] | null }> => {
    const changes: Array<{ id: string; changedFields: string[] | null }> = [];
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
  const patchRow = (id: string, patch: Record<string, unknown>, operationId?: string): { id: string; changedFields: string[] | null } | null => {
    const key = String(id);
    if (!options.entityState().read(key)) return null;
    const result = options.entityState().upsert({ ...patch, id: key } as TStored, { ctx: { origin: 'patch', operationId } });
    if (result.changedFields !== null && result.changedFields.length === 0) return null;
    options.bumpRevision();
    return { id: key, changedFields: result.changedFields };
  };
  const restoreMembership = (nextId: string, memberships: Membership[]): JournalOp[] => memberships.map(membership => ({ kind: 'scope-delta', model: options.modelId, scopeKey: membership.scopeKey, append: [{ id: nextId, order: membership.order, edge: membership.edge }], detach: [membership.id] }));
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
  const planRows = (rows: unknown[], planOptions?: { origin?: 'event' }): JournalOp[] => {
    const accepted = rows.filter(options.isPlanRow);
    return [{ kind: 'upsert', model: options.modelId, rows: accepted, ...(planOptions?.origin ? { origin: planOptions.origin } : {}) }];
  };
  return { writeRows, patchRow, planRows, planReplace, planRestore: (next: unknown, memberships: Membership[]): JournalOp[] => {
    const nextId = replacementId(next);
    return [{ kind: 'upsert', model: options.modelId, rows: [next], origin: 'replace' }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
  } };
};

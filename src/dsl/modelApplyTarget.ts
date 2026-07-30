import { registerApplyTarget } from '../core/apply/applyTargetRegistry';
import { createCommitEnvelope } from '../core/apply/commitEnvelope';
import { keysForSequence } from '../core/orderKey';
import { firstCompositeKeyPart } from '../core/serialize';
import type { ModelApplyTargetResult, PreparedRowWrite, ScopeIndexValue, ScopeSpec, StoredRow, WriteOp, WriteOrigin, ModelContext } from '../types';
import { getApplyRuntime } from './configure';
import { compareRowsBySpec, isMultiFieldSort } from '../core/ordering';

export const createModelApplyTarget = <TStored extends { id: string } & Record<string, unknown>>(options: {
  modelId: string;
  scopes: Record<string, ScopeSpec<TStored>> | undefined;
  context: ModelContext<TStored>;
  scopeSortedRows(scopeName: string, scopeValue: unknown): TStored[];
  prepareRow(row: unknown, previous: TStored | undefined, origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: TStored, operationId?: string): PreparedRowWrite | null;
  preparePatch(id: string, patch: Record<string, unknown>, previous: TStored | undefined, operationId?: string, remove?: readonly string[]): PreparedRowWrite | null;
  putRows(rows: TStored[]): Array<{ id: string; changedFields: string[] | null }>;
}): ModelApplyTargetResult => {
  const { planes } = options.context;
  const applyTarget: ModelApplyTargetResult['applyTarget'] = {
    readRow: (id: string): Record<string, unknown> | undefined => planes().entityState.read(id),
    readAllRows: (): Array<Record<string, unknown>> => planes().entityState.values(),
    readScopeEntries: (scopeKey: string): Array<{ id: string; orderKey: string }> =>
      planes()
        .scopeIndex.read(scopeKey)
        .entries.map(entry => ({ id: entry.id, orderKey: entry.orderKey })),
    planScopePlacement: (scopeKey, ids, readRow) => {
      const entries = planes().scopeIndex.read(scopeKey).entries;
      const scopeName = firstCompositeKeyPart(scopeKey);
      const sort = options.scopes?.[scopeName]?.sort;
      const pending = new Set(ids);
      if (!sort || sort === 'server-order') {
        const tail = entries.filter(entry => !pending.has(entry.id)).at(-1)?.orderKey;
        const keys = keysForSequence(ids.length, tail);
        return ids.map((id, index) => ({ id, orderKey: keys[index]! }));
      }
      const compare = compareRowsBySpec(sort);
      const anchors: Array<{ orderKey: string; row: TStored }> = [];
      for (const entry of entries) {
        if (pending.has(entry.id)) continue;
        const row = readRow(options.modelId, entry.id) as TStored | undefined;
        if (row) anchors.push({ orderKey: entry.orderKey, row });
      }
      const placements: Array<{ id: string; orderKey: string }> = [];
      const unresolved: string[] = [];
      for (const id of ids) {
        const row = readRow(options.modelId, id) as TStored | undefined;
        if (!row) {
          unresolved.push(id);
          continue;
        }
        let lower = 0;
        let upper = anchors.length;
        while (lower < upper) {
          const middle = Math.floor((lower + upper) / 2);
          if (compare(anchors[middle]!.row, row) < 0) lower = middle + 1;
          else upper = middle;
        }
        const orderKey = keysForSequence(1, anchors[lower - 1]?.orderKey, anchors[lower]?.orderKey)[0]!;
        anchors.splice(lower, 0, { orderKey, row });
        placements.push({ id, orderKey });
      }
      const unresolvedKeys = keysForSequence(unresolved.length, anchors.at(-1)?.orderKey);
      unresolved.forEach((id, index) => placements.push({ id, orderKey: unresolvedKeys[index]! }));
      return placements;
    },
    readScopeOrderRevision: (scopeKey: string): number => planes().scopeIndex.orderRevision(scopeKey),
    readScopeGeneration: (scopeKey: string): number => planes().scopeIndex.read(scopeKey).generation,
    scopeOrderAffected: (scopeKey: string, id: string, fields: string[] | null): boolean => {
      if (fields === null || !planes().scopeIndex.has(scopeKey, id)) return true;
      const scopeName = firstCompositeKeyPart(scopeKey);
      const spec = options.scopes?.[scopeName];
      if (!spec) return false;
      const relevant = new Set<string>(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== 'server-order') {
        if (isMultiFieldSort(spec.sort)) for (const order of spec.sort) relevant.add(String(order.field));
        else if ('field' in spec.sort) relevant.add(String(spec.sort.field));
        else {
          if (spec.sort.orderFields === undefined) return true;
          for (const field of spec.sort.orderFields) relevant.add(field);
        }
      }
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: (scopeKey: string) => {
      const scopeName = firstCompositeKeyPart(scopeKey);
      const sort = options.scopes?.[scopeName]?.sort;
      if (!sort || sort === 'server-order') return { kind: 'server-order' as const };
      if (isMultiFieldSort(sort)) return { kind: 'fields' as const, fields: sort.map(order => ({ field: String(order.field), dir: order.dir })) };
      if ('comparator' in sort) return { kind: 'comparator' as const };
      return { kind: 'field' as const, field: String(sort.field), dir: sort.dir };
    },
    readAllScopeKeys: (): string[] => planes().scopeIndex.keys(),
    prepareUpsert: (row, previous, origin, mergeBase, operationId) =>
      options.prepareRow(row, previous as TStored | undefined, origin, mergeBase as TStored | undefined, operationId),
    preparePatch: (id, patch, previous, operationId, remove) => options.preparePatch(id, patch, previous as TStored | undefined, operationId, remove),
    beginApply: () => {
      planes().scopeIndex.beginApply();
    },
    commitApply: () => {
      planes().scopeIndex.commitApply();
    },
    abortApply: () => {
      planes().scopeIndex.abortApply();
    },
    put: (rows: StoredRow[]) => options.putRows(rows as TStored[]),
    destroy: (ids: string[], tombstone?: boolean): string[] => {
      const removed: string[] = [];
      for (const id of ids) {
        const key = String(id);
        const existed = planes().entityState.read(key) !== undefined;
        planes().entityState.destroy(key, { tombstone });
        if (existed) removed.push(key);
      }
      if (removed.length > 0) options.context.bumpRevision();
      return removed;
    },
    scope: (scopeKey: string, next: unknown): void => {
      planes().scopeIndex.write(scopeKey, next as ScopeIndexValue);
    },
    scopeDelta: (scopeKey: string, delta: { append: Array<{ id: string; orderKey: string }>; detach: string[] }): void => {
      planes().scopeIndex.applyDelta(scopeKey, delta.append, delta.detach);
    },
    reactiveScopes: (ids: string[]) => planes().scopeIndex.touchMembers(ids),
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()],
    ackPersist: () => {
      planes().entityState.ackPersist();
      planes().scopeIndex.ackPersist();
    }
  };
  registerApplyTarget(options.modelId, applyTarget);
  const applySnapshot = (ops: WriteOp[]): void => {
    getApplyRuntime().commit(createCommitEnvelope(ops));
  };
  const applyEvent = (ops: WriteOp[]): void => {
    getApplyRuntime().commit(
      createCommitEnvelope(
        ops.map(op => (op.kind === 'upsert' && op.origin === undefined ? { kind: 'upsert' as const, model: op.model, rows: op.rows, origin: 'event' as const } : op))
      )
    );
  };
  return { applyTarget, applySnapshot, applyEvent };
};

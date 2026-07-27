import { createCommitEnvelope, registerApplyTarget, type ApplyTarget } from '../core/apply/transaction';
import type { JournalOp } from '../core/apply/journal';
import type { ScopeIndexValue } from '../core/planes/scopeIndex';
import type { WriteOrigin } from '../core/writePolicies';
import { sortModelReadRows } from '../read/incrementalReadEngine';
import type { ScopeSortSpec } from '../types/dsl.model.types';
import { getApplyRuntime } from './configure';
import type { ModelContext } from './modelContext';
import type { ScopeSpec } from './scope';

export const sortRowsBySpec = <TRow extends { id: string }>(rows: TRow[], sort: ScopeSortSpec<TRow>): TRow[] =>
  'comparator' in sort ? [...rows].sort(sort.comparator) : sortModelReadRows(rows, [{ field: String(sort.field), direction: sort.dir }]);

export const createModelApplyTarget = <TStored extends { id: string } & Record<string, unknown>>(options: {
  modelId: string;
  scopes: Record<string, ScopeSpec<TStored>> | undefined;
  context: ModelContext<TStored>;
  keyForScope(scopeName: string, scopeValue: unknown): string;
  writeRows(rows: unknown[], origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: TStored, operationId?: string): Array<{ id: string; changedFields: string[] | null }>;
  patchRow(id: string, patch: Record<string, unknown>, operationId?: string): { id: string; changedFields: string[] | null } | null;
}) => {
  const { planes } = options.context;
  const scopeSortedRows = (scopeName: string, scopeValue: unknown): TStored[] => {
    const spec = options.scopes?.[scopeName];
    const value = planes().scopeIndex.read(options.keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter((row): row is TStored => row !== undefined);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    return sortRowsBySpec(rows, spec.sort);
  };
  const applyTarget: ApplyTarget = {
    readRow: (id: string): Record<string, unknown> | undefined => planes().entityState.read(id),
    readAllRows: (): Array<Record<string, unknown>> => planes().entityState.values(),
    readScopeOrder: (scopeKey: string): string[] => {
      const separator = scopeKey.indexOf(`\0`);
      const scopeName = separator < 0 ? scopeKey : scopeKey.slice(0, separator);
      const rawValue = separator < 0 ? `{}` : scopeKey.slice(separator + 1);
      try {
        return scopeSortedRows(scopeName, JSON.parse(rawValue)).map(row => String(row.id));
      } catch {
        return planes()
          .scopeIndex.read(scopeKey)
          .entries.map(entry => entry.id);
      }
    },
    readScopeOrderRevision: (scopeKey: string): number => planes().scopeIndex.orderRevision(scopeKey),
    readScopeGeneration: (scopeKey: string): number => planes().scopeIndex.read(scopeKey).generation,
    scopeOrderAffected: (scopeKey: string, id: string, fields: string[] | null): boolean => {
      if (fields === null || !planes().scopeIndex.has(scopeKey, id)) return true;
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`\0`));
      const spec = options.scopes?.[scopeName];
      if (!spec) return false;
      const relevant = new Set<string>(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== 'server-order' && 'field' in spec.sort) relevant.add(String(spec.sort.field));
      if (spec.sort && spec.sort !== 'server-order' && 'comparator' in spec.sort) {
        if (spec.sort.orderFields === undefined) return true;
        for (const field of spec.sort.orderFields) relevant.add(field);
      }
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: (scopeKey: string) => {
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`\0`));
      const sort = options.scopes?.[scopeName]?.sort;
      if (!sort || sort === 'server-order') return { kind: 'server-order' as const };
      if ('comparator' in sort) return { kind: 'comparator' as const };
      return { kind: 'field' as const, field: String(sort.field), dir: sort.dir };
    },
    readAllScopeKeys: (): string[] => planes().scopeIndex.keys(),
    upsert: options.writeRows,
    patch: options.patchRow,
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
    counter: (id: string, field: string, delta: number, next?: number): boolean => {
      const key = String(id);
      const current = planes().entityState.read(key)?.[field];
      return options.patchRow(key, { [field]: next ?? ((current as number | undefined) ?? 0) + delta }) !== null;
    },
    counterValue: (id: string, field: string): number | null => {
      const value = planes().entityState.read(id)?.[field];
      return typeof value === 'number' ? value : value == null ? null : Number(value);
    },
    scope: (scopeKey: string, next: unknown): void => {
      planes().scopeIndex.write(scopeKey, next as ScopeIndexValue);
    },
    scopeDelta: (scopeKey: string, delta: { append: Array<{ id: string; edge?: Record<string, unknown>; order?: number }>; detach: string[] }): void => {
      if (delta.detach.length > 0) planes().scopeIndex.detach(scopeKey, delta.detach);
      if (delta.append.length > 0) planes().scopeIndex.reconcile(scopeKey, 'delta', delta.append);
    },
    reactiveScopes: (ids: string[]) => planes().scopeIndex.touchMembers(ids),
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()],
    ackPersist: () => {
      planes().entityState.ackPersist();
      planes().scopeIndex.ackPersist();
    }
  };
  registerApplyTarget(options.modelId, applyTarget);
  const applySnapshot = (ops: JournalOp[]): void => {
    getApplyRuntime().commit(createCommitEnvelope(ops));
  };
  const applyEvent = (ops: JournalOp[]): void => {
    getApplyRuntime().commit(createCommitEnvelope(ops.map(op => (op.kind === 'upsert' && op.origin === undefined ? { kind: 'upsert' as const, model: op.model, rows: op.rows, origin: 'event' as const } : op))));
  };
  return { applyTarget, applySnapshot, applyEvent, scopeSortedRows };
};

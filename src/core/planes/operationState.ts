import { union } from 'es-toolkit';
import type { StoragePlane } from './storagePlane';
import { compositeKey } from '../serialize';
import { noteCorruptionLedgerReset, noteDataLoss } from '../diagnostics';
import { getDbLogger } from '../logger';

export type OperationStatus = 'pending' | 'committed' | 'rolledback' | 'failed';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = {
  operationId: string;
  model: string;
  tempIds: string[];
  rowIds?: string[];
  intent: OperationIntent;
  status: OperationStatus;
  idempotencyKey?: string;
  /** Retain a committed idempotency key until reset. Default operations guard only while pending. */
  once?: boolean;
  /** Top-level fields an optimistic method-patch owns while pending; its ledger record is created before the optimistic journal patch so that internal optimistic patches and rollbacks bypass overlay, while foreign writes keep the current value until the op closes. */
  patchedFields?: string[];
  /** The concrete field->value map an optimistic method-patch wrote; used to resolve a field to the latest still-pending patch on rollback. */
  patchedValues?: Record<string, unknown>;
  /** JSON-round-tripped input retained for durable retry of a failed optimistic insert. */
  failedInput?: unknown;
  createdAt: number;
};

const CLOSED_TTL_MS = 60 * 60 * 1000;
export type OperationState = {
  begin(operation: Omit<OperationRecord, 'status'>): void;
  /** Terminal status is immutable; repeated close calls are idempotent no-ops. */
  close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
  get(operationId: string): OperationRecord | undefined;
  /** True when a retained `once` key or exact operation id already committed. */
  hasCommitted(idempotencyKey: string): boolean;
  /** True while an idempotency key has a pending operation - blocks double-taps. */
  hasPending(idempotencyKey: string): boolean;
  pending(): OperationRecord[];
  /** Pending operations touching one model row (rowIds falling back to tempIds), in creation order. */
  pendingForRow(model: string, rowId: string): OperationRecord[];
  /** Failed operations touching one model row (rowIds union tempIds). */
  failedForRow(model: string, rowId: string): OperationRecord[];
  /** Most recent retained failed operation for one model row. */
  failedFor(model: string, rowId: string): OperationRecord | undefined;
  /** Remove one retained failed operation after retry, discard, or reconciliation. */
  clearFailed(operationId: string): void;
  /** Pending records loaded by hydrate; only these are crash orphans during boot reconciliation. */
  hydratedPending(): OperationRecord[];
  prune(): number;
  /** Union of fields owned by still-pending optimistic patch ops on one model row (empty when none). */
  ownedFields(model: string, rowId: string, excludeOpId?: string): ReadonlySet<string>;
  /** The value the latest still-pending patch op (excluding `excludeOpId`) wrote for one field of one model row, or `{ found: false }` when no other pending patch owns it. */
  latestPendingValue(model: string, rowId: string, field: string, excludeOpId?: string): { found: boolean; value: unknown };
  persistEntries(): Array<{ key: string; value: string | null }>;
  /** Hydrates the single ledger blob; malformed data is cold-reset because orphan temp-row reconciliation is the contract fallback. */
  hydrate(): void;
  reset(): void;
};

export const createOperationState = (options: { storage: StoragePlane; prefix: () => string; now: () => number; notify?: (record: OperationRecord) => void }): OperationState => {
  const { storage, prefix, now, notify } = options;
  const operations = new Map<string, OperationRecord>();
  const committedKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const hydratedPendingIds = new Set<string>();
  let pendingPatchCount = 0;
  /** Reverse index: compositeKey(model, rowId) -> every operation whose rowIds/tempIds union includes
   * that rowId, regardless of status. Each accessor re-applies its own historical row-match predicate
   * (rowIds-or-tempIds vs rowIds-only vs union) within the bucket - the union key is a safe superset for
   * all three, so results stay identical to the prior full-array scans, just O(bucket-size). */
  const opsByRowKey = new Map<string, Set<OperationRecord>>();
  const rowKeysFor = (record: OperationRecord): string[] => union(record.tempIds, record.rowIds ?? []).map(rowId => compositeKey(record.model, rowId));
  const indexRecordRows = (record: OperationRecord): void => {
    for (const key of rowKeysFor(record)) {
      let bucket = opsByRowKey.get(key);
      if (!bucket) {
        bucket = new Set();
        opsByRowKey.set(key, bucket);
      }
      bucket.add(record);
    }
  };
  const unindexRecordRows = (record: OperationRecord): void => {
    for (const key of rowKeysFor(record)) {
      const bucket = opsByRowKey.get(key);
      if (!bucket) continue;
      bucket.delete(record);
      if (bucket.size === 0) opsByRowKey.delete(key);
    }
  };
  const bucketFor = (model: string, rowId: string): Set<OperationRecord> | undefined => opsByRowKey.get(compositeKey(model, rowId));
  const indexOperation = (record: OperationRecord): void => {
    if (!record.idempotencyKey) return;
    if (record.status === 'pending') pendingKeys.add(record.idempotencyKey);
    else pendingKeys.delete(record.idempotencyKey);
    if (record.status === 'committed' && record.once === true) committedKeys.add(record.idempotencyKey);
  };
  const rebuildIndexes = (): void => {
    committedKeys.clear();
    pendingKeys.clear();
    opsByRowKey.clear();
    for (const record of operations.values()) {
      indexOperation(record);
      indexRecordRows(record);
    }
  };
  const opsKey = () => `${prefix()}ops`;
  const persistEntries = (): Array<{ key: string; value: string | null }> => {
    return [{ key: opsKey(), value: operations.size > 0 ? JSON.stringify(Object.fromEntries(operations)) : null }];
  };
  const EMPTY_OWNED: ReadonlySet<string> = new Set();

  return {
    begin: operation => {
      const record: OperationRecord = { ...operation, status: 'pending' };
      operations.set(operation.operationId, record);
      indexOperation(record);
      indexRecordRows(record);
      if (record.status === 'pending' && record.intent === 'patch' && record.patchedFields && record.patchedFields.length > 0) pendingPatchCount += 1;
      storage.set(persistEntries());
      notify?.(record);
    },
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation || operation.status !== 'pending') return;
      const wasPatchOwner = operation.status === 'pending' && operation.intent === 'patch' && !!operation.patchedFields && operation.patchedFields.length > 0;
      hydratedPendingIds.delete(operationId);
      if (operation.idempotencyKey) pendingKeys.delete(operation.idempotencyKey);
      const retainKey = status === 'committed' && operation.once === true;
      const record: OperationRecord = { ...operation, status, idempotencyKey: retainKey ? operation.idempotencyKey : undefined };
      unindexRecordRows(operation);
      operations.set(operationId, record);
      indexRecordRows(record);
      if (wasPatchOwner) pendingPatchCount -= 1;
      indexOperation(record);
      storage.set(persistEntries());
      notify?.(record);
    },
    get: operationId => operations.get(operationId),
    hasCommitted: idempotencyKey => committedKeys.has(idempotencyKey) || operations.get(idempotencyKey)?.status === 'committed',
    hasPending: idempotencyKey => pendingKeys.has(idempotencyKey),
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    pendingForRow: (model, rowId) => {
      const bucket = bucketFor(model, rowId);
      if (!bucket) return [];
      return [...bucket].filter(operation => operation.status === 'pending' && operation.model === model && (operation.rowIds ?? operation.tempIds).includes(rowId));
    },
    failedForRow: (model, rowId) => {
      const bucket = bucketFor(model, rowId);
      if (!bucket) return [];
      return [...bucket].filter(operation => operation.status === 'failed' && operation.model === model);
    },
    failedFor: (model, rowId) => {
      const bucket = bucketFor(model, rowId);
      if (!bucket) return undefined;
      let latest: OperationRecord | undefined;
      for (const operation of bucket) {
        if (operation.status !== 'failed' || operation.model !== model) continue;
        if (!latest || operation.createdAt >= latest.createdAt) latest = operation;
      }
      return latest;
    },
    clearFailed: operationId => {
      const operation = operations.get(operationId);
      if (!operation || operation.status !== 'failed') return;
      operations.delete(operationId);
      rebuildIndexes();
      storage.set(persistEntries());
      notify?.(operation);
    },
    hydratedPending: () =>
      [...hydratedPendingIds].flatMap(operationId => {
        const operation = operations.get(operationId);
        return operation?.status === 'pending' ? [operation] : [];
      }),
    prune: () => {
      const cutoff = now() - CLOSED_TTL_MS;
      let pruned = 0;
      for (const [operationId, operation] of operations) {
        const retainedOnce = operation.status === 'committed' && operation.once === true;
        if (operation.status !== 'pending' && operation.status !== 'failed' && !retainedOnce && operation.createdAt < cutoff) {
          operations.delete(operationId);
          pruned += 1;
        }
      }
      if (pruned > 0) rebuildIndexes();
      return pruned;
    },
    ownedFields: (model, rowId, excludeOpId) => {
      if (pendingPatchCount === 0) return EMPTY_OWNED;
      const bucket = bucketFor(model, rowId);
      if (!bucket) return EMPTY_OWNED;
      let owned: Set<string> | undefined;
      for (const operation of bucket) {
        if (operation.status !== 'pending' || operation.intent !== 'patch' || !operation.patchedFields || operation.patchedFields.length === 0) continue;
        if (operation.operationId === excludeOpId) continue;
        if (operation.model !== model || !(operation.rowIds ?? []).includes(rowId)) continue;
        owned ??= new Set<string>();
        for (const field of operation.patchedFields) owned.add(field);
      }
      return owned ?? EMPTY_OWNED;
    },
    latestPendingValue: (model, rowId, field, excludeOpId) => {
      if (pendingPatchCount === 0) return { found: false, value: undefined };
      const bucket = bucketFor(model, rowId);
      if (!bucket) return { found: false, value: undefined };
      let result: { found: boolean; value: unknown } = { found: false, value: undefined };
      for (const operation of bucket) {
        if (operation.status !== 'pending' || operation.intent !== 'patch' || operation.operationId === excludeOpId) continue;
        if (operation.model !== model || !(operation.rowIds ?? []).includes(rowId)) continue;
        if (operation.patchedValues && field in operation.patchedValues) result = { found: true, value: operation.patchedValues[field] };
      }
      return result;
    },
    persistEntries,
    hydrate: () => {
      operations.clear();
      hydratedPendingIds.clear();
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        try {
          for (const [operationId, record] of Object.entries(JSON.parse(rawOps) as Record<string, OperationRecord>)) {
            const retainKey = record.status === 'pending' || (record.status === 'committed' && record.once === true);
            const hydratedRecord = retainKey ? record : { ...record, idempotencyKey: undefined };
            operations.set(operationId, hydratedRecord);
            if (hydratedRecord.status === 'pending') hydratedPendingIds.add(operationId);
          }
        } catch {
          storage.set([{ key: opsKey(), value: null }]);
          noteCorruptionLedgerReset();
          noteDataLoss('operation-ledger-corruption-reset', '__operations__', 1);
          getDbLogger().error('cold-ledger recovery', { key: opsKey() });
        }
      }
      rebuildIndexes();
      pendingPatchCount = 0;
      for (const op of operations.values()) if (op.status === 'pending' && op.intent === 'patch' && op.patchedFields && op.patchedFields.length > 0) pendingPatchCount += 1;
    },
    reset: () => {
      operations.clear();
      committedKeys.clear();
      pendingKeys.clear();
      hydratedPendingIds.clear();
      opsByRowKey.clear();
      pendingPatchCount = 0;
    }
  };
};

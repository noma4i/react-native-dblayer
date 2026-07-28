import { union } from 'es-toolkit';
import type { OperationRecord, OperationState , StoragePlane } from '../../types';
import { compositeKey } from '../serialize';
import { noteCorruptionLedgerReset, noteDataLoss } from '../diagnostics';
import { getDbLogger } from '../logger';

const ONCE_KEY_RECORD_FORMAT_VERSION = 1;
type PersistedOnceKeyRecord = { formatVersion: number; keys: string[] };

const onceKeysKey = (prefix: string): string => `${prefix}ops-once`;

export const readCommittedOnceKeys = (storage: StoragePlane, prefix: string): string[] => {
  const keys = new Set<string>();
  const rawOnceKeys = storage.get(onceKeysKey(prefix));
  if (rawOnceKeys) {
    try {
      const record = JSON.parse(rawOnceKeys) as PersistedOnceKeyRecord;
      if (record.formatVersion === ONCE_KEY_RECORD_FORMAT_VERSION && Array.isArray(record.keys) && record.keys.every(key => typeof key === 'string')) {
        for (const key of record.keys) keys.add(key);
      }
    } catch {}
  }
  const rawOperations = storage.get(`${prefix}ops`);
  if (rawOperations) {
    try {
      for (const record of Object.values(JSON.parse(rawOperations) as Record<string, OperationRecord>)) {
        if (record.status === 'committed' && record.once === true && typeof record.idempotencyKey === 'string') keys.add(record.idempotencyKey);
      }
    } catch {}
  }
  return [...keys].sort();
};

export const writeCommittedOnceKeys = (storage: StoragePlane, prefix: string, keys: readonly string[]): void => {
  if (keys.length === 0) return;
  storage.set([{ key: onceKeysKey(prefix), value: JSON.stringify({ formatVersion: ONCE_KEY_RECORD_FORMAT_VERSION, keys }) }]);
};

/** JSON-round-trip an operation input before it enters the persistent ledger. */
export const serializeOperationInput = (input: unknown): { serializable: boolean; value: unknown } => {
  const seen = new Set<object>();
  const isJsonValue = (value: unknown): boolean => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    if (Array.isArray(value)) {
      seen.add(value);
      const valid = value.every(isJsonValue);
      seen.delete(value);
      return valid;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    seen.add(value);
    const valid = Object.values(value).every(isJsonValue);
    seen.delete(value);
    return valid;
  };
  if (!isJsonValue(input)) return { serializable: false, value: undefined };
  try {
    return { serializable: true, value: JSON.parse(JSON.stringify(input)) };
  } catch {
    return { serializable: false, value: undefined };
  }
};

const CLOSED_TTL_MS = 60 * 60 * 1000;

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
    const keys = [...committedKeys].sort();
    return [
      { key: opsKey(), value: operations.size > 0 ? JSON.stringify(Object.fromEntries(operations)) : null },
      { key: onceKeysKey(prefix()), value: keys.length > 0 ? JSON.stringify({ formatVersion: ONCE_KEY_RECORD_FORMAT_VERSION, keys }) : null }
    ];
  };
  const EMPTY_OWNED: ReadonlySet<string> = new Set();

  return {
    begin: (operation, options) => {
      const record: OperationRecord = { ...operation, status: 'pending' };
      operations.set(operation.operationId, record);
      indexOperation(record);
      indexRecordRows(record);
      if (record.status === 'pending' && record.intent === 'patch' && record.patchedFields && record.patchedFields.length > 0) pendingPatchCount += 1;
      if (options?.persist !== false) storage.set(persistEntries());
      notify?.(record);
    },
    close: (operationId, status, options) => {
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
      if (options?.persist !== false) storage.set(persistEntries());
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
    reopen: operationId => {
      const operation = operations.get(operationId);
      if (!operation || operation.status !== 'failed') return undefined;
      const record: OperationRecord = { ...operation, status: 'pending' };
      operations.set(operationId, record);
      rebuildIndexes();
      storage.set(persistEntries());
      notify?.(record);
      return record;
    },
    remove: (operationId, options) => {
      const operation = operations.get(operationId);
      if (!operation) return;
      hydratedPendingIds.delete(operationId);
      operations.delete(operationId);
      rebuildIndexes();
      if (options?.persist !== false) storage.set(persistEntries());
      notify?.(operation);
    },
    hydratedPending: () =>
      [...hydratedPendingIds].flatMap(operationId => {
        const operation = operations.get(operationId);
        return operation?.status === 'pending' ? [operation] : [];
      }),
    takeHydratedPending: matches => {
      const pending: OperationRecord[] = [];
      for (const operationId of [...hydratedPendingIds]) {
        const operation = operations.get(operationId);
        if (!operation || operation.status !== 'pending' || !matches(operation)) continue;
        hydratedPendingIds.delete(operationId);
        pending.push(operation);
      }
      return pending;
    },
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
      for (const key of readCommittedOnceKeys(storage, prefix())) committedKeys.add(key);
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

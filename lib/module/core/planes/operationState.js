"use strict";

import { union } from 'es-toolkit';
import { compositeKey } from "../serialize.js";
import { noteCorruptionLedgerReset, noteDataLoss } from "../diagnostics.js";
import { getDbLogger } from "../logger.js";
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "../persistenceCodec.js";
import { isRecord } from "../../utils/normalizeHelpers.js";
const onceKeysKey = prefix => `${prefix}ops-once`;
const isOperationRecord = value => isRecord(value) && typeof value.operationId === 'string' && typeof value.model === 'string' && Array.isArray(value.tempIds) && value.tempIds.every(id => typeof id === 'string') && (value.rowIds === undefined || Array.isArray(value.rowIds) && value.rowIds.every(id => typeof id === 'string')) && (value.intent === 'insert' || value.intent === 'patch' || value.intent === 'destroy') && (value.status === 'pending' || value.status === 'committed' || value.status === 'rolledback' || value.status === 'failed') && typeof value.createdAt === 'number';
const isOperationRecordMap = value => isRecord(value) && Object.entries(value).every(([operationId, record]) => isOperationRecord(record) && record.operationId === operationId);
const isOnceKeyRecord = value => isRecord(value) && Array.isArray(value.keys) && value.keys.every(key => typeof key === 'string');

/** Corrupt sources are counted, not reported here: the manifest cold-reset caller runs `resetRuntime`
 * (which clears diagnostics) right after this read, so it reports the loss itself once reset is done. */
export const readCommittedOnceKeys = (storage, prefix) => {
  const keys = new Set();
  let corruptSources = 0;
  const rawOnceKeys = storage.get(onceKeysKey(prefix));
  if (rawOnceKeys) {
    const record = decodeSupportedPersistence(rawOnceKeys, PERSISTENCE_SCHEMA_VERSION, isOnceKeyRecord);
    if (record) {
      for (const key of record.keys) keys.add(key);
    } else {
      corruptSources += 1;
    }
  }
  const rawOperations = storage.get(`${prefix}ops`);
  if (rawOperations) {
    const records = decodeSupportedPersistence(rawOperations, PERSISTENCE_SCHEMA_VERSION, isOperationRecordMap);
    if (records) {
      for (const record of Object.values(records)) {
        if (record.status === 'committed' && record.once === true && typeof record.idempotencyKey === 'string') keys.add(record.idempotencyKey);
      }
    } else {
      corruptSources += 1;
    }
  }
  return {
    keys: [...keys].sort(),
    corruptSources
  };
};
export const writeCommittedOnceKeys = (storage, prefix, keys) => {
  if (keys.length === 0) return;
  storage.set([{
    key: onceKeysKey(prefix),
    value: encodePersistence({
      keys
    })
  }]);
};

/** JSON-round-trip an operation input before it enters the persistent ledger. */
export const serializeOperationInput = input => {
  const seen = new Set();
  const isJsonValue = value => {
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
  if (!isJsonValue(input)) return {
    serializable: false,
    value: undefined
  };
  try {
    return {
      serializable: true,
      value: JSON.parse(JSON.stringify(input))
    };
  } catch {
    return {
      serializable: false,
      value: undefined
    };
  }
};
const CLOSED_TTL_MS = 60 * 60 * 1000;
export const createOperationState = options => {
  const {
    storage,
    prefix,
    now,
    notify
  } = options;
  const operations = new Map();
  const committedKeys = new Set();
  const pendingKeys = new Set();
  const hydratedPendingIds = new Set();
  let pendingPatchCount = 0;
  /** Reverse index: compositeKey(model, rowId) -> every operation whose rowIds/tempIds union includes
   * that rowId, regardless of status. Each accessor re-applies its own historical row-match predicate
   * (rowIds-or-tempIds vs rowIds-only vs union) within the bucket - the union key is a safe superset for
   * all three, so results stay identical to the prior full-array scans, just O(bucket-size). */
  const opsByRowKey = new Map();
  const rowKeysFor = record => union(record.tempIds, record.rowIds ?? []).map(rowId => compositeKey(record.model, rowId));
  const indexRecordRows = record => {
    for (const key of rowKeysFor(record)) {
      let bucket = opsByRowKey.get(key);
      if (!bucket) {
        bucket = new Set();
        opsByRowKey.set(key, bucket);
      }
      bucket.add(record);
    }
  };
  const unindexRecordRows = record => {
    for (const key of rowKeysFor(record)) {
      const bucket = opsByRowKey.get(key);
      if (!bucket) continue;
      bucket.delete(record);
      if (bucket.size === 0) opsByRowKey.delete(key);
    }
  };
  const bucketFor = (model, rowId) => opsByRowKey.get(compositeKey(model, rowId));
  const indexOperation = record => {
    if (!record.idempotencyKey) return;
    if (record.status === 'pending') pendingKeys.add(record.idempotencyKey);else pendingKeys.delete(record.idempotencyKey);
    if (record.status === 'committed' && record.once === true) committedKeys.add(record.idempotencyKey);
  };
  const rebuildIndexes = () => {
    committedKeys.clear();
    pendingKeys.clear();
    opsByRowKey.clear();
    for (const record of operations.values()) {
      indexOperation(record);
      indexRecordRows(record);
    }
  };
  const opsKey = () => `${prefix()}ops`;
  const persistEntries = () => {
    const keys = [...committedKeys].sort();
    return [{
      key: opsKey(),
      value: operations.size > 0 ? encodePersistence(Object.fromEntries(operations)) : null
    }, {
      key: onceKeysKey(prefix()),
      value: keys.length > 0 ? encodePersistence({
        keys
      }) : null
    }];
  };
  const EMPTY_OWNED = new Set();
  return {
    begin: (operation, options) => {
      const record = {
        ...operation,
        status: 'pending'
      };
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
      const record = {
        ...operation,
        status,
        idempotencyKey: retainKey ? operation.idempotencyKey : undefined
      };
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
    openInsertsFor: model => [...operations.values()].filter(operation => operation.model === model && operation.intent === 'insert' && (operation.status === 'pending' || operation.status === 'failed')),
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
      let latest;
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
      const record = {
        ...operation,
        status: 'pending'
      };
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
    hydratedPending: () => [...hydratedPendingIds].flatMap(operationId => {
      const operation = operations.get(operationId);
      return operation?.status === 'pending' ? [operation] : [];
    }),
    takeHydratedPending: matches => {
      const pending = [];
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
      let owned;
      for (const operation of bucket) {
        if (operation.status !== 'pending' || operation.intent !== 'patch' || !operation.patchedFields || operation.patchedFields.length === 0) continue;
        if (operation.operationId === excludeOpId) continue;
        if (operation.model !== model || !(operation.rowIds ?? []).includes(rowId)) continue;
        owned ??= new Set();
        for (const field of operation.patchedFields) owned.add(field);
      }
      return owned ?? EMPTY_OWNED;
    },
    latestPendingValue: (model, rowId, field, excludeOpId) => {
      if (pendingPatchCount === 0) return {
        found: false,
        value: undefined
      };
      const bucket = bucketFor(model, rowId);
      if (!bucket) return {
        found: false,
        value: undefined
      };
      let result = {
        found: false,
        value: undefined
      };
      for (const operation of bucket) {
        if (operation.status !== 'pending' || operation.intent !== 'patch' || operation.operationId === excludeOpId) continue;
        if (operation.model !== model || !(operation.rowIds ?? []).includes(rowId)) continue;
        if (operation.patchedValues && field in operation.patchedValues) result = {
          found: true,
          value: operation.patchedValues[field]
        };
      }
      return result;
    },
    persistEntries,
    hydrate: () => {
      operations.clear();
      hydratedPendingIds.clear();
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        const records = decodeSupportedPersistence(rawOps, PERSISTENCE_SCHEMA_VERSION, isOperationRecordMap);
        if (records) {
          for (const [operationId, record] of Object.entries(records)) {
            const retainKey = record.status === 'pending' || record.status === 'committed' && record.once === true;
            const hydratedRecord = retainKey ? record : {
              ...record,
              idempotencyKey: undefined
            };
            operations.set(operationId, hydratedRecord);
            if (hydratedRecord.status === 'pending') hydratedPendingIds.add(operationId);
          }
        } else {
          storage.set([{
            key: opsKey(),
            value: null
          }]);
          noteCorruptionLedgerReset();
          noteDataLoss('operation-ledger-corruption-reset', '__operations__', 1);
          getDbLogger().error('cold-ledger recovery', {
            key: opsKey()
          });
        }
      }
      rebuildIndexes();
      for (const key of readCommittedOnceKeys(storage, prefix()).keys) committedKeys.add(key);
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
//# sourceMappingURL=operationState.js.map
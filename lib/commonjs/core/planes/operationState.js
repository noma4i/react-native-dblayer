"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createOperationState = void 0;
var _serialize = require("../serialize.js");
const CLOSED_TTL_MS = 60 * 60 * 1000;
const SEQUENCES_CAP = 512;
const createOperationState = options => {
  const {
    storage,
    prefix,
    now,
    notify
  } = options;
  const operations = new Map();
  const sequences = new Map();
  const committedKeys = new Set();
  const pendingKeys = new Set();
  const hydratedPendingIds = new Set();
  let sequencesDirty = false;
  let pendingPatchCount = 0;
  /** Reverse index: compositeKey(model, rowId) -> every operation whose rowIds/tempIds union includes
   * that rowId, regardless of status. Each accessor re-applies its own historical row-match predicate
   * (rowIds-or-tempIds vs rowIds-only vs union) within the bucket - the union key is a safe superset for
   * all three, so results stay identical to the prior full-array scans, just O(bucket-size). */
  const opsByRowKey = new Map();
  const rowKeysFor = record => {
    const rowIds = new Set([...record.tempIds, ...(record.rowIds ?? [])]);
    return [...rowIds].map(rowId => (0, _serialize.compositeKey)(record.model, rowId));
  };
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
  const bucketFor = (model, rowId) => opsByRowKey.get((0, _serialize.compositeKey)(model, rowId));
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
  const seqKey = () => `${prefix()}seq`;
  const persistEntries = () => {
    const entries = [{
      key: opsKey(),
      value: operations.size > 0 ? JSON.stringify(Object.fromEntries(operations)) : null
    }];
    if (sequencesDirty) {
      entries.push({
        key: seqKey(),
        value: sequences.size > 0 ? JSON.stringify(Object.fromEntries(sequences)) : null
      });
      sequencesDirty = false;
    }
    return entries;
  };
  const EMPTY_OWNED = new Set();
  return {
    begin: operation => {
      const record = {
        ...operation,
        status: 'pending'
      };
      operations.set(operation.operationId, record);
      indexOperation(record);
      indexRecordRows(record);
      if (record.status === 'pending' && record.intent === 'patch' && record.patchedFields && record.patchedFields.length > 0) pendingPatchCount += 1;
      storage.set(persistEntries());
      notify?.(record);
    },
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation) return;
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
    hydratedPending: () => [...hydratedPendingIds].flatMap(operationId => {
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
    nextSequence: (key, floor) => {
      const next = Math.max(sequences.get(key) ?? 0, floor) + 1;
      sequences.delete(key);
      sequences.set(key, next);
      if (sequences.size > SEQUENCES_CAP) {
        const oldest = sequences.keys().next().value;
        if (oldest !== undefined) sequences.delete(oldest);
      }
      sequencesDirty = true;
      return next;
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
      sequences.clear();
      hydratedPendingIds.clear();
      sequencesDirty = false;
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        try {
          for (const [operationId, record] of Object.entries(JSON.parse(rawOps))) {
            const retainKey = record.status === 'pending' || record.status === 'committed' && record.once === true;
            const hydratedRecord = retainKey ? record : {
              ...record,
              idempotencyKey: undefined
            };
            operations.set(operationId, hydratedRecord);
            if (hydratedRecord.status === 'pending') hydratedPendingIds.add(operationId);
          }
        } catch {
          storage.set([{
            key: opsKey(),
            value: null
          }]);
        }
      }
      const rawSeq = storage.get(seqKey());
      if (rawSeq) {
        try {
          for (const [key, value] of Object.entries(JSON.parse(rawSeq))) sequences.set(key, value);
        } catch {
          storage.set([{
            key: seqKey(),
            value: null
          }]);
        }
      }
      rebuildIndexes();
      pendingPatchCount = 0;
      for (const op of operations.values()) if (op.status === 'pending' && op.intent === 'patch' && op.patchedFields && op.patchedFields.length > 0) pendingPatchCount += 1;
    },
    reset: () => {
      operations.clear();
      sequences.clear();
      committedKeys.clear();
      pendingKeys.clear();
      hydratedPendingIds.clear();
      opsByRowKey.clear();
      sequencesDirty = false;
      pendingPatchCount = 0;
    }
  };
};
exports.createOperationState = createOperationState;
//# sourceMappingURL=operationState.js.map
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.writeCommittedOnceKeys = exports.serializeOperationInput = exports.readCommittedOnceKeys = exports.createOperationState = void 0;
var _esToolkit = require("es-toolkit");
var _serialize = require("../serialize.js");
var _diagnostics = require("../diagnostics.js");
var _logger = require("../logger.js");
var _persistenceCodec = require("../persistenceCodec.js");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
const onceKeysKey = prefix => `${prefix}ops-once`;
const isOperationRecord = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && (0, _normalizeHelpers.isNonEmptyString)(value.operationId) && (0, _normalizeHelpers.isNonEmptyString)(value.model) && Array.isArray(value.tempIds) && value.tempIds.every(_normalizeHelpers.isNonEmptyString) && (value.rowIds === undefined || Array.isArray(value.rowIds) && value.rowIds.every(_normalizeHelpers.isNonEmptyString)) && (value.intent === 'insert' || value.intent === 'patch' || value.intent === 'destroy') && (value.status === 'pending' || value.status === 'committed' || value.status === 'rolledback' || value.status === 'failed') && (0, _normalizeHelpers.isNonNegativeSafeInteger)(value.createdAt) && (value.kind === undefined || (0, _normalizeHelpers.isNonEmptyString)(value.kind)) && (value.idempotencyKey === undefined || (0, _normalizeHelpers.isNonEmptyString)(value.idempotencyKey)) && (value.once === undefined || typeof value.once === 'boolean') && (value.patchedFields === undefined || Array.isArray(value.patchedFields) && value.patchedFields.every(_normalizeHelpers.isNonEmptyString)) && (value.patchedValues === undefined || (0, _normalizeHelpers.isNonArrayRecord)(value.patchedValues));
const isOperationRecordMap = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && Object.entries(value).every(([operationId, record]) => (0, _normalizeHelpers.isNonEmptyString)(operationId) && isOperationRecord(record) && record.operationId === operationId);
const isOnceKeyRecord = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && Array.isArray(value.keys) && value.keys.every(_normalizeHelpers.isNonEmptyString);

/** Corrupt sources are counted, not reported here: the manifest cold-reset caller runs `resetRuntime`
 * (which clears diagnostics) right after this read, so it reports the loss itself once reset is done. */
const readCommittedOnceKeys = (storage, prefix) => {
  const keys = new Set();
  let corruptSources = 0;
  const rawOnceKeys = storage.get(onceKeysKey(prefix));
  if (rawOnceKeys) {
    const record = (0, _persistenceCodec.decodeSupportedPersistence)(rawOnceKeys, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isOnceKeyRecord);
    if (record) {
      for (const key of record.keys) keys.add(key);
    } else {
      corruptSources += 1;
    }
  }
  const rawOperations = storage.get(`${prefix}ops`);
  if (rawOperations) {
    const records = (0, _persistenceCodec.decodeSupportedPersistence)(rawOperations, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isOperationRecordMap);
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
exports.readCommittedOnceKeys = readCommittedOnceKeys;
const writeCommittedOnceKeys = (storage, prefix, keys) => {
  if (keys.length === 0) return;
  storage.set([{
    key: onceKeysKey(prefix),
    value: (0, _persistenceCodec.encodePersistence)({
      keys
    })
  }]);
};

/** JSON-round-trip an operation input before it enters the persistent ledger. */
exports.writeCommittedOnceKeys = writeCommittedOnceKeys;
const serializeOperationInput = input => {
  return (0, _persistenceCodec.jsonRoundTrip)(input);
};
exports.serializeOperationInput = serializeOperationInput;
const CLOSED_TTL_MS = 60 * 60 * 1000;
const createOperationState = options => {
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
  const rowKeysFor = record => (0, _esToolkit.union)(record.tempIds, record.rowIds ?? []).map(rowId => (0, _serialize.compositeKey)(record.model, rowId));
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
  const entriesFor = (records, onceKeys) => {
    const keys = [...onceKeys].sort();
    const persistedRecords = Object.fromEntries([...records].map(([operationId, record]) => [operationId, (0, _esToolkit.omitBy)(record, _esToolkit.isUndefined)]));
    return [{
      key: opsKey(),
      value: records.size > 0 ? (0, _persistenceCodec.encodePersistence)(persistedRecords) : null
    }, {
      key: onceKeysKey(prefix()),
      value: keys.length > 0 ? (0, _persistenceCodec.encodePersistence)({
        keys
      }) : null
    }];
  };
  const persistEntries = () => entriesFor(operations, committedKeys);
  const applyTransition = (records, onceKeys, transition) => {
    if (transition.kind === 'begin') {
      const next = {
        ...transition.operation,
        tempIds: [...transition.operation.tempIds],
        ...(transition.operation.rowIds ? {
          rowIds: [...transition.operation.rowIds]
        } : {}),
        ...(transition.operation.patchedFields ? {
          patchedFields: [...transition.operation.patchedFields]
        } : {}),
        status: 'pending'
      };
      const previous = records.get(next.operationId);
      records.set(next.operationId, next);
      return {
        previous,
        next
      };
    }
    const previous = records.get(transition.operationId);
    if (!previous) return {};
    if (transition.kind === 'close') {
      if (previous.status !== 'pending') return {};
      const retainKey = transition.status === 'committed' && previous.once === true;
      const next = {
        ...previous,
        status: transition.status,
        idempotencyKey: retainKey ? previous.idempotencyKey : undefined
      };
      records.set(transition.operationId, next);
      if (retainKey && next.idempotencyKey) onceKeys.add(next.idempotencyKey);
      return {
        previous,
        next
      };
    }
    if (transition.expectedStatus !== undefined && previous.status !== transition.expectedStatus) return {};
    records.delete(transition.operationId);
    return {
      previous
    };
  };
  const isPendingPatchOwner = operation => operation?.status === 'pending' && operation.intent === 'patch' && !!operation.patchedFields && operation.patchedFields.length > 0;
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
      storage.set(persistEntries());
      notify?.(record);
    },
    get: operationId => operations.get(operationId),
    hasCommitted: idempotencyKey => committedKeys.has(idempotencyKey) || operations.get(idempotencyKey)?.status === 'committed',
    hasPending: idempotencyKey => pendingKeys.has(idempotencyKey),
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    open: () => [...operations.values()].filter(operation => operation.status === 'pending' || operation.status === 'failed'),
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
    remove: operationId => {
      const operation = operations.get(operationId);
      if (!operation) return;
      hydratedPendingIds.delete(operationId);
      operations.delete(operationId);
      rebuildIndexes();
      storage.set(persistEntries());
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
    prepareTransitions: transitions => {
      const projectedOperations = new Map(operations);
      const projectedCommittedKeys = new Set(committedKeys);
      for (const transition of transitions) applyTransition(projectedOperations, projectedCommittedKeys, transition);
      return entriesFor(projectedOperations, projectedCommittedKeys);
    },
    applyTransitions: transitions => {
      const notifications = [];
      for (const transition of transitions) {
        const operationId = transition.kind === 'begin' ? transition.operation.operationId : transition.operationId;
        const before = operations.get(operationId);
        if (before) {
          unindexRecordRows(before);
          if (before.idempotencyKey && before.status === 'pending') pendingKeys.delete(before.idempotencyKey);
          if (isPendingPatchOwner(before)) pendingPatchCount -= 1;
        }
        const result = applyTransition(operations, committedKeys, transition);
        if (transition.kind !== 'begin') hydratedPendingIds.delete(transition.operationId);
        if (result.next) {
          indexOperation(result.next);
          indexRecordRows(result.next);
          if (isPendingPatchOwner(result.next)) pendingPatchCount += 1;
        } else if (before && result.previous === undefined) {
          indexOperation(before);
          indexRecordRows(before);
          if (isPendingPatchOwner(before)) pendingPatchCount += 1;
        }
        const notification = result.next ?? result.previous;
        if (notification) notifications.push(notification);
      }
      for (const operation of notifications) notify?.(operation);
    },
    hydrate: () => {
      operations.clear();
      hydratedPendingIds.clear();
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        const records = (0, _persistenceCodec.decodeSupportedPersistence)(rawOps, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isOperationRecordMap);
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
          (0, _diagnostics.noteCorruptionLedgerReset)();
          (0, _diagnostics.noteDataLoss)('operation-ledger-corruption-reset', '__operations__', 1);
          (0, _logger.getDbLogger)().error('cold-ledger recovery', {
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
exports.createOperationState = createOperationState;
//# sourceMappingURL=operationState.js.map
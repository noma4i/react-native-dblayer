"use strict";

import { isUndefined, omitBy } from 'es-toolkit';
import { compositeKey } from "../serialize.js";
import { noteCorruptionLedgerReset } from "../diagnostics.js";
import { getDbLogger } from "../logger.js";
import { decodePersistence, decodeSupportedPersistence, encodePersistence, jsonRoundTrip, PERSISTENCE_SCHEMA_VERSION } from "../persistenceCodec.js";
import { putQuarantine } from "../quarantine.js";
import { isNonArrayRecord, isNonEmptyString, isNonNegativeSafeInteger } from "../../utils/normalizeHelpers.js";
const onceKeysKey = prefix => `${prefix}ops-once`;
const OPERATION_STATE_RECORD_VERSION = 2;
const isRollbackMembership = value => isNonArrayRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.scopeKey) && isNonEmptyString(value.orderKey);

/**
 * A tracked-only mutation - deduped or `once`, declared without an optimistic model - owns no rows
 * and names no model, and the rest of the package already reads `''` as exactly that. The reader has
 * to accept what the writer legitimately produces: rejecting one record discards the WHOLE ledger,
 * taking the `once` keys that stop a destructive call from running a second time after a restart.
 */
const namesItsOwner = value => {
  if (isNonEmptyString(value.model)) return true;
  const ownsNoRows = value.tempIds.length === 0 && value.rowIds.length === 0;
  return value.model === '' && ownsNoRows;
};
export const isOperationRecord = value => isNonArrayRecord(value) && isNonEmptyString(value.operationId) && isNonEmptyString(value.actionKey) && (value.actionMode === 'request' || value.actionMode === 'durable') && Array.isArray(value.tempIds) && value.tempIds.every(isNonEmptyString) && Array.isArray(value.rowIds) && value.rowIds.every(isNonEmptyString) && namesItsOwner(value) && (value.intent === 'insert' || value.intent === 'patch' || value.intent === 'destroy') && (value.status === 'pending' || value.status === 'committed' || value.status === 'rolledback' || value.status === 'failed' || value.status === 'delivery_unknown') && isNonNegativeSafeInteger(value.createdAt) && (value.idempotencyKey === undefined || isNonEmptyString(value.idempotencyKey)) && (value.once === undefined || typeof value.once === 'boolean') && (value.patchedFields === undefined || Array.isArray(value.patchedFields) && value.patchedFields.every(isNonEmptyString)) && (value.patchedValues === undefined || isNonArrayRecord(value.patchedValues)) && (!Object.hasOwn(value, 'input') || jsonRoundTrip(value.input).serializable) && Object.hasOwn(value, 'rollbackRow') === Object.hasOwn(value, 'rollbackMemberships') && (!Object.hasOwn(value, 'rollbackRow') || isNonArrayRecord(value.rollbackRow) && jsonRoundTrip(value.rollbackRow).serializable && Array.isArray(value.rollbackMemberships) && value.rollbackMemberships.every(isRollbackMembership));
export const isOperationTransition = value => {
  if (!isNonArrayRecord(value)) return false;
  if (value.kind === 'begin') return isNonArrayRecord(value.operation) && isOperationRecord({
    ...value.operation,
    status: 'pending'
  });
  if (value.kind === 'close') {
    return isNonEmptyString(value.operationId) && (value.status === 'committed' || value.status === 'rolledback' || value.status === 'failed' || value.status === 'delivery_unknown');
  }
  return value.kind === 'remove' && isNonEmptyString(value.operationId) && (value.expectedStatus === undefined || value.expectedStatus === 'pending' || value.expectedStatus === 'committed' || value.expectedStatus === 'rolledback' || value.expectedStatus === 'failed' || value.expectedStatus === 'delivery_unknown');
};
const isPreviousOnceKeyRecord = value => isNonArrayRecord(value) && Array.isArray(value.keys) && value.keys.every(isNonEmptyString);

/**
 * Salvage the persisted ops record entry by entry. The records in the map are independent, so one
 * invalid record quarantines THAT record - it never discards the ledger. A moved record version is
 * routine evolution: every record the current validator still accepts is kept, the rest are
 * quarantined verbatim. Only an unreadable envelope (malformed JSON / checksum) salvages nothing.
 */
const salvageLedgerValue = raw => {
  const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, value => isNonArrayRecord(value));
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'corrupt') return {
    kind: 'unreadable'
  };
  const value = decoded.value;
  const versioned = Number.isSafeInteger(value.recordVersion);
  const staleVersion = versioned && value.recordVersion !== OPERATION_STATE_RECORD_VERSION;
  const candidates = versioned ? isNonArrayRecord(value.operations) ? value.operations : {} : value;
  const operations = {};
  const quarantined = [];
  for (const [operationId, record] of Object.entries(candidates)) {
    if (isOperationRecord(record) && record.operationId === operationId) operations[operationId] = record;else quarantined.push({
      id: operationId,
      raw: record,
      reason: staleVersion ? 'stale-record-version' : 'invalid-operation-record'
    });
  }
  const committedKeys = versioned && Array.isArray(value.committedKeys) ? value.committedKeys.filter(isNonEmptyString) : [];
  return {
    kind: 'salvaged',
    operations,
    committedKeys,
    quarantined,
    rewrite: staleVersion || !versioned || quarantined.length > 0
  };
};

/** Corrupt sources are counted, not reported here: the manifest cold-reset caller runs `resetRuntime`
 * (which clears diagnostics) right after this read, so it reports the loss itself once reset is done. */
export const readCommittedOnceKeys = (storage, prefix) => {
  const keys = new Set();
  let corruptSources = 0;
  const rawOnceKeys = storage.get(onceKeysKey(prefix));
  if (rawOnceKeys) {
    const record = decodeSupportedPersistence(rawOnceKeys, PERSISTENCE_SCHEMA_VERSION, isPreviousOnceKeyRecord);
    if (record) {
      for (const key of record.keys) keys.add(key);
    } else {
      corruptSources += 1;
    }
  }
  const rawOperations = storage.get(`${prefix}ops`);
  if (rawOperations) {
    const salvage = salvageLedgerValue(rawOperations);
    if (salvage.kind === 'unreadable') {
      corruptSources += 1;
    } else {
      for (const key of salvage.committedKeys) keys.add(key);
      for (const record of Object.values(salvage.operations)) {
        if (record.status === 'committed' && record.once === true && typeof record.idempotencyKey === 'string') keys.add(record.idempotencyKey);
      }
    }
  }
  return {
    keys: [...keys].sort(),
    corruptSources
  };
};
export const committedOnceKeysEntry = (prefix, keys) => keys.length === 0 ? undefined : {
  key: `${prefix}ops`,
  value: encodePersistence({
    recordVersion: OPERATION_STATE_RECORD_VERSION,
    operations: {},
    committedKeys: [...keys].sort()
  })
};

/** Drop own enumerable undefined keys from plain objects, matching JSON.stringify semantics.
 * Arrays, cycles, and non-plain objects pass through untouched for the lossless gate to reject. */
const dropUndefinedOwnKeys = (input, ancestors = new Set()) => {
  if (Array.isArray(input)) {
    if (ancestors.has(input)) return input;
    ancestors.add(input);
    const mapped = input.map(entry => dropUndefinedOwnKeys(entry, ancestors));
    ancestors.delete(input);
    return mapped;
  }
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) return input;
  if (ancestors.has(input)) return input;
  const rebuildable = Reflect.ownKeys(input).every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
  if (!rebuildable) return input;
  ancestors.add(input);
  const output = {};
  for (const [key, entry] of Object.entries(input)) {
    if (entry === undefined) continue;
    output[key] = dropUndefinedOwnKeys(entry, ancestors);
  }
  ancestors.delete(input);
  return output;
};

/** Normalize the action-input boundary (JSON semantics), then JSON-round-trip the value before it
 * enters the persistent ledger. */
export const serializeOperationInput = input => {
  return jsonRoundTrip(dropUndefinedOwnKeys(input));
};
const CLOSED_TTL_MS = 60 * 60 * 1000;
export const createOperationState = options => {
  const {
    storage,
    prefix,
    now
  } = options;
  const operations = new Map();
  const committedKeys = new Set();
  const pendingKeys = new Set();
  const hydratedPendingIds = new Set();
  let pendingPatchCount = 0;
  /** Reverse index: compositeKey(model, rowId) -> every operation whose canonical rowIds include
   * that rowId, regardless of status. */
  const opsByRowKey = new Map();
  const rowKeysFor = record => record.rowIds.map(rowId => compositeKey(record.model, rowId));
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
  const indexRecord = record => {
    indexOperation(record);
    indexRecordRows(record);
    if (isPendingPatchOwner(record)) pendingPatchCount += 1;
  };
  const unindexRecord = record => {
    if (record.idempotencyKey && record.status === 'pending') pendingKeys.delete(record.idempotencyKey);
    unindexRecordRows(record);
    if (isPendingPatchOwner(record)) pendingPatchCount -= 1;
  };
  /** The same pair applied to every record: a projection rebuilt here can never disagree with one maintained incrementally. */
  const rebuildIndexes = () => {
    committedKeys.clear();
    pendingKeys.clear();
    opsByRowKey.clear();
    pendingPatchCount = 0;
    for (const record of operations.values()) indexRecord(record);
  };
  const opsKey = () => `${prefix()}ops`;
  const entriesFor = (records, onceKeys) => {
    const keys = [...onceKeys].sort();
    const persistedRecords = Object.fromEntries([...records].map(([operationId, record]) => [operationId, omitBy(record, isUndefined)]));
    if (records.size === 0 && keys.length === 0) {
      return storage.get(opsKey()) === undefined ? [] : [{
        key: opsKey(),
        value: null
      }];
    }
    return [{
      key: opsKey(),
      value: encodePersistence({
        recordVersion: OPERATION_STATE_RECORD_VERSION,
        operations: persistedRecords,
        committedKeys: keys
      })
    }];
  };
  const persist = () => {
    const entry = entriesFor(operations, committedKeys)[0];
    if (!entry) return;
    storage.set(entry.key, entry.value);
  };
  const persistEntries = () => entriesFor(operations, committedKeys);
  const applyTransition = (records, onceKeys, transition) => {
    if (transition.kind === 'begin') {
      const next = {
        ...transition.operation,
        tempIds: [...transition.operation.tempIds],
        rowIds: [...transition.operation.rowIds],
        ...(transition.operation.patchedFields ? {
          patchedFields: [...transition.operation.patchedFields]
        } : {}),
        ...(transition.operation.rollbackRow ? {
          rollbackRow: {
            ...transition.operation.rollbackRow
          }
        } : {}),
        ...(transition.operation.rollbackMemberships ? {
          rollbackMemberships: transition.operation.rollbackMemberships.map(membership => ({
            ...membership
          }))
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
      indexRecord(record);
      persist();
    },
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation || operation.status !== 'pending') return;
      hydratedPendingIds.delete(operationId);
      const retainKey = status === 'committed' && operation.once === true;
      const record = {
        ...operation,
        status,
        idempotencyKey: retainKey ? operation.idempotencyKey : undefined
      };
      unindexRecord(operation);
      operations.set(operationId, record);
      indexRecord(record);
      persist();
    },
    get: operationId => operations.get(operationId),
    hasCommitted: idempotencyKey => committedKeys.has(idempotencyKey),
    hasPending: idempotencyKey => pendingKeys.has(idempotencyKey),
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    open: () => [...operations.values()].filter(operation => operation.status === 'pending' || operation.status === 'failed' || operation.status === 'delivery_unknown'),
    openInsertsFor: model => [...operations.values()].filter(operation => operation.model === model && operation.intent === 'insert' && (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'delivery_unknown')),
    openRowIdsFor: model => {
      const held = new Set();
      for (const operation of operations.values()) {
        if (operation.model !== model || operation.status !== 'pending' && operation.status !== 'failed' && operation.status !== 'delivery_unknown') {
          continue;
        }
        for (const id of operation.rowIds) held.add(id);
      }
      return held;
    },
    pendingForRow: (model, rowId) => {
      const bucket = bucketFor(model, rowId);
      if (!bucket) return [];
      return [...bucket].filter(operation => operation.status === 'pending');
    },
    failedForRow: (model, rowId) => {
      const bucket = bucketFor(model, rowId);
      if (!bucket) return [];
      // The bucket is keyed by (model, rowId); status is the only live filter.
      return [...bucket].filter(operation => operation.status === 'failed');
    },
    deliveryUnknownForRow: (model, rowId) => {
      const bucket = bucketFor(model, rowId);
      if (!bucket) return [];
      return [...bucket].filter(operation => operation.status === 'delivery_unknown');
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
      persist();
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
      persist();
      return record;
    },
    residentRowBuckets: () => opsByRowKey.size,
    remove: operationId => {
      const operation = operations.get(operationId);
      if (!operation) return;
      hydratedPendingIds.delete(operationId);
      operations.delete(operationId);
      rebuildIndexes();
      persist();
    },
    hydratedPending: () => [...hydratedPendingIds].map(operationId => operations.get(operationId)),
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
        if (operation.status !== 'pending' && operation.status !== 'failed' && operation.status !== 'delivery_unknown' && !retainedOnce && operation.createdAt < cutoff) {
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
        if (before) unindexRecord(before);
        const result = applyTransition(operations, committedKeys, transition);
        // A no-op transition (status mismatch / unknown id) must not strip the hydrated resume mark.
        if (transition.kind !== 'begin' && (result.next !== undefined || result.previous !== undefined)) hydratedPendingIds.delete(transition.operationId);
        if (result.next) indexRecord(result.next);else if (before && result.previous === undefined) indexRecord(before);
        const notification = result.next ?? result.previous;
        if (notification) notifications.push(notification);
      }
      return notifications;
    },
    hydrate: () => {
      operations.clear();
      hydratedPendingIds.clear();
      const rawOps = storage.get(opsKey());
      let rewriteSalvaged = false;
      if (rawOps) {
        const salvage = salvageLedgerValue(rawOps);
        if (salvage.kind === 'unreadable') {
          // The raw ledger is kept verbatim in the quarantine - an unreadable envelope is loud, not a wipe.
          putQuarantine({
            kind: 'ledger',
            model: '__operations__',
            id: 'ops',
            raw: rawOps,
            reason: 'unreadable-ledger-envelope'
          });
          storage.set(opsKey(), null);
          noteCorruptionLedgerReset();
          getDbLogger().error('ledger quarantined', {
            key: opsKey()
          });
        } else {
          for (const [operationId, record] of Object.entries(salvage.operations)) {
            const retainKey = record.status === 'pending' || record.status === 'committed' && record.once === true;
            const hydratedRecord = retainKey ? record : {
              ...record,
              idempotencyKey: undefined
            };
            operations.set(operationId, hydratedRecord);
            if (hydratedRecord.status === 'pending') hydratedPendingIds.add(operationId);
          }
          for (const key of salvage.committedKeys) committedKeys.add(key);
          for (const entry of salvage.quarantined) {
            const model = isNonArrayRecord(entry.raw) && isNonEmptyString(entry.raw.model) ? entry.raw.model : '__operations__';
            putQuarantine({
              kind: 'operation',
              model,
              id: entry.id,
              raw: entry.raw,
              reason: entry.reason
            });
          }
          rewriteSalvaged = salvage.rewrite;
        }
      }
      rebuildIndexes();
      for (const key of readCommittedOnceKeys(storage, prefix()).keys) committedKeys.add(key);
      if (storage.get(onceKeysKey(prefix())) !== undefined) {
        persist();
        storage.set(onceKeysKey(prefix()), null);
      } else if (rewriteSalvaged) {
        // Rewrite the salvaged state under the current record version so the next boot reads it clean.
        persist();
      }
      pendingPatchCount = 0;
      for (const op of operations.values()) if (isPendingPatchOwner(op)) pendingPatchCount += 1;
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
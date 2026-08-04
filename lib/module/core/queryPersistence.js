"use strict";

import { getDbRuntimeConfig, getStoragePrefix } from "../dsl/configure.js";
import { isRecord } from "../utils/normalizeHelpers.js";
import { decodeVersionedRecord, encodePersistence, jsonRoundTrip, PERSISTENCE_SCHEMA_VERSION } from "./persistenceCodec.js";
import { compositeStorageKey } from "./serialize.js";
import { reportSyncError } from "./syncError.js";
const QUERY_RECORD_VERSION = 2;
const QUERY_INVALIDATION_RECORD_VERSION = 1;
const isQueryPersistenceRecord = value => isRecord(value) && typeof value.family === 'string' && typeof value.identity === 'string' && Number.isSafeInteger(value.persistenceVersion) && typeof value.fingerprint === 'string' && typeof value.empty === 'boolean' && typeof value.dataUpdatedAt === 'number' && Number.isFinite(value.dataUpdatedAt) && value.dataUpdatedAt >= 0 && typeof value.invalidated === 'boolean' && typeof value.invalidationRevision === 'number' && Number.isSafeInteger(value.invalidationRevision) && value.invalidationRevision >= 0 && Object.hasOwn(value, 'scope') && Object.hasOwn(value, 'payload');
const isQueryInvalidationRecord = value => isRecord(value) && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0 && isRecord(value.identities) && Object.values(value.identities).every(revision => typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0);
const familyPrefix = family => compositeStorageKey(getStoragePrefix(), 'query', family);
const recordKey = (family, identity) => compositeStorageKey(getStoragePrefix(), 'query', family, identity);
const invalidationKey = family => compositeStorageKey(getStoragePrefix(), 'query-invalidation', family);
const removeKeys = keys => {
  for (const key of keys) getDbRuntimeConfig().storage.set(key, null);
};
const reportRejectedRecord = (family, error) => {
  reportSyncError(error, {
    source: 'query',
    key: family
  }, 'queryPersistence');
};
const emptyInvalidationRecord = () => ({
  recordVersion: QUERY_INVALIDATION_RECORD_VERSION,
  revision: 0,
  identities: {}
});
const readInvalidationRecord = family => {
  const storage = getDbRuntimeConfig().storage;
  const raw = storage.get(invalidationKey(family));
  if (raw === undefined) return emptyInvalidationRecord();
  const decoded = decodeVersionedRecord(raw, PERSISTENCE_SCHEMA_VERSION, QUERY_INVALIDATION_RECORD_VERSION, isQueryInvalidationRecord);
  if (decoded.kind === 'ok') return decoded.value;
  removeKeys([...storage.keys(familyPrefix(family)), invalidationKey(family)]);
  if (decoded.kind === 'corrupt') {
    reportRejectedRecord(family, new Error('react-native-dblayer: corrupt persisted query invalidation record'));
  }
  return undefined;
};
const withInvalidation = (record, invalidation) => ({
  ...record,
  invalidated: record.invalidated || (invalidation.identities[record.identity] ?? 0) > record.invalidationRevision
});
export const readQueryPersistenceRevision = (declaration, identity) => readInvalidationRecord(declaration.family)?.identities[identity] ?? 0;
export const readPersistedQuery = (declaration, identity, validate) => {
  const storage = getDbRuntimeConfig().storage;
  const invalidation = readInvalidationRecord(declaration.family);
  if (invalidation === undefined) return undefined;
  const key = recordKey(declaration.family, identity);
  const raw = storage.get(key);
  if (raw === undefined) return undefined;
  const decoded = decodeVersionedRecord(raw, PERSISTENCE_SCHEMA_VERSION, QUERY_RECORD_VERSION, isQueryPersistenceRecord);
  if (decoded.kind !== 'ok') {
    removeKeys([key]);
    if (decoded.kind === 'corrupt') {
      reportRejectedRecord(declaration.family, new Error('react-native-dblayer: corrupt persisted query record'));
    }
    return undefined;
  }
  const record = decoded.value;
  if (record.family !== declaration.family || record.identity !== identity || record.persistenceVersion !== declaration.persistenceVersion || record.fingerprint !== declaration.fingerprint) {
    removeKeys([key]);
    return undefined;
  }
  try {
    const validated = validate(record);
    return withInvalidation({
      ...record,
      payload: validated.payload,
      scope: validated.scope
    }, invalidation);
  } catch (error) {
    removeKeys([key]);
    reportRejectedRecord(declaration.family, error);
    return undefined;
  }
};
export const readPersistedQueryFamily = declaration => {
  const storage = getDbRuntimeConfig().storage;
  const invalidation = readInvalidationRecord(declaration.family);
  if (invalidation === undefined) return [];
  const records = [];
  for (const key of storage.keys(familyPrefix(declaration.family))) {
    const raw = storage.get(key);
    if (raw === undefined) continue;
    const decoded = decodeVersionedRecord(raw, PERSISTENCE_SCHEMA_VERSION, QUERY_RECORD_VERSION, isQueryPersistenceRecord);
    if (decoded.kind !== 'ok' || decoded.value.family !== declaration.family || key !== recordKey(declaration.family, decoded.value.identity) || decoded.value.persistenceVersion !== declaration.persistenceVersion || decoded.value.fingerprint !== declaration.fingerprint) {
      removeKeys([key]);
      if (decoded.kind === 'corrupt') {
        reportRejectedRecord(declaration.family, new Error('react-native-dblayer: corrupt persisted query record'));
      }
      continue;
    }
    records.push(withInvalidation(decoded.value, invalidation));
  }
  return records;
};
export const writePersistedQuery = input => {
  const scope = jsonRoundTrip(input.scope);
  const payload = jsonRoundTrip(input.payload);
  if (!scope.serializable || !payload.serializable) {
    reportRejectedRecord(input.family, new Error('react-native-dblayer: persisted query scope and payload must be lossless JSON values'));
    return false;
  }
  const record = {
    recordVersion: QUERY_RECORD_VERSION,
    family: input.family,
    identity: input.identity,
    persistenceVersion: input.persistenceVersion,
    fingerprint: input.fingerprint,
    scope: scope.value,
    payload: payload.value,
    empty: input.empty,
    dataUpdatedAt: input.dataUpdatedAt,
    invalidated: input.invalidated ?? false,
    invalidationRevision: input.invalidationRevision ?? readQueryPersistenceRevision(input, input.identity)
  };
  const storage = getDbRuntimeConfig().storage;
  storage.set(recordKey(input.family, input.identity), encodePersistence(record));
  const invalidation = readInvalidationRecord(input.family);
  const targetRevision = invalidation?.identities[input.identity];
  if (invalidation !== undefined && targetRevision !== undefined && targetRevision <= record.invalidationRevision) {
    const identities = {
      ...invalidation.identities
    };
    delete identities[input.identity];
    storage.set(invalidationKey(input.family), encodePersistence({
      ...invalidation,
      identities
    }));
  }
  return true;
};
const invalidateRecords = (family, records) => {
  if (records.length === 0) return false;
  const invalidation = readInvalidationRecord(family);
  if (invalidation === undefined) return false;
  const revision = invalidation.revision + 1;
  const identities = {
    ...invalidation.identities
  };
  for (const record of records) identities[record.identity] = revision;
  getDbRuntimeConfig().storage.set(invalidationKey(family), encodePersistence({
    ...invalidation,
    revision,
    identities
  }));
  return true;
};
export const invalidatePersistedQuery = (declaration, accepts) => {
  const records = readPersistedQueryFamily(declaration).filter(accepts);
  if (!invalidateRecords(declaration.family, records)) return [];
  return records.map(record => ({
    ...record,
    invalidated: true
  }));
};
export const removePersistedQuery = (declaration, identity) => {
  if (identity !== undefined) {
    removeKeys([recordKey(declaration.family, identity)]);
    const invalidation = readInvalidationRecord(declaration.family);
    if (invalidation?.identities[identity] !== undefined) {
      const identities = {
        ...invalidation.identities
      };
      delete identities[identity];
      getDbRuntimeConfig().storage.set(invalidationKey(declaration.family), encodePersistence({
        ...invalidation,
        identities
      }));
    }
    return;
  }
  const records = readPersistedQueryFamily(declaration);
  invalidateRecords(declaration.family, records);
  removeKeys(records.map(record => recordKey(declaration.family, record.identity)));
  removeKeys([invalidationKey(declaration.family)]);
};
//# sourceMappingURL=queryPersistence.js.map
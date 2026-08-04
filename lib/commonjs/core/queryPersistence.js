"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.writePersistedQuery = exports.removePersistedQuery = exports.readQueryPersistenceRevision = exports.readPersistedQueryFamily = exports.readPersistedQuery = exports.invalidatePersistedQuery = void 0;
var _configure = require("../dsl/configure.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _serialize = require("./serialize.js");
var _syncError = require("./syncError.js");
const QUERY_RECORD_VERSION = 2;
const QUERY_INVALIDATION_RECORD_VERSION = 1;
const isQueryPersistenceRecord = value => (0, _normalizeHelpers.isRecord)(value) && typeof value.family === 'string' && typeof value.identity === 'string' && Number.isSafeInteger(value.persistenceVersion) && typeof value.fingerprint === 'string' && typeof value.empty === 'boolean' && typeof value.dataUpdatedAt === 'number' && Number.isFinite(value.dataUpdatedAt) && value.dataUpdatedAt >= 0 && typeof value.invalidated === 'boolean' && typeof value.invalidationRevision === 'number' && Number.isSafeInteger(value.invalidationRevision) && value.invalidationRevision >= 0 && Object.hasOwn(value, 'scope') && Object.hasOwn(value, 'payload');
const isQueryInvalidationRecord = value => (0, _normalizeHelpers.isRecord)(value) && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0 && (0, _normalizeHelpers.isRecord)(value.identities) && Object.values(value.identities).every(revision => typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0);
const familyPrefix = family => (0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'query', family);
const recordKey = (family, identity) => (0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'query', family, identity);
const invalidationKey = family => (0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'query-invalidation', family);
const removeKeys = keys => {
  for (const key of keys) (0, _configure.getDbRuntimeConfig)().storage.set(key, null);
};
const reportRejectedRecord = (family, error) => {
  (0, _syncError.reportSyncError)(error, {
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
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  const raw = storage.get(invalidationKey(family));
  if (raw === undefined) return emptyInvalidationRecord();
  const decoded = (0, _persistenceCodec.decodeVersionedRecord)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, QUERY_INVALIDATION_RECORD_VERSION, isQueryInvalidationRecord);
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
const readQueryPersistenceRevision = (declaration, identity) => readInvalidationRecord(declaration.family)?.identities[identity] ?? 0;
exports.readQueryPersistenceRevision = readQueryPersistenceRevision;
const readPersistedQuery = (declaration, identity, validate) => {
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  const invalidation = readInvalidationRecord(declaration.family);
  if (invalidation === undefined) return undefined;
  const key = recordKey(declaration.family, identity);
  const raw = storage.get(key);
  if (raw === undefined) return undefined;
  const decoded = (0, _persistenceCodec.decodeVersionedRecord)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, QUERY_RECORD_VERSION, isQueryPersistenceRecord);
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
exports.readPersistedQuery = readPersistedQuery;
const readPersistedQueryFamily = declaration => {
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  const invalidation = readInvalidationRecord(declaration.family);
  if (invalidation === undefined) return [];
  const records = [];
  for (const key of storage.keys(familyPrefix(declaration.family))) {
    const raw = storage.get(key);
    if (raw === undefined) continue;
    const decoded = (0, _persistenceCodec.decodeVersionedRecord)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, QUERY_RECORD_VERSION, isQueryPersistenceRecord);
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
exports.readPersistedQueryFamily = readPersistedQueryFamily;
const writePersistedQuery = input => {
  const scope = (0, _persistenceCodec.jsonRoundTrip)(input.scope);
  const payload = (0, _persistenceCodec.jsonRoundTrip)(input.payload);
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
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  storage.set(recordKey(input.family, input.identity), (0, _persistenceCodec.encodePersistence)(record));
  const invalidation = readInvalidationRecord(input.family);
  const targetRevision = invalidation?.identities[input.identity];
  if (invalidation !== undefined && targetRevision !== undefined && targetRevision <= record.invalidationRevision) {
    const identities = {
      ...invalidation.identities
    };
    delete identities[input.identity];
    storage.set(invalidationKey(input.family), (0, _persistenceCodec.encodePersistence)({
      ...invalidation,
      identities
    }));
  }
  return true;
};
exports.writePersistedQuery = writePersistedQuery;
const invalidateRecords = (family, records) => {
  if (records.length === 0) return false;
  const invalidation = readInvalidationRecord(family);
  if (invalidation === undefined) return false;
  const revision = invalidation.revision + 1;
  const identities = {
    ...invalidation.identities
  };
  for (const record of records) identities[record.identity] = revision;
  (0, _configure.getDbRuntimeConfig)().storage.set(invalidationKey(family), (0, _persistenceCodec.encodePersistence)({
    ...invalidation,
    revision,
    identities
  }));
  return true;
};
const invalidatePersistedQuery = (declaration, accepts) => {
  const records = readPersistedQueryFamily(declaration).filter(accepts);
  if (!invalidateRecords(declaration.family, records)) return [];
  return records.map(record => ({
    ...record,
    invalidated: true
  }));
};
exports.invalidatePersistedQuery = invalidatePersistedQuery;
const removePersistedQuery = (declaration, identity) => {
  if (identity !== undefined) {
    removeKeys([recordKey(declaration.family, identity)]);
    const invalidation = readInvalidationRecord(declaration.family);
    if (invalidation?.identities[identity] !== undefined) {
      const identities = {
        ...invalidation.identities
      };
      delete identities[identity];
      (0, _configure.getDbRuntimeConfig)().storage.set(invalidationKey(declaration.family), (0, _persistenceCodec.encodePersistence)({
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
exports.removePersistedQuery = removePersistedQuery;
//# sourceMappingURL=queryPersistence.js.map
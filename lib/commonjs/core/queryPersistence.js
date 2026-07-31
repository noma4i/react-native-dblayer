"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.writePersistedQuery = exports.removePersistedQuery = exports.readPersistedQueryFamily = exports.readPersistedQuery = exports.invalidatePersistedQuery = void 0;
var _configure = require("../dsl/configure.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _serialize = require("./serialize.js");
var _syncError = require("./syncError.js");
const QUERY_RECORD_VERSION = 1;
const isQueryPersistenceRecord = value => (0, _normalizeHelpers.isRecord)(value) && value.recordVersion === QUERY_RECORD_VERSION && typeof value.family === 'string' && typeof value.identity === 'string' && Number.isSafeInteger(value.persistenceVersion) && typeof value.fingerprint === 'string' && typeof value.empty === 'boolean' && typeof value.dataUpdatedAt === 'number' && Number.isFinite(value.dataUpdatedAt) && value.dataUpdatedAt >= 0 && typeof value.invalidated === 'boolean' && Object.hasOwn(value, 'scope') && Object.hasOwn(value, 'payload');
const familyPrefix = family => (0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'query', family);
const recordKey = (family, identity) => (0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'query', family, identity);
const removeKeys = keys => {
  if (keys.length === 0) return;
  (0, _configure.getDbRuntimeConfig)().storage.set(keys.map(key => ({
    key,
    value: null
  })));
};
const reportRejectedRecord = (family, error) => {
  (0, _syncError.reportSyncError)(error, {
    source: 'query',
    key: family
  }, 'queryPersistence');
};
const readPersistedQuery = (declaration, identity, validate) => {
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  const key = recordKey(declaration.family, identity);
  const raw = storage.get(key);
  if (raw === undefined) return undefined;
  const decoded = (0, _persistenceCodec.decodePersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isQueryPersistenceRecord);
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
    return {
      ...record,
      payload: validated.payload,
      scope: validated.scope
    };
  } catch (error) {
    removeKeys([key]);
    reportRejectedRecord(declaration.family, error);
    return undefined;
  }
};
exports.readPersistedQuery = readPersistedQuery;
const readPersistedQueryFamily = declaration => {
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  const records = [];
  for (const key of storage.keys(familyPrefix(declaration.family))) {
    const raw = storage.get(key);
    if (raw === undefined) continue;
    const decoded = (0, _persistenceCodec.decodePersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isQueryPersistenceRecord);
    if (decoded.kind !== 'ok' || decoded.value.family !== declaration.family || key !== recordKey(declaration.family, decoded.value.identity) || decoded.value.persistenceVersion !== declaration.persistenceVersion || decoded.value.fingerprint !== declaration.fingerprint) {
      removeKeys([key]);
      if (decoded.kind === 'corrupt') {
        reportRejectedRecord(declaration.family, new Error('react-native-dblayer: corrupt persisted query record'));
      }
      continue;
    }
    records.push(decoded.value);
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
    invalidated: input.invalidated ?? false
  };
  (0, _configure.getDbRuntimeConfig)().storage.set([{
    key: recordKey(input.family, input.identity),
    value: (0, _persistenceCodec.encodePersistence)(record)
  }]);
  return true;
};
exports.writePersistedQuery = writePersistedQuery;
const invalidatePersistedQuery = (declaration, accepts) => {
  const records = readPersistedQueryFamily(declaration).filter(accepts);
  for (const record of records) {
    writePersistedQuery({
      ...record,
      invalidated: true
    });
  }
  return records;
};
exports.invalidatePersistedQuery = invalidatePersistedQuery;
const removePersistedQuery = (declaration, identity) => {
  if (identity !== undefined) {
    removeKeys([recordKey(declaration.family, identity)]);
    return;
  }
  removeKeys((0, _configure.getDbRuntimeConfig)().storage.keys(familyPrefix(declaration.family)));
};
exports.removePersistedQuery = removePersistedQuery;
//# sourceMappingURL=queryPersistence.js.map
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.writePersistenceManifest = exports.registerSchemaDeclaration = exports.ensurePersistenceCompatibility = exports.computeSchemaFingerprints = exports.DB_FORMAT_VERSION = void 0;
var _configure = require("../dsl/configure.js");
var _operationState = require("./planes/operationState.js");
var _reset = require("./reset.js");
var _diagnostics = require("./diagnostics.js");
var _serialize = require("./serialize.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const DB_FORMAT_VERSION = exports.DB_FORMAT_VERSION = 8;
const SINGLE_FINGERPRINT_FORMAT_VERSION = 7;
const declarations = new Map();

/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
const registerSchemaDeclaration = declaration => {
  declarations.set(declaration.id, declaration);
};
exports.registerSchemaDeclaration = registerSchemaDeclaration;
const computeSchemaFingerprints = () => Object.fromEntries([...declarations.entries()].sort(([left], [right]) => (0, _serialize.compareCodepoints)(left, right)).map(([id, declaration]) => [id, (0, _serialize.stableSerialize)(declaration)]));
exports.computeSchemaFingerprints = computeSchemaFingerprints;
const manifestKey = prefix => `${prefix}manifest`;
const isSchemaFingerprints = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && Object.entries(value).every(([id, fingerprint]) => (0, _normalizeHelpers.isNonEmptyString)(id) && (0, _normalizeHelpers.isNonEmptyString)(fingerprint));
const isDataVersion = value => value === null || typeof value === 'string';
const isPersistenceManifest = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && typeof value.formatVersion === 'number' && isSchemaFingerprints(value.schemaFingerprints) && isDataVersion(value.dataVersion);
const isSingleFingerprintPersistenceManifest = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && typeof value.formatVersion === 'number' && typeof value.schemaFingerprint === 'string' && isDataVersion(value.dataVersion);
const isPersistenceManifestRecord = value => isPersistenceManifest(value) || isSingleFingerprintPersistenceManifest(value);
const convertSingleFingerprint = schemaFingerprint => {
  try {
    const parsed = JSON.parse(schemaFingerprint);
    if (!Array.isArray(parsed)) return undefined;
    const entries = [];
    const ids = new Set();
    for (const value of parsed) {
      if (!(0, _normalizeHelpers.isNonArrayRecord)(value) || !(0, _normalizeHelpers.isNonEmptyString)(value.id) || ids.has(value.id)) return undefined;
      ids.add(value.id);
      entries.push([value.id, value]);
    }
    return Object.fromEntries(entries.sort(([left], [right]) => (0, _serialize.compareCodepoints)(left, right)).map(([id, declaration]) => [id, (0, _serialize.stableSerialize)(declaration)]));
  } catch {
    return undefined;
  }
};
const readPersistenceManifest = prefix => {
  const raw = (0, _configure.getDbRuntimeConfig)().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  const manifest = (0, _persistenceCodec.decodeSupportedPersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isPersistenceManifestRecord);
  if (!manifest) return undefined;
  if (!isSingleFingerprintPersistenceManifest(manifest) || manifest.formatVersion !== SINGLE_FINGERPRINT_FORMAT_VERSION) {
    return {
      manifest,
      migrated: false
    };
  }
  const schemaFingerprints = convertSingleFingerprint(manifest.schemaFingerprint);
  if (!schemaFingerprints) return undefined;
  return {
    manifest: {
      formatVersion: DB_FORMAT_VERSION,
      schemaFingerprints,
      dataVersion: manifest.dataVersion
    },
    migrated: true
  };
};
const writePersistenceManifest = (prefix, manifest) => {
  (0, _configure.getDbRuntimeConfig)().storage.set([{
    key: manifestKey(prefix),
    value: (0, _persistenceCodec.encodePersistence)(manifest)
  }]);
};
exports.writePersistenceManifest = writePersistenceManifest;
const resetIncompatiblePersistence = (storage, prefix, current, stored) => {
  const committedOnceKeys = (0, _operationState.readCommittedOnceKeys)(storage, prefix);
  (0, _reset.resetRuntime)();
  (0, _operationState.writeCommittedOnceKeys)(storage, prefix, committedOnceKeys.keys);
  (0, _configure.getOperationState)().hydrate();
  (0, _diagnostics.noteDataLoss)('corrupt-once-keys', '__operations__', committedOnceKeys.corruptSources);
  (0, _diagnostics.noteManifestReset)();
  (0, _diagnostics.noteDataLoss)(stored !== undefined ? 'data-version-migration-reset' : 'model-corruption-recovery', '__runtime__', 1);
  writePersistenceManifest(prefix, current);
  return {
    reset: true
  };
};
const clearModelPersistence = (storage, prefix, modelId, epoch) => {
  const entries = [...storage.keys((0, _serialize.compositeStorageKey)(prefix, 'row', modelId)).map(key => ({
    key,
    value: null
  })), ...storage.keys((0, _serialize.compositeStorageKey)(prefix, 'scope', modelId)).map(key => ({
    key,
    value: null
  })), {
    key: (0, _serialize.compositeStorageKey)(prefix, 'tombstones', modelId),
    value: null
  }, {
    key: `${prefix}applied:${modelId}`,
    value: (0, _persistenceCodec.encodePersistence)(epoch)
  }];
  storage.set(entries);
};

/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
const ensurePersistenceCompatibility = () => {
  const {
    storage
  } = (0, _configure.getDbRuntimeConfig)();
  const prefix = (0, _configure.getStoragePrefix)();
  const current = {
    formatVersion: DB_FORMAT_VERSION,
    schemaFingerprints: computeSchemaFingerprints(),
    dataVersion: (0, _configure.getPersistenceDataVersion)()
  };
  const storedResult = readPersistenceManifest(prefix);
  const stored = storedResult?.manifest;
  const nonempty = storage.keys(prefix).some(key => key !== manifestKey(prefix));
  if (!stored) {
    if (nonempty) return resetIncompatiblePersistence(storage, prefix, current, stored);
    writePersistenceManifest(prefix, current);
    return {
      reset: false
    };
  }
  if (stored.formatVersion !== current.formatVersion || stored.dataVersion !== current.dataVersion || !isPersistenceManifest(stored)) {
    return resetIncompatiblePersistence(storage, prefix, current, stored);
  }
  const affectedIds = Object.keys(stored.schemaFingerprints).filter(id => current.schemaFingerprints[id] === undefined || current.schemaFingerprints[id] !== stored.schemaFingerprints[id]).sort(_serialize.compareCodepoints);
  const hasCurrentOnlyIds = Object.keys(current.schemaFingerprints).some(id => stored.schemaFingerprints[id] === undefined);
  const manifestChanged = storedResult.migrated || affectedIds.length > 0 || hasCurrentOnlyIds;
  if (affectedIds.length > 0) {
    const epoch = (0, _configure.getApplyRuntime)().currentEpoch();
    for (const modelId of affectedIds) clearModelPersistence(storage, prefix, modelId, epoch);
    (0, _configure.getOperationState)().discardModels(new Set(affectedIds));
    for (const modelId of affectedIds) (0, _diagnostics.noteDataLoss)('schema-migration-reset', modelId, 1);
  }
  if (manifestChanged) writePersistenceManifest(prefix, current);
  return {
    reset: false
  };
};
exports.ensurePersistenceCompatibility = ensurePersistenceCompatibility;
//# sourceMappingURL=schemaManifest.js.map
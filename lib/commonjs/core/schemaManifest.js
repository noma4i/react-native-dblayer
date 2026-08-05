"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.writePersistenceManifest = exports.registerSchemaDeclaration = exports.reconcilePersistence = exports.computeSchemaFingerprints = exports.DB_FORMAT_VERSION = void 0;
var _configure = require("../dsl/configure.js");
var _operationState = require("./planes/operationState.js");
var _reset = require("./reset.js");
var _diagnostics = require("./diagnostics.js");
var _serialize = require("./serialize.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const DB_FORMAT_VERSION = exports.DB_FORMAT_VERSION = 10;
const declarations = new Map();

/** Register one model declaration for the persistence schema fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
const registerSchemaDeclaration = declaration => {
  declarations.set(declaration.id, declaration);
};
exports.registerSchemaDeclaration = registerSchemaDeclaration;
const computeSchemaFingerprints = () => Object.fromEntries([...declarations.entries()].sort(([left], [right]) => (0, _serialize.compareCodepoints)(left, right)).map(([id, declaration]) => [id, (0, _serialize.stableSerialize)(declaration)]));
exports.computeSchemaFingerprints = computeSchemaFingerprints;
const manifestKey = prefix => `${prefix}manifest`;
const committedOnceKeysForReset = (storage, prefix) => {
  const persisted = (0, _operationState.readCommittedOnceKeys)(storage, prefix);
  return {
    keys: [...new Set(persisted.keys)].sort(),
    corruptSources: persisted.corruptSources
  };
};
const isSchemaFingerprints = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && Object.entries(value).every(([id, fingerprint]) => (0, _normalizeHelpers.isNonEmptyString)(id) && (0, _normalizeHelpers.isNonEmptyString)(fingerprint));
const isDataVersion = value => value === null || typeof value === 'string';
const isPersistenceManifest = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && typeof value.formatVersion === 'number' && isSchemaFingerprints(value.schemaFingerprints) && isDataVersion(value.dataVersion);
const readPersistenceManifest = prefix => {
  const raw = (0, _configure.getDbRuntimeConfig)().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  return (0, _persistenceCodec.decodeSupportedPersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isPersistenceManifest) ?? undefined;
};
const writePersistenceManifest = (prefix, manifest) => {
  (0, _configure.getDbRuntimeConfig)().storage.set(manifestKey(prefix), (0, _persistenceCodec.encodePersistence)(manifest));
};
exports.writePersistenceManifest = writePersistenceManifest;
const resetIncompatiblePersistence = (storage, prefix, current, stored) => {
  const committedOnceKeys = committedOnceKeysForReset(storage, prefix);
  // A format/data-version reset wipes the CACHE - the outbox and quarantine ride through verbatim.
  // Hydrate salvages the carried ledger under the new format, entry by entry.
  const carriedOps = storage.get(`${prefix}ops`);
  const carriedQuarantine = storage.get(`${prefix}quarantine`);
  const onceEntry = carriedOps === undefined ? (0, _operationState.committedOnceKeysEntry)(prefix, committedOnceKeys.keys) : undefined;
  (0, _reset.resetRuntimeKeeping)([{
    key: manifestKey(prefix),
    value: (0, _persistenceCodec.encodePersistence)(current)
  }, ...(carriedOps !== undefined ? [{
    key: `${prefix}ops`,
    value: carriedOps
  }] : []), ...(carriedQuarantine !== undefined ? [{
    key: `${prefix}quarantine`,
    value: carriedQuarantine
  }] : []), ...(onceEntry ? [onceEntry] : [])]);
  (0, _configure.getOperationState)().hydrate();
  (0, _diagnostics.noteDataLoss)('corrupt-once-keys', '__operations__', committedOnceKeys.corruptSources);
  (0, _diagnostics.noteManifestReset)();
  (0, _diagnostics.noteDataLoss)(stored !== undefined ? 'data-version-migration-reset' : 'model-corruption-recovery', '__runtime__', 1);
  return {
    reset: true
  };
};
const clearModelPersistence = (storage, prefix, modelId) => {
  const entries = [...storage.keys((0, _serialize.compositeStorageKey)(prefix, 'row', modelId)).map(key => ({
    key,
    value: null
  })), ...storage.keys((0, _serialize.compositeStorageKey)(prefix, 'scope', modelId)).map(key => ({
    key,
    value: null
  })), {
    key: (0, _serialize.compositeStorageKey)(prefix, 'tombstones', modelId),
    value: null
  }];
  for (const entry of entries) storage.set(entry.key, entry.value);
};

/** Reconcile persisted state with the current format and schema before the boot fsck, then persist the current manifest. An unreadable or mismatched manifest wipes the cache; the outbox and quarantine ride through. */
const reconcilePersistence = () => {
  const {
    storage
  } = (0, _configure.getDbRuntimeConfig)();
  const prefix = (0, _configure.getStoragePrefix)();
  const current = {
    formatVersion: DB_FORMAT_VERSION,
    schemaFingerprints: computeSchemaFingerprints(),
    dataVersion: (0, _configure.getPersistenceDataVersion)()
  };
  const interruptedReset = (0, _reset.resumeInterruptedStorageReset)();
  const stored = readPersistenceManifest(prefix);
  const nonempty = storage.keys(prefix).some(key => key !== manifestKey(prefix));
  if (!stored) {
    if (nonempty) return resetIncompatiblePersistence(storage, prefix, current, stored);
    writePersistenceManifest(prefix, current);
    return {
      reset: interruptedReset
    };
  }
  if (stored.formatVersion !== current.formatVersion || stored.dataVersion !== current.dataVersion) {
    return resetIncompatiblePersistence(storage, prefix, current, stored);
  }
  const affectedIds = Object.keys(stored.schemaFingerprints).filter(id => current.schemaFingerprints[id] === undefined || current.schemaFingerprints[id] !== stored.schemaFingerprints[id]).sort(_serialize.compareCodepoints);
  const hasCurrentOnlyIds = Object.keys(current.schemaFingerprints).some(id => stored.schemaFingerprints[id] === undefined);
  const manifestChanged = affectedIds.length > 0 || hasCurrentOnlyIds;
  if (affectedIds.length > 0) {
    // A schema migration wipes the model's CACHE namespaces only. Its pending operations keep
    // their domain input in the ledger, so the user's unsent writes stay retryable across the bump.
    for (const modelId of affectedIds) clearModelPersistence(storage, prefix, modelId);
    for (const modelId of affectedIds) (0, _diagnostics.noteDataLoss)('schema-migration-reset', modelId, 1);
  }
  if (manifestChanged) writePersistenceManifest(prefix, current);
  return {
    reset: interruptedReset
  };
};
exports.reconcilePersistence = reconcilePersistence;
//# sourceMappingURL=schemaManifest.js.map
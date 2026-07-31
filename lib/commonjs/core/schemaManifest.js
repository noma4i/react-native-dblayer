"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.writePersistenceManifest = exports.registerSchemaDeclaration = exports.ensurePersistenceCompatibility = exports.computeSchemaFingerprint = exports.DB_FORMAT_VERSION = void 0;
var _esToolkit = require("es-toolkit");
var _configure = require("../dsl/configure.js");
var _operationState = require("./planes/operationState.js");
var _reset = require("./reset.js");
var _diagnostics = require("./diagnostics.js");
var _serialize = require("./serialize.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const DB_FORMAT_VERSION = exports.DB_FORMAT_VERSION = 7;
const declarations = new Map();

/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
const registerSchemaDeclaration = declaration => {
  declarations.set(declaration.id, declaration);
};
exports.registerSchemaDeclaration = registerSchemaDeclaration;
const computeSchemaFingerprint = () => (0, _serialize.stableSerialize)((0, _esToolkit.sortBy)([...declarations.values()], [declaration => declaration.id]));
exports.computeSchemaFingerprint = computeSchemaFingerprint;
const manifestKey = prefix => `${prefix}manifest`;
const isPersistenceManifest = value => (0, _normalizeHelpers.isRecord)(value) && typeof value.formatVersion === 'number' && typeof value.schemaFingerprint === 'string' && (value.dataVersion === null || typeof value.dataVersion === 'string');
const readPersistenceManifest = prefix => {
  const raw = (0, _configure.getDbRuntimeConfig)().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  return (0, _persistenceCodec.decodeSupportedPersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isPersistenceManifest) ?? undefined;
};
const writePersistenceManifest = (prefix, manifest) => {
  (0, _configure.getDbRuntimeConfig)().storage.set([{
    key: manifestKey(prefix),
    value: (0, _persistenceCodec.encodePersistence)(manifest)
  }]);
};

/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
exports.writePersistenceManifest = writePersistenceManifest;
const ensurePersistenceCompatibility = () => {
  const {
    storage
  } = (0, _configure.getDbRuntimeConfig)();
  const prefix = (0, _configure.getStoragePrefix)();
  const current = {
    formatVersion: DB_FORMAT_VERSION,
    schemaFingerprint: computeSchemaFingerprint(),
    dataVersion: (0, _configure.getPersistenceDataVersion)()
  };
  const stored = readPersistenceManifest(prefix);
  const nonempty = storage.keys(prefix).some(key => key !== manifestKey(prefix));
  const matches = stored?.formatVersion === current.formatVersion && stored.schemaFingerprint === current.schemaFingerprint && stored.dataVersion === current.dataVersion;
  if (!matches && (stored !== undefined || nonempty)) {
    const committedOnceKeys = (0, _operationState.readCommittedOnceKeys)(storage, prefix);
    (0, _reset.resetRuntime)();
    (0, _operationState.writeCommittedOnceKeys)(storage, prefix, committedOnceKeys.keys);
    (0, _configure.getOperationState)().hydrate();
    if (committedOnceKeys.corruptSources > 0) (0, _diagnostics.noteDataLoss)('corrupt-once-keys', '__operations__', committedOnceKeys.corruptSources);
    (0, _diagnostics.noteManifestReset)();
    (0, _diagnostics.noteDataLoss)(stored !== undefined ? 'data-version-migration-reset' : 'model-corruption-recovery', '__runtime__', 1);
    writePersistenceManifest(prefix, current);
    return {
      reset: true
    };
  }
  if (!stored) writePersistenceManifest(prefix, current);
  return {
    reset: false
  };
};
exports.ensurePersistenceCompatibility = ensurePersistenceCompatibility;
//# sourceMappingURL=schemaManifest.js.map
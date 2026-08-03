"use strict";

import { getApplyRuntime, getDbRuntimeConfig, getOperationState, getPersistenceDataVersion, getStoragePrefix } from "../dsl/configure.js";
import { committedOnceKeysEntry, readCommittedOnceKeys } from "./planes/operationState.js";
import { createJournal } from "./apply/journal.js";
import { resetRuntimeForCompatibility, resumeInterruptedStorageReset } from "./reset.js";
import { noteDataLoss, noteManifestReset } from "./diagnostics.js";
import { compareCodepoints, compositeStorageKey, stableSerialize } from "./serialize.js";
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "./persistenceCodec.js";
import { isNonArrayRecord, isNonEmptyString } from "../utils/normalizeHelpers.js";
export const DB_FORMAT_VERSION = 9;
const SINGLE_FINGERPRINT_FORMAT_VERSION = 7;
const declarations = new Map();

/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export const registerSchemaDeclaration = declaration => {
  declarations.set(declaration.id, declaration);
};
export const computeSchemaFingerprints = () => Object.fromEntries([...declarations.entries()].sort(([left], [right]) => compareCodepoints(left, right)).map(([id, declaration]) => [id, stableSerialize(declaration)]));
const manifestKey = prefix => `${prefix}manifest`;
const committedOnceKeysForReset = (storage, prefix) => {
  const persisted = readCommittedOnceKeys(storage, prefix);
  const open = new Map();
  for (const record of createJournal(storage, () => prefix).allRecords()) {
    for (const transition of record.operationTransitions) {
      if (transition.kind === 'begin') {
        open.set(transition.operation.operationId, transition.operation);
        continue;
      }
      const operation = open.get(transition.operationId);
      if (transition.kind === 'close') {
        if (transition.status === 'committed' && operation?.once === true && operation.idempotencyKey) {
          persisted.keys.push(operation.idempotencyKey);
        }
        open.delete(transition.operationId);
        continue;
      }
      open.delete(transition.operationId);
    }
  }
  return {
    keys: [...new Set(persisted.keys)].sort(),
    corruptSources: persisted.corruptSources
  };
};
const isSchemaFingerprints = value => isNonArrayRecord(value) && Object.entries(value).every(([id, fingerprint]) => isNonEmptyString(id) && isNonEmptyString(fingerprint));
const isDataVersion = value => value === null || typeof value === 'string';
const isPersistenceManifest = value => isNonArrayRecord(value) && typeof value.formatVersion === 'number' && isSchemaFingerprints(value.schemaFingerprints) && isDataVersion(value.dataVersion);
const isSingleFingerprintPersistenceManifest = value => isNonArrayRecord(value) && typeof value.formatVersion === 'number' && typeof value.schemaFingerprint === 'string' && isDataVersion(value.dataVersion);
const isPersistenceManifestRecord = value => isPersistenceManifest(value) || isSingleFingerprintPersistenceManifest(value);
const convertSingleFingerprint = schemaFingerprint => {
  try {
    const parsed = JSON.parse(schemaFingerprint);
    if (!Array.isArray(parsed)) return undefined;
    const entries = [];
    const ids = new Set();
    for (const value of parsed) {
      if (!isNonArrayRecord(value) || !isNonEmptyString(value.id) || ids.has(value.id)) return undefined;
      ids.add(value.id);
      entries.push([value.id, value]);
    }
    return Object.fromEntries(entries.sort(([left], [right]) => compareCodepoints(left, right)).map(([id, declaration]) => [id, stableSerialize(declaration)]));
  } catch {
    return undefined;
  }
};
const readPersistenceManifest = prefix => {
  const raw = getDbRuntimeConfig().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  const manifest = decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isPersistenceManifestRecord);
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
export const writePersistenceManifest = (prefix, manifest) => {
  getDbRuntimeConfig().storage.set(manifestKey(prefix), encodePersistence(manifest));
};
const resetIncompatiblePersistence = (storage, prefix, current, stored) => {
  const committedOnceKeys = committedOnceKeysForReset(storage, prefix);
  const onceEntry = committedOnceKeysEntry(prefix, committedOnceKeys.keys);
  resetRuntimeForCompatibility([{
    key: manifestKey(prefix),
    value: encodePersistence(current)
  }, ...(onceEntry ? [onceEntry] : [])]);
  getOperationState().hydrate();
  noteDataLoss('corrupt-once-keys', '__operations__', committedOnceKeys.corruptSources);
  noteManifestReset();
  noteDataLoss(stored !== undefined ? 'data-version-migration-reset' : 'model-corruption-recovery', '__runtime__', 1);
  return {
    reset: true
  };
};
const clearModelPersistence = (storage, prefix, modelId, epoch) => {
  const entries = [...storage.keys(compositeStorageKey(prefix, 'row', modelId)).map(key => ({
    key,
    value: null
  })), ...storage.keys(compositeStorageKey(prefix, 'scope', modelId)).map(key => ({
    key,
    value: null
  })), {
    key: compositeStorageKey(prefix, 'tombstones', modelId),
    value: null
  }, {
    key: `${prefix}applied:${modelId}`,
    value: encodePersistence(epoch)
  }];
  for (const entry of entries) storage.set(entry.key, entry.value);
};

/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
export const ensurePersistenceCompatibility = () => {
  const {
    storage
  } = getDbRuntimeConfig();
  const prefix = getStoragePrefix();
  const current = {
    formatVersion: DB_FORMAT_VERSION,
    schemaFingerprints: computeSchemaFingerprints(),
    dataVersion: getPersistenceDataVersion()
  };
  const interruptedReset = resumeInterruptedStorageReset();
  const storedResult = readPersistenceManifest(prefix);
  const stored = storedResult?.manifest;
  const nonempty = storage.keys(prefix).some(key => key !== manifestKey(prefix));
  if (!stored) {
    if (nonempty) return resetIncompatiblePersistence(storage, prefix, current, stored);
    writePersistenceManifest(prefix, current);
    return {
      reset: interruptedReset
    };
  }
  if (stored.formatVersion !== current.formatVersion || stored.dataVersion !== current.dataVersion || !isPersistenceManifest(stored)) {
    return resetIncompatiblePersistence(storage, prefix, current, stored);
  }
  const affectedIds = Object.keys(stored.schemaFingerprints).filter(id => current.schemaFingerprints[id] === undefined || current.schemaFingerprints[id] !== stored.schemaFingerprints[id]).sort(compareCodepoints);
  const hasCurrentOnlyIds = Object.keys(current.schemaFingerprints).some(id => stored.schemaFingerprints[id] === undefined);
  const manifestChanged = storedResult.migrated || affectedIds.length > 0 || hasCurrentOnlyIds;
  if (affectedIds.length > 0) {
    const epoch = getApplyRuntime().currentEpoch();
    for (const modelId of affectedIds) clearModelPersistence(storage, prefix, modelId, epoch);
    getOperationState().discardModels(new Set(affectedIds));
    for (const modelId of affectedIds) noteDataLoss('schema-migration-reset', modelId, 1);
  }
  if (manifestChanged) writePersistenceManifest(prefix, current);
  return {
    reset: interruptedReset
  };
};
//# sourceMappingURL=schemaManifest.js.map
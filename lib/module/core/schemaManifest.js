"use strict";

import { getDbRuntimeConfig, getOperationState, getPersistenceDataVersion, getStoragePrefix } from "../dsl/configure.js";
import { committedOnceKeysEntry, readCommittedOnceKeys } from "./planes/operationState.js";
import { registerCurrentManifestEntryProvider, resetRuntimeKeeping, resumeInterruptedStorageReset } from "./reset.js";
import { noteDataLoss, noteManifestReset } from "./diagnostics.js";
import { compareCodepoints, compositeStorageKey, stableSerialize } from "./serialize.js";
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "./persistenceCodec.js";
import { isNonArrayRecord, isNonEmptyString } from "../utils/normalizeHelpers.js";
export const DB_FORMAT_VERSION = 11;
const declarations = new Map();

/** Register one model declaration for the persistence schema fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export const registerSchemaDeclaration = declaration => {
  declarations.set(declaration.id, declaration);
};
export const computeSchemaFingerprints = () => Object.fromEntries([...declarations.entries()].sort(([left], [right]) => compareCodepoints(left, right)).map(([id, declaration]) => [id, stableSerialize(declaration)]));
const manifestKey = prefix => `${prefix}manifest`;
const currentPersistenceManifest = () => ({
  formatVersion: DB_FORMAT_VERSION,
  schemaFingerprints: computeSchemaFingerprints(),
  dataVersion: getPersistenceDataVersion()
});

// Every sanctioned wipe restores the current manifest in the same reset intent (spec 04): a
// nonempty namespace of a configured runtime always carries the manifest of its configuration.
registerCurrentManifestEntryProvider(() => ({
  key: manifestKey(getStoragePrefix()),
  value: encodePersistence(currentPersistenceManifest())
}));
const committedOnceKeysForReset = (storage, prefix) => {
  const persisted = readCommittedOnceKeys(storage, prefix);
  return {
    keys: [...new Set(persisted.keys)].sort(),
    corruptSources: persisted.corruptSources
  };
};
const isSchemaFingerprints = value => isNonArrayRecord(value) && Object.entries(value).every(([id, fingerprint]) => isNonEmptyString(id) && isNonEmptyString(fingerprint));
const isDataVersion = value => value === null || typeof value === 'string';
const isPersistenceManifest = value => isNonArrayRecord(value) && typeof value.formatVersion === 'number' && isSchemaFingerprints(value.schemaFingerprints) && isDataVersion(value.dataVersion);
const readPersistenceManifest = prefix => {
  const raw = getDbRuntimeConfig().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  return decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isPersistenceManifest) ?? undefined;
};
export const writePersistenceManifest = (prefix, manifest) => {
  getDbRuntimeConfig().storage.set(manifestKey(prefix), encodePersistence(manifest));
};
const resetIncompatiblePersistence = (storage, prefix, current, stored) => {
  const committedOnceKeys = committedOnceKeysForReset(storage, prefix);
  // A format/data-version reset wipes the CACHE - the outbox and quarantine ride through verbatim.
  // Hydrate salvages the carried ledger under the new format, entry by entry.
  const carriedOps = storage.get(`${prefix}ops`);
  const carriedQuarantine = storage.get(`${prefix}quarantine`);
  const onceEntry = carriedOps === undefined ? committedOnceKeysEntry(prefix, committedOnceKeys.keys) : undefined;
  resetRuntimeKeeping([{
    key: manifestKey(prefix),
    value: encodePersistence(current)
  }, ...(carriedOps !== undefined ? [{
    key: `${prefix}ops`,
    value: carriedOps
  }] : []), ...(carriedQuarantine !== undefined ? [{
    key: `${prefix}quarantine`,
    value: carriedQuarantine
  }] : []), ...(onceEntry ? [onceEntry] : [])]);
  getOperationState().hydrate();
  noteDataLoss('corrupt-once-keys', '__operations__', committedOnceKeys.corruptSources);
  noteManifestReset();
  noteDataLoss(stored !== undefined ? 'data-version-migration-reset' : 'model-corruption-recovery', '__runtime__', 1);
  return {
    reset: true
  };
};
const clearModelPersistence = (storage, prefix, modelId) => {
  const entries = [...storage.keys(compositeStorageKey(prefix, 'row', modelId)).map(key => ({
    key,
    value: null
  })), ...storage.keys(compositeStorageKey(prefix, 'scope', modelId)).map(key => ({
    key,
    value: null
  })), {
    key: compositeStorageKey(prefix, 'tombstones', modelId),
    value: null
  }];
  for (const entry of entries) storage.set(entry.key, entry.value);
};

/** Reconcile persisted state with the current format and schema before the boot fsck, then persist the current manifest. An unreadable or mismatched manifest wipes the cache; the outbox and quarantine ride through. */
export const reconcilePersistence = () => {
  const {
    storage
  } = getDbRuntimeConfig();
  const prefix = getStoragePrefix();
  const current = currentPersistenceManifest();
  const interruptedReset = resumeInterruptedStorageReset();
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
  const affectedIds = Object.keys(stored.schemaFingerprints).filter(id => current.schemaFingerprints[id] === undefined || current.schemaFingerprints[id] !== stored.schemaFingerprints[id]).sort(compareCodepoints);
  const hasCurrentOnlyIds = Object.keys(current.schemaFingerprints).some(id => stored.schemaFingerprints[id] === undefined);
  const manifestChanged = affectedIds.length > 0 || hasCurrentOnlyIds;
  if (affectedIds.length > 0) {
    // A schema migration wipes the model's CACHE namespaces only. Its pending operations keep
    // their domain input in the ledger, so the user's unsent writes stay retryable across the bump.
    for (const modelId of affectedIds) clearModelPersistence(storage, prefix, modelId);
    // Deltas are multi-model and unreadable per-model here: they go as cache eviction with the
    // same migration event; commits of clean models not yet compacted return by ordinary freshness.
    for (const key of storage.keys(`${prefix}delta:`)) storage.set(key, null);
    for (const modelId of affectedIds) storage.set(`${prefix}snapseq:${modelId}`, null);
    for (const modelId of affectedIds) noteDataLoss('schema-migration-reset', modelId, 1);
  }
  if (manifestChanged) writePersistenceManifest(prefix, current);
  return {
    reset: interruptedReset
  };
};
//# sourceMappingURL=schemaManifest.js.map
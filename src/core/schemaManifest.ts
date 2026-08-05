import { getDbRuntimeConfig, getOperationState, getPersistenceDataVersion, getStoragePrefix } from '../dsl/configure';
import { committedOnceKeysEntry, readCommittedOnceKeys } from './planes/operationState';
import { resetRuntimeKeeping, resumeInterruptedStorageReset } from './reset';
import { noteDataLoss, noteManifestReset } from './diagnostics';
import { compareCodepoints, compositeStorageKey, stableSerialize } from './serialize';
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from './persistenceCodec';
import { isNonArrayRecord, isNonEmptyString } from '../utils/normalizeHelpers';
import type { PersistenceManifest, SchemaDeclaration, SchemaFingerprints } from '../types';

export const DB_FORMAT_VERSION = 10;

const declarations = new Map<string, SchemaDeclaration>();

/** Register one model declaration for the persistence schema fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export const registerSchemaDeclaration = (declaration: SchemaDeclaration): void => {
  declarations.set(declaration.id, declaration);
};

export const computeSchemaFingerprints = (): SchemaFingerprints =>
  Object.fromEntries([...declarations.entries()].sort(([left], [right]) => compareCodepoints(left, right)).map(([id, declaration]) => [id, stableSerialize(declaration)]));

const manifestKey = (prefix: string): string => `${prefix}manifest`;

const committedOnceKeysForReset = (storage: ReturnType<typeof getDbRuntimeConfig>['storage'], prefix: string) => {
  const persisted = readCommittedOnceKeys(storage, prefix);
  return { keys: [...new Set(persisted.keys)].sort(), corruptSources: persisted.corruptSources };
};

const isSchemaFingerprints = (value: unknown): value is SchemaFingerprints =>
  isNonArrayRecord(value) && Object.entries(value).every(([id, fingerprint]) => isNonEmptyString(id) && isNonEmptyString(fingerprint));

const isDataVersion = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isPersistenceManifest = (value: unknown): value is PersistenceManifest =>
  isNonArrayRecord(value) && typeof value.formatVersion === 'number' && isSchemaFingerprints(value.schemaFingerprints) && isDataVersion(value.dataVersion);

const readPersistenceManifest = (prefix: string): PersistenceManifest | undefined => {
  const raw = getDbRuntimeConfig().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  return decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isPersistenceManifest) ?? undefined;
};

export const writePersistenceManifest = (prefix: string, manifest: PersistenceManifest): void => {
  getDbRuntimeConfig().storage.set(manifestKey(prefix), encodePersistence(manifest));
};

const resetIncompatiblePersistence = (
  storage: ReturnType<typeof getDbRuntimeConfig>['storage'],
  prefix: string,
  current: PersistenceManifest,
  stored: PersistenceManifest | undefined
): { reset: true } => {
  const committedOnceKeys = committedOnceKeysForReset(storage, prefix);
  // A format/data-version reset wipes the CACHE - the outbox and quarantine ride through verbatim.
  // Hydrate salvages the carried ledger under the new format, entry by entry.
  const carriedOps = storage.get(`${prefix}ops`);
  const carriedQuarantine = storage.get(`${prefix}quarantine`);
  const onceEntry = carriedOps === undefined ? committedOnceKeysEntry(prefix, committedOnceKeys.keys) : undefined;
  resetRuntimeKeeping([
    { key: manifestKey(prefix), value: encodePersistence(current) },
    ...(carriedOps !== undefined ? [{ key: `${prefix}ops`, value: carriedOps }] : []),
    ...(carriedQuarantine !== undefined ? [{ key: `${prefix}quarantine`, value: carriedQuarantine }] : []),
    ...(onceEntry ? [onceEntry] : [])
  ]);
  getOperationState().hydrate();
  noteDataLoss('corrupt-once-keys', '__operations__', committedOnceKeys.corruptSources);
  noteManifestReset();
  noteDataLoss(stored !== undefined ? 'data-version-migration-reset' : 'model-corruption-recovery', '__runtime__', 1);
  return { reset: true };
};

const clearModelPersistence = (storage: ReturnType<typeof getDbRuntimeConfig>['storage'], prefix: string, modelId: string): void => {
  const entries = [
    ...storage.keys(compositeStorageKey(prefix, 'row', modelId)).map(key => ({ key, value: null })),
    ...storage.keys(compositeStorageKey(prefix, 'scope', modelId)).map(key => ({ key, value: null })),
    { key: compositeStorageKey(prefix, 'tombstones', modelId), value: null }
  ];
  for (const entry of entries) storage.set(entry.key, entry.value);
};

/** Reconcile persisted state with the current format and schema before the boot fsck, then persist the current manifest. An unreadable or mismatched manifest wipes the cache; the outbox and quarantine ride through. */
export const reconcilePersistence = (): { reset: boolean } => {
  const { storage } = getDbRuntimeConfig();
  const prefix = getStoragePrefix();
  const current: PersistenceManifest = { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: getPersistenceDataVersion() };
  const interruptedReset = resumeInterruptedStorageReset();
  const stored = readPersistenceManifest(prefix);
  const nonempty = storage.keys(prefix).some(key => key !== manifestKey(prefix));

  if (!stored) {
    if (nonempty) return resetIncompatiblePersistence(storage, prefix, current, stored);
    writePersistenceManifest(prefix, current);
    return { reset: interruptedReset };
  }

  if (stored.formatVersion !== current.formatVersion || stored.dataVersion !== current.dataVersion) {
    return resetIncompatiblePersistence(storage, prefix, current, stored);
  }

  const affectedIds = Object.keys(stored.schemaFingerprints)
    .filter(id => current.schemaFingerprints[id] === undefined || current.schemaFingerprints[id] !== stored.schemaFingerprints[id])
    .sort(compareCodepoints);
  const hasCurrentOnlyIds = Object.keys(current.schemaFingerprints).some(id => stored.schemaFingerprints[id] === undefined);
  const manifestChanged = affectedIds.length > 0 || hasCurrentOnlyIds;

  if (affectedIds.length > 0) {
    // A schema migration wipes the model's CACHE namespaces only. Its pending operations keep
    // their domain input in the ledger, so the user's unsent writes stay retryable across the bump.
    for (const modelId of affectedIds) clearModelPersistence(storage, prefix, modelId);
    for (const modelId of affectedIds) noteDataLoss('schema-migration-reset', modelId, 1);
  }

  if (manifestChanged) writePersistenceManifest(prefix, current);
  return { reset: interruptedReset };
};

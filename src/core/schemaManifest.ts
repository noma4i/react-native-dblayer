import { sortBy } from 'es-toolkit';
import { getDbRuntimeConfig, getOperationState, getPersistenceDataVersion, getStoragePrefix } from '../dsl/configure';
import { readCommittedOnceKeys, writeCommittedOnceKeys } from './planes/operationState';
import { resetRuntime } from './reset';
import { noteDataLoss, noteManifestReset } from './diagnostics';
import { stableSerialize } from './serialize';
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from './persistenceCodec';
import { isRecord } from '../utils/normalizeHelpers';

export const DB_FORMAT_VERSION = 7;

import type { PersistenceManifest, SchemaDeclaration } from '../types';
const declarations = new Map<string, SchemaDeclaration>();

/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export const registerSchemaDeclaration = (declaration: SchemaDeclaration): void => {
  declarations.set(declaration.id, declaration);
};

export const computeSchemaFingerprint = (): string => stableSerialize(sortBy([...declarations.values()], [declaration => declaration.id]));

const manifestKey = (prefix: string): string => `${prefix}manifest`;

const isPersistenceManifest = (value: unknown): value is PersistenceManifest =>
  isRecord(value) &&
  typeof value.formatVersion === 'number' &&
  typeof value.schemaFingerprint === 'string' &&
  (value.dataVersion === null || typeof value.dataVersion === 'string');

const readPersistenceManifest = (prefix: string): PersistenceManifest | undefined => {
  const raw = getDbRuntimeConfig().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  return decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isPersistenceManifest) ?? undefined;
};

export const writePersistenceManifest = (prefix: string, manifest: PersistenceManifest): void => {
  getDbRuntimeConfig().storage.set([{ key: manifestKey(prefix), value: encodePersistence(manifest) }]);
};

/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
export const ensurePersistenceCompatibility = (): { reset: boolean } => {
  const { storage } = getDbRuntimeConfig();
  const prefix = getStoragePrefix();
  const current = { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: getPersistenceDataVersion() };
  const stored = readPersistenceManifest(prefix);
  const nonempty = storage.keys(prefix).some(key => key !== manifestKey(prefix));
  const matches = stored?.formatVersion === current.formatVersion && stored.schemaFingerprint === current.schemaFingerprint && stored.dataVersion === current.dataVersion;

  if (!matches && (stored !== undefined || nonempty)) {
    const committedOnceKeys = readCommittedOnceKeys(storage, prefix);
    resetRuntime();
    writeCommittedOnceKeys(storage, prefix, committedOnceKeys.keys);
    getOperationState().hydrate();
    noteDataLoss('corrupt-once-keys', '__operations__', committedOnceKeys.corruptSources);
    noteManifestReset();
    noteDataLoss(stored !== undefined ? 'data-version-migration-reset' : 'model-corruption-recovery', '__runtime__', 1);
    writePersistenceManifest(prefix, current);
    return { reset: true };
  }

  if (!stored) writePersistenceManifest(prefix, current);
  return { reset: false };
};

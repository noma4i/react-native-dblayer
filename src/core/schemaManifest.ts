import { sortBy } from 'es-toolkit';
import { getDbRuntimeConfig, getPersistenceDataVersion, getStoragePrefix } from '../dsl/configure';
import { resetRuntime } from './reset';
import { noteManifestReset } from './diagnostics';
import { stableSerialize } from './serialize';

export const DB_FORMAT_VERSION = 2;

type FieldDeclaration = { kind: string; mode: string; hasDefault: boolean };
type ScopeDeclaration = { by: Record<string, string> | null; sort: string };
export type SchemaDeclaration = { id: string; name: string; fields: Record<string, FieldDeclaration>; scopes: Record<string, ScopeDeclaration> };
type PersistenceManifest = { formatVersion: number; schemaFingerprint: string; dataVersion: string | null };

const declarations = new Map<string, SchemaDeclaration>();

/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export const registerSchemaDeclaration = (declaration: SchemaDeclaration): void => {
  declarations.set(declaration.id, declaration);
};

export const computeSchemaFingerprint = (): string => stableSerialize(sortBy([...declarations.values()], [declaration => declaration.id]));

const manifestKey = (prefix: string): string => `${prefix}manifest`;

export const readPersistenceManifest = (prefix: string): PersistenceManifest | undefined => {
  const raw = getDbRuntimeConfig().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as PersistenceManifest).formatVersion !== 'number' ||
      typeof (parsed as PersistenceManifest).schemaFingerprint !== 'string' ||
      ((parsed as PersistenceManifest).dataVersion !== null && typeof (parsed as PersistenceManifest).dataVersion !== 'string')
    ) {
      return undefined;
    }
    return parsed as PersistenceManifest;
  } catch {
    return undefined;
  }
};

export const writePersistenceManifest = (prefix: string, manifest: PersistenceManifest): void => {
  getDbRuntimeConfig().storage.set([{ key: manifestKey(prefix), value: stableSerialize(manifest) }]);
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
    resetRuntime();
    noteManifestReset();
    writePersistenceManifest(prefix, current);
    return { reset: true };
  }

  if (!stored) writePersistenceManifest(prefix, current);
  return { reset: false };
};

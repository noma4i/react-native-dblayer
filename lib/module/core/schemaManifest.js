"use strict";

import { getDbRuntimeConfig, getPersistenceDataVersion, getStoragePrefix } from "../dsl/configure.js";
import { resetRuntime } from "./reset.js";
import { noteManifestReset } from "./diagnostics.js";
import { stableSerialize } from "./serialize.js";
export const DB_FORMAT_VERSION = 2;
const declarations = new Map();

/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export const registerSchemaDeclaration = declaration => {
  declarations.set(declaration.id, declaration);
};
export const computeSchemaFingerprint = () => stableSerialize([...declarations.values()].sort((left, right) => left.id.localeCompare(right.id)));
const manifestKey = prefix => `${prefix}manifest`;
export const readPersistenceManifest = prefix => {
  const raw = getDbRuntimeConfig().storage.get(manifestKey(prefix));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.formatVersion !== 'number' || typeof parsed.schemaFingerprint !== 'string' || parsed.dataVersion !== null && typeof parsed.dataVersion !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};
export const writePersistenceManifest = (prefix, manifest) => {
  getDbRuntimeConfig().storage.set([{
    key: manifestKey(prefix),
    value: stableSerialize(manifest)
  }]);
};

/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
export const ensurePersistenceCompatibility = () => {
  const {
    storage
  } = getDbRuntimeConfig();
  const prefix = getStoragePrefix();
  const current = {
    formatVersion: DB_FORMAT_VERSION,
    schemaFingerprint: computeSchemaFingerprint(),
    dataVersion: getPersistenceDataVersion()
  };
  const stored = readPersistenceManifest(prefix);
  const nonempty = storage.keys(prefix).some(key => key !== manifestKey(prefix));
  const matches = stored?.formatVersion === current.formatVersion && stored.schemaFingerprint === current.schemaFingerprint && stored.dataVersion === current.dataVersion;
  if (!matches && (stored !== undefined || nonempty)) {
    resetRuntime();
    noteManifestReset();
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
//# sourceMappingURL=schemaManifest.js.map
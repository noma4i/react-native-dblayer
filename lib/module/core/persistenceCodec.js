"use strict";

import { stableSerialize } from "./serialize.js";
export const PERSISTENCE_SCHEMA_VERSION = 1;
const checksumOf = value => {
  const source = stableSerialize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/** Wrap a nested value with the schema version covered by its enclosing checksum. */
export const versionPersistenceValue = (payload, schemaVersion = PERSISTENCE_SCHEMA_VERSION) => ({
  schemaVersion,
  payload
});

/** Encode one JSON-safe payload with a canonical checksum. */
export const encodePersistence = (payload, schemaVersion = PERSISTENCE_SCHEMA_VERSION) => {
  const serializedPayload = JSON.stringify(payload);
  if (serializedPayload === undefined) throw new Error('Persistence payload is not JSON serializable');
  const jsonPayload = JSON.parse(serializedPayload);
  const content = {
    schemaVersion,
    payload: jsonPayload
  };
  const envelope = {
    ...content,
    checksum: checksumOf(content)
  };
  return JSON.stringify(envelope);
};

/** Decode and verify one persisted payload without weakening unknown-version handling into corruption. */
export const decodePersistence = (raw, expectedSchemaVersion, accepts) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: 'corrupt'
    };
  }
  if (typeof parsed !== 'object' || parsed === null) return {
    kind: 'corrupt'
  };
  const envelope = parsed;
  if (typeof envelope.schemaVersion !== 'number') return {
    kind: 'corrupt'
  };
  if (envelope.schemaVersion !== expectedSchemaVersion) return {
    kind: 'unsupported',
    schemaVersion: envelope.schemaVersion
  };
  if (typeof envelope.checksum !== 'string' || !accepts(envelope.payload)) return {
    kind: 'corrupt'
  };
  const checksum = checksumOf({
    schemaVersion: envelope.schemaVersion,
    payload: envelope.payload
  });
  return checksum === envelope.checksum ? {
    kind: 'ok',
    value: envelope.payload
  } : {
    kind: 'corrupt'
  };
};

/** Decode one payload, returning null only for localized corruption and throwing on unknown versions. */
export const decodeSupportedPersistence = (raw, expectedSchemaVersion, accepts) => {
  const decoded = decodePersistence(raw, expectedSchemaVersion, accepts);
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  return decoded.kind === 'ok' ? decoded.value : null;
};
//# sourceMappingURL=persistenceCodec.js.map
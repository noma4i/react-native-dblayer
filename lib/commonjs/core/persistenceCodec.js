"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.versionPersistenceValue = exports.jsonRoundTrip = exports.encodePersistence = exports.decodeSupportedPersistence = exports.decodePersistence = exports.PERSISTENCE_SCHEMA_VERSION = void 0;
var _serialize = require("./serialize.js");
const PERSISTENCE_SCHEMA_VERSION = exports.PERSISTENCE_SCHEMA_VERSION = 1;
const checksumOf = value => {
  const source = (0, _serialize.stableSerialize)(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/** Wrap a nested value with the schema version covered by its enclosing checksum. */
const versionPersistenceValue = (payload, schemaVersion = PERSISTENCE_SCHEMA_VERSION) => ({
  schemaVersion,
  payload
});

/** Validate and clone one value without any JSON coercion, omission, or prototype conversion. */
exports.versionPersistenceValue = versionPersistenceValue;
const jsonRoundTrip = input => {
  const ancestors = new Set();
  const isJsonValue = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype) return false;
    ancestors.add(value);
    let valid = true;
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value).filter(key => key !== 'length');
      valid = ownKeys.length === value.length && ownKeys.every((key, index) => key === String(index)) && value.every((entry, index) => Object.hasOwn(value, index) && isJsonValue(entry));
    } else {
      valid = Reflect.ownKeys(value).every(key => {
        if (typeof key !== 'string') return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable === true && 'value' in descriptor && isJsonValue(descriptor.value);
      });
    }
    ancestors.delete(value);
    return valid;
  };
  if (!isJsonValue(input)) return {
    serializable: false,
    value: undefined
  };
  try {
    return {
      serializable: true,
      value: JSON.parse(JSON.stringify(input))
    };
  } catch {
    return {
      serializable: false,
      value: undefined
    };
  }
};

/** Encode one JSON-safe payload with a canonical checksum. */
exports.jsonRoundTrip = jsonRoundTrip;
const encodePersistence = (payload, schemaVersion = PERSISTENCE_SCHEMA_VERSION) => {
  const roundTrip = jsonRoundTrip(payload);
  if (!roundTrip.serializable) throw new Error('Persistence payload is not JSON serializable');
  const content = {
    schemaVersion,
    payload: roundTrip.value
  };
  const envelope = {
    ...content,
    checksum: checksumOf(content)
  };
  return JSON.stringify(envelope);
};

/** Decode and verify one persisted payload without weakening unknown-version handling into corruption. */
exports.encodePersistence = encodePersistence;
const decodePersistence = (raw, expectedSchemaVersion, accepts) => {
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
exports.decodePersistence = decodePersistence;
const decodeSupportedPersistence = (raw, expectedSchemaVersion, accepts) => {
  const decoded = decodePersistence(raw, expectedSchemaVersion, accepts);
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  return decoded.kind === 'ok' ? decoded.value : null;
};
exports.decodeSupportedPersistence = decodeSupportedPersistence;
//# sourceMappingURL=persistenceCodec.js.map
import type { PersistenceDecodeResult, VersionedValue } from '../types';
export declare const PERSISTENCE_SCHEMA_VERSION = 1;
/** Wrap a nested value with the schema version covered by its enclosing checksum. */
export declare const versionPersistenceValue: <T>(payload: T, schemaVersion?: number) => VersionedValue<T>;
/** Encode one JSON-safe payload with a canonical checksum. */
export declare const encodePersistence: <T>(payload: T, schemaVersion?: number) => string;
/** Decode and verify one persisted payload without weakening unknown-version handling into corruption. */
export declare const decodePersistence: <T>(raw: string, expectedSchemaVersion: number, accepts: (value: unknown) => value is T) => PersistenceDecodeResult<T>;
/** Decode one payload, returning null only for localized corruption and throwing on unknown versions. */
export declare const decodeSupportedPersistence: <T>(raw: string, expectedSchemaVersion: number, accepts: (value: unknown) => value is T) => T | null;
//# sourceMappingURL=persistenceCodec.d.ts.map
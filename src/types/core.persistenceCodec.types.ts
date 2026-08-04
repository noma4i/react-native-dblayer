/** Versioned payload plus a checksum over its canonical serialized representation. */
export type PersistenceEnvelope<T> = {
  schemaVersion: number;
  checksum: string;
  payload: T;
};

/** Version marker for nested values covered by an enclosing checksum. */
export type VersionedValue<T> = {
  schemaVersion: number;
  payload: T;
};

export type PersistenceDecodeResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'corrupt' }
  | { kind: 'unsupported'; schemaVersion: number };

/** Versioned-record decode: a record version mismatch is routine evolution (stale drop), never corruption. */
export type VersionedRecordDecodeResult<T> = PersistenceDecodeResult<T> | { kind: 'stale-version'; recordVersion: number };

/** Lossless JSON validation and detached round-trip result. */
export type JsonRoundTripResult<T> = { serializable: true; value: T } | { serializable: false; value: undefined };

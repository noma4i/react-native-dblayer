'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.toStr =
  exports.readString =
  exports.readNumber =
  exports.readNullableString =
  exports.readNullableNumber =
  exports.readId =
  exports.readBoolean =
  exports.isRecord =
  exports.isNonArrayRecord =
    void 0;
/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
const isRecord = value => typeof value === 'object' && value !== null;

/** Narrow a value to a non-null, non-array record. */
exports.isRecord = isRecord;
const isNonArrayRecord = value => isRecord(value) && !Array.isArray(value);

/**
 * Convert a value to string via `String(v)` while preserving explicit `null`/`undefined` as-is (they are
 * not stringified to `"null"`/`"undefined"`). Note this does not filter empty strings - `toStr('')` is `''`.
 *
 * @param v Value to stringify.
 * @returns `String(v)`, or `v` unchanged when it is `null`/`undefined`.
 */
exports.isNonArrayRecord = isNonArrayRecord;
const toStr = v => (v != null ? String(v) : v);

/** Read a string or return undefined for missing or malformed values. */
exports.toStr = toStr;
const readString = value => (typeof value === 'string' ? value : undefined);

/** Read a string while preserving explicit null writes. */
exports.readString = readString;
const readNullableString = value => {
  if (value === null) return null;
  return readString(value);
};

/** Read a number or return undefined for missing or malformed values. */
exports.readNullableString = readNullableString;
const readNumber = value => (typeof value === 'number' ? value : undefined);

/** Read a number while preserving explicit null writes. */
exports.readNumber = readNumber;
const readNullableNumber = value => {
  if (value === null) return null;
  return readNumber(value);
};

/** Read a boolean or return undefined for missing or malformed values. */
exports.readNullableNumber = readNullableNumber;
const readBoolean = value => (typeof value === 'boolean' ? value : undefined);

/** Read an id as a string; non-empty string/number pass through, anything else (empty string/boolean/object/array/null/undefined) returns undefined. */
exports.readBoolean = readBoolean;
const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return id === '' ? undefined : id;
};
exports.readId = readId;
//# sourceMappingURL=normalizeHelpers.js.map

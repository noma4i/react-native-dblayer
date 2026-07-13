"use strict";

/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export const isRecord = value => typeof value === 'object' && value !== null;

/** Narrow a value to a non-null, non-array record. */
export const isNonArrayRecord = value => isRecord(value) && !Array.isArray(value);

/** Convert a value to string while preserving null and undefined. */
export const toStr = v => v != null ? String(v) : v;

/** Read a string or return undefined for missing or malformed values. */
export const readString = value => typeof value === 'string' ? value : undefined;

/** Read a string while preserving explicit null writes. */
export const readNullableString = value => {
  if (value === null) return null;
  return readString(value);
};

/** Read a number or return undefined for missing or malformed values. */
export const readNumber = value => typeof value === 'number' ? value : undefined;

/** Read a number while preserving explicit null writes. */
export const readNullableNumber = value => {
  if (value === null) return null;
  return readNumber(value);
};

/** Read a boolean or return undefined for missing or malformed values. */
export const readBoolean = value => typeof value === 'boolean' ? value : undefined;

/** Read an id as a string; non-empty string/number pass through, anything else (empty string/boolean/object/array/null/undefined) returns undefined. */
export const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return id === '' ? undefined : id;
};
//# sourceMappingURL=normalizeHelpers.js.map
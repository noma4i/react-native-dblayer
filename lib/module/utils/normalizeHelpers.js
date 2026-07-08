"use strict";

/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export const isRecord = value => typeof value === 'object' && value !== null;

/** Convert a value to string while preserving null and undefined. */
export const toStr = v => v != null ? String(v) : v;

/** Convert a value to a required string. */
export const toRequiredStr = value => String(value);

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

/** Read an id as a string; string/number pass through, anything else (boolean/object/array/null/undefined) returns undefined. */
export const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return toStr(value) ?? undefined;
};
//# sourceMappingURL=normalizeHelpers.js.map
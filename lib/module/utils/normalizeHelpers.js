"use strict";

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

/** Read an id as a string or return undefined. */
export const readId = value => toStr(value) ?? undefined;
//# sourceMappingURL=normalizeHelpers.js.map
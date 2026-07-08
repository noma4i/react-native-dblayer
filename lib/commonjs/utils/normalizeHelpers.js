"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.toStr = exports.toRequiredStr = exports.readString = exports.readNumber = exports.readNullableString = exports.readNullableNumber = exports.readId = exports.readBoolean = exports.isRecord = void 0;
/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
const isRecord = value => typeof value === 'object' && value !== null;

/** Convert a value to string while preserving null and undefined. */
exports.isRecord = isRecord;
const toStr = v => v != null ? String(v) : v;

/** Convert a value to a required string. */
exports.toStr = toStr;
const toRequiredStr = value => String(value);

/** Read a string or return undefined for missing or malformed values. */
exports.toRequiredStr = toRequiredStr;
const readString = value => typeof value === 'string' ? value : undefined;

/** Read a string while preserving explicit null writes. */
exports.readString = readString;
const readNullableString = value => {
  if (value === null) return null;
  return readString(value);
};

/** Read a number or return undefined for missing or malformed values. */
exports.readNullableString = readNullableString;
const readNumber = value => typeof value === 'number' ? value : undefined;

/** Read a number while preserving explicit null writes. */
exports.readNumber = readNumber;
const readNullableNumber = value => {
  if (value === null) return null;
  return readNumber(value);
};

/** Read a boolean or return undefined for missing or malformed values. */
exports.readNullableNumber = readNullableNumber;
const readBoolean = value => typeof value === 'boolean' ? value : undefined;

/** Read an id as a string; string/number pass through, anything else (boolean/object/array/null/undefined) returns undefined. */
exports.readBoolean = readBoolean;
const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return toStr(value) ?? undefined;
};
exports.readId = readId;
//# sourceMappingURL=normalizeHelpers.js.map
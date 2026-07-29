'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.toTimestamp =
  exports.stringifyNullish =
  exports.readString =
  exports.readNumericLike =
  exports.readNumber =
  exports.readNullableString =
  exports.readNullableNumber =
  exports.readIsoDate =
  exports.readId =
  exports.readBoolean =
  exports.isRecord =
  exports.isPositiveSafeInteger =
  exports.isNonNegativeSafeInteger =
  exports.isNonEmptyString =
  exports.isNonArrayRecord =
    void 0;
var _esToolkit = require('es-toolkit');
/** Normalize a date-like input to epoch milliseconds; missing or malformed values become NaN. */
const toTimestamp = value => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
};

/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
exports.toTimestamp = toTimestamp;
const isRecord = value => typeof value === 'object' && value !== null;

/** Narrow a value to a non-null, non-array record. */
exports.isRecord = isRecord;
const isNonArrayRecord = value => (0, _esToolkit.isPlainObject)(value);

/** Narrow a value to a non-empty string. */
exports.isNonArrayRecord = isNonArrayRecord;
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;

/** Narrow a value to a non-negative safe integer. */
exports.isNonEmptyString = isNonEmptyString;
const isNonNegativeSafeInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Narrow a value to a positive safe integer. */
exports.isNonNegativeSafeInteger = isNonNegativeSafeInteger;
const isPositiveSafeInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Convert a value to string via `String(v)` while preserving explicit `null`/`undefined` as-is (they are
 * not stringified to `"null"`/`"undefined"`). Note this does not filter empty strings - `stringifyNullish('')` is `''`.
 *
 * @param v Value to stringify.
 * @returns `String(v)`, or `v` unchanged when it is `null`/`undefined`.
 */
exports.isPositiveSafeInteger = isPositiveSafeInteger;
const stringifyNullish = v => (v != null ? String(v) : v);

/** Read a string or return undefined for missing or malformed values. */
exports.stringifyNullish = stringifyNullish;
const readString = value => (typeof value === 'string' ? value : undefined);

/** Read a string while preserving explicit null writes. */
exports.readString = readString;
const readNullableString = value => {
  if (value === null) return null;
  return readString(value);
};

/** Read a number or return undefined for missing or malformed values. */
exports.readNullableString = readNullableString;
const readNumber = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Object.is(value, -0) ? 0 : value;
};

/** Read a finite number or non-empty numeric string; malformed, blank, and non-finite values return undefined. */
exports.readNumber = readNumber;
const readNumericLike = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Read a number while preserving explicit null writes. */
exports.readNumericLike = readNumericLike;
const readNullableNumber = value => {
  if (value === null) return null;
  return readNumber(value);
};

/** Read a boolean or return undefined for missing or malformed values. */
exports.readNullableNumber = readNullableNumber;
const readBoolean = value => (typeof value === 'boolean' ? value : undefined);

/** Read an ISO date-time string from a string, `Date`, or epoch-milliseconds value; `undefined` for unparseable input. */
exports.readBoolean = readBoolean;
const readIsoDate = value => {
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? undefined : value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
};

/** Read an id as a string; non-empty string/number pass through, anything else (empty string/boolean/object/array/null/undefined) returns undefined. */
exports.readIsoDate = readIsoDate;
const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return id === '' ? undefined : id;
};
exports.readId = readId;
//# sourceMappingURL=normalizeHelpers.js.map

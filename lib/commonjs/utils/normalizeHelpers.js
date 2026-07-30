"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.toTimestamp = exports.isRecord = exports.isPositiveSafeInteger = exports.isNonNegativeSafeInteger = exports.isNonEmptyString = exports.isNonArrayRecord = void 0;
var _esToolkit = require("es-toolkit");
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
exports.isPositiveSafeInteger = isPositiveSafeInteger;
//# sourceMappingURL=normalizeHelpers.js.map
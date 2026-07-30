"use strict";

import { isPlainObject } from 'es-toolkit';
/** Normalize a date-like input to epoch milliseconds; missing or malformed values become NaN. */
export const toTimestamp = value => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
};

/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export const isRecord = value => typeof value === 'object' && value !== null;

/** Narrow a value to a non-null, non-array record. */
export const isNonArrayRecord = value => isPlainObject(value);

/** Narrow a value to a non-empty string. */
export const isNonEmptyString = value => typeof value === 'string' && value.length > 0;

/** Narrow a value to a non-negative safe integer. */
export const isNonNegativeSafeInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Narrow a value to a positive safe integer. */
export const isPositiveSafeInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
//# sourceMappingURL=normalizeHelpers.js.map
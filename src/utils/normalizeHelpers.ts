import { isPlainObject } from 'es-toolkit';
import type { TimestampInput } from '../types';

/** Normalize a date-like input to epoch milliseconds; missing or malformed values become NaN. */
export const toTimestamp = (value: TimestampInput): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
};

/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Narrow a value to a non-null, non-array record. */
export const isNonArrayRecord = (value: unknown): value is Record<string, unknown> => isPlainObject(value);

/** Narrow a value to a non-empty string. */
export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Narrow a value to a non-negative safe integer. */
export const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Narrow a value to a positive safe integer. */
export const isPositiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

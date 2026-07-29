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

/**
 * Convert a value to string via `String(v)` while preserving explicit `null`/`undefined` as-is (they are
 * not stringified to `"null"`/`"undefined"`). Note this does not filter empty strings - `stringifyNullish('')` is `''`.
 *
 * @param v Value to stringify.
 * @returns `String(v)`, or `v` unchanged when it is `null`/`undefined`.
 */
export const stringifyNullish = (v: unknown): string | null | undefined => (v != null ? String(v) : (v as null | undefined));

/** Read a string or return undefined for missing or malformed values. */
export const readString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Read a string while preserving explicit null writes. */
export const readNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return readString(value);
};

/** Read a number or return undefined for missing or malformed values. */
export const readNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Object.is(value, -0) ? 0 : value;
};

/** Read a finite number or non-empty numeric string; malformed, blank, and non-finite values return undefined. */
export const readNumericLike = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Read a number while preserving explicit null writes. */
export const readNullableNumber = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return readNumber(value);
};

/** Read a boolean or return undefined for missing or malformed values. */
export const readBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

/** Read an ISO date-time string from a string, `Date`, or epoch-milliseconds value; `undefined` for unparseable input. */
export const readIsoDate = (value: unknown): string | undefined => {
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? undefined : value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
};

/** Read an id as a string; non-empty string/number pass through, anything else (empty string/boolean/object/array/null/undefined) returns undefined. */
export const readId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return id === '' ? undefined : id;
};

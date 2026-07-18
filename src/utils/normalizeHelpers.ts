/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Narrow a value to a non-null, non-array record. */
export const isNonArrayRecord = (value: unknown): value is Record<string, unknown> => isPlainObject(value);

/**
 * Convert a value to string via `String(v)` while preserving explicit `null`/`undefined` as-is (they are
 * not stringified to `"null"`/`"undefined"`). Note this does not filter empty strings - `toStr('')` is `''`.
 *
 * @param v Value to stringify.
 * @returns `String(v)`, or `v` unchanged when it is `null`/`undefined`.
 */
export const toStr = (v: unknown): string | null | undefined => (v != null ? String(v) : (v as null | undefined));

/** Read a string or return undefined for missing or malformed values. */
export const readString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Read a string while preserving explicit null writes. */
export const readNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return readString(value);
};

/** Read a number or return undefined for missing or malformed values. */
export const readNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

/** Read a number while preserving explicit null writes. */
export const readNullableNumber = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return readNumber(value);
};

/** Read a boolean or return undefined for missing or malformed values. */
export const readBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

/** Read an id as a string; non-empty string/number pass through, anything else (empty string/boolean/object/array/null/undefined) returns undefined. */
export const readId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return id === '' ? undefined : id;
};
import { isPlainObject } from 'es-toolkit';

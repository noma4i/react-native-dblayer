/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Convert a value to string while preserving null and undefined. */
export const toStr = (v: unknown): string | null | undefined => (v != null ? String(v) : (v as null | undefined));

/** Convert a value to a required string. */
export const toRequiredStr = (value: unknown): string => String(value);

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

/** Read an id as a string; string/number pass through, anything else (boolean/object/array/null/undefined) returns undefined. */
export const readId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return toStr(value) ?? undefined;
};

/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export declare const isRecord: (value: unknown) => value is Record<string, unknown>;
/** Narrow a value to a non-null, non-array record. */
export declare const isNonArrayRecord: (value: unknown) => value is Record<string, unknown>;
/**
 * Convert a value to string via `String(v)` while preserving explicit `null`/`undefined` as-is (they are
 * not stringified to `"null"`/`"undefined"`). Note this does not filter empty strings - `stringifyNullish('')` is `''`.
 *
 * @param v Value to stringify.
 * @returns `String(v)`, or `v` unchanged when it is `null`/`undefined`.
 */
export declare const stringifyNullish: (v: unknown) => string | null | undefined;
/** Read a string or return undefined for missing or malformed values. */
export declare const readString: (value: unknown) => string | undefined;
/** Read a string while preserving explicit null writes. */
export declare const readNullableString: (value: unknown) => string | null | undefined;
/** Read a number or return undefined for missing or malformed values. */
export declare const readNumber: (value: unknown) => number | undefined;
/** Read a number while preserving explicit null writes. */
export declare const readNullableNumber: (value: unknown) => number | null | undefined;
/** Read a boolean or return undefined for missing or malformed values. */
export declare const readBoolean: (value: unknown) => boolean | undefined;
/** Read an id as a string; non-empty string/number pass through, anything else (empty string/boolean/object/array/null/undefined) returns undefined. */
export declare const readId: (value: unknown) => string | undefined;
//# sourceMappingURL=normalizeHelpers.d.ts.map
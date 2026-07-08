/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export declare const isRecord: (value: unknown) => value is Record<string, unknown>;
/** Convert a value to string while preserving null and undefined. */
export declare const toStr: (v: unknown) => string | null | undefined;
/** Convert a value to a required string. */
export declare const toRequiredStr: (value: unknown) => string;
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
/** Read an id as a string; string/number pass through, anything else (boolean/object/array/null/undefined) returns undefined. */
export declare const readId: (value: unknown) => string | undefined;
//# sourceMappingURL=normalizeHelpers.d.ts.map
import type { TimestampInput } from '../types';
/** Normalize a date-like input to epoch milliseconds; missing or malformed values become NaN. */
export declare const toTimestamp: (value: TimestampInput) => number;
/** Narrow a value to a non-null object. Arrays also satisfy this check - callers that need to exclude them do so themselves. */
export declare const isRecord: (value: unknown) => value is Record<string, unknown>;
/** Narrow a value to a non-null, non-array record. */
export declare const isNonArrayRecord: (value: unknown) => value is Record<string, unknown>;
/** Narrow a value to a non-empty string. */
export declare const isNonEmptyString: (value: unknown) => value is string;
/** Narrow a value to a non-negative safe integer. */
export declare const isNonNegativeSafeInteger: (value: unknown) => value is number;
/** Narrow a value to a positive safe integer. */
export declare const isPositiveSafeInteger: (value: unknown) => value is number;
//# sourceMappingURL=normalizeHelpers.d.ts.map
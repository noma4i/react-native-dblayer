/** Validate the base62 fractional-key language, including the no-minimal-tail density invariant. */
export declare const isOrderKey: (value: unknown) => value is string;
/**
 * Generate a key strictly between `lower` and `upper` under codepoint comparison.
 * @param lower Exclusive lower bound; `undefined` means "before every key".
 * @param upper Exclusive upper bound; `undefined` means "after every key".
 * @returns A non-empty base62 key that never ends with the minimal digit, so a key before it always exists.
 * @throws When the bounds are inverted or not base62.
 */
export declare const keyBetween: (lower: string | undefined, upper: string | undefined) => string;
/** Generate a key strictly before `key` (a prepend placement). */
export declare const keyBefore: (key: string | undefined) => string;
/** Generate a key strictly after `key` (an append placement). */
export declare const keyAfter: (key: string | undefined) => string;
/**
 * Generate `count` strictly increasing keys evenly distributed between the bounds - the rebuild
 * path for complete landings and order resets. Even distribution keeps keys short where a chained
 * `keyBetween` walk would degrade one character per insertion.
 * @param count Number of keys; non-positive counts return an empty array.
 * @param lower Exclusive lower bound; `undefined` means "before every key".
 * @param upper Exclusive upper bound; `undefined` means "after every key".
 * @returns Deterministic keys of one shared length, none ending with the minimal digit.
 */
export declare const keysForSequence: (count: number, lower?: string, upper?: string) => string[];
//# sourceMappingURL=orderKey.d.ts.map

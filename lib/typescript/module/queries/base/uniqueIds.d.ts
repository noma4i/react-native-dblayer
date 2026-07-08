/** Shared immutable empty id list for stable fallback reads. */
export declare const EMPTY_IDS: string[];
/**
 * Return unique non-empty ids in first-seen order.
 *
 * @param ids Candidate ids that may be nullish or duplicated.
 * @returns A new array containing each truthy id once.
 */
export declare const createUniqueIds: (ids: Array<string | null | undefined>) => string[];
//# sourceMappingURL=uniqueIds.d.ts.map
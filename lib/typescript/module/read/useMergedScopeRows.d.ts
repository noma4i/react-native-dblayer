type MergeOptions<TRow> = {
    comparator?: (left: TRow, right: TRow) => number;
};
/**
 * Merges a base scope read with extra rows from a second scope read.
 * Extras whose id already exists in the base array are dropped; surviving
 * extras are appended after the base rows. When a comparator is provided the
 * merged array is sorted with it; a base-only result is resorted into a new
 * array as well (the base array itself is never mutated).
 *
 * Identity contract: when no extras survive dedup and no comparator is given,
 * the base array is returned as-is (same reference). Repeated renders with
 * referentially identical inputs return the previously built array.
 *
 * @param baseRows Base rows from the primary scope read.
 * @param extraRows Additional rows that should be merged into the base.
 * @param options Optional merge options including comparator.
 * @returns Merged rows with deduplication and optional sorting.
 */
export declare const useMergedScopeRows: <TRow extends {
    id: string;
}>(baseRows: ReadonlyArray<TRow>, extraRows: ReadonlyArray<TRow>, options?: MergeOptions<TRow>) => ReadonlyArray<TRow>;
export {};
//# sourceMappingURL=useMergedScopeRows.d.ts.map
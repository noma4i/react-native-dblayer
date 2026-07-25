type MergeOptions<TRow> = {
    comparator?: (left: TRow, right: TRow) => number;
};
/**
 * Merges a base scope read with extra rows from a second scope read.
 * Extras whose id already exists in the base array are dropped; surviving
 * extras are appended after the base rows. When a comparator is provided the
 * merged array is sorted with it (base-only results are NOT resorted - the
 * base scope owns its own ordering).
 *
 * Identity contract: when no extras survive dedup and no comparator is given,
 * the base array is returned as-is (same reference). Repeated renders with
 * referentially identical inputs return the previously built array.
 */
export declare const useMergedScopeRows: <TRow extends {
    id: string;
}>(baseRows: ReadonlyArray<TRow>, extraRows: ReadonlyArray<TRow>, options?: MergeOptions<TRow>) => ReadonlyArray<TRow>;
export {};
//# sourceMappingURL=useMergedScopeRows.d.ts.map
import type { ClientSort, MultiFieldSort, RowId } from '../types';
/** Narrow a client sort spec to its declared key-list form (`Array.isArray` alone does not narrow `ReadonlyArray` unions). */
export declare const isMultiFieldSort: <TStored>(sort: ClientSort<TStored>) => sort is MultiFieldSort<TStored>;
/** Compare supported field-order values as a total order with missing values last. */
export declare const compareOrderValues: (left: unknown, right: unknown) => number;
/** Add the canonical codepoint id tie-break to a row comparator. */
export declare const withIdTieBreak: <TRow extends RowId>(compare: (left: TRow, right: TRow) => number) => ((left: TRow, right: TRow) => number);
/**
 * Pick the single lowest-sorting row. The consumer comparator decides; a tie is settled by the
 * canonical id tie-break, so the answer does not depend on the order rows arrived in. Every
 * `hasOne` read surface resolves through here - a raw reduce would give each surface its own answer.
 *
 * @param rows Candidate rows.
 * @param comparator Consumer comparator; omit to take the first row.
 * @returns The winning row, or `undefined` when there are no candidates.
 */
export declare const pickLowestRow: <TRow extends RowId>(rows: readonly TRow[], comparator?: (left: TRow, right: TRow) => number) => TRow | undefined;
/** Build one canonical multi-field row comparator with missing values last and an id tie-break. */
export declare const createFieldOrderComparator: <TRow extends RowId & Record<string, unknown>>(orderBy: ReadonlyArray<{
    field: string;
    direction: "asc" | "desc";
}>) => ((left: TRow, right: TRow) => number);
/** Build the canonical comparator for a client-sorted scope: comparator, one field, or a declared key list. */
export declare const compareRowsBySpec: <TRow extends RowId & Record<string, unknown>>(sort: ClientSort<TRow>) => ((left: TRow, right: TRow) => number);
/** Engine order options that reproduce the canonical comparator: absence last, codepoint strings. */
export declare const canonicalOrderOptions: (direction: "asc" | "desc") => {
    direction: "asc" | "desc";
    nulls: "last";
    stringSort: "lexical";
};
/** Apply an optional non-negative row limit; undefined means no limit. */
export declare const limitRows: <T>(rows: T[], limit: number | undefined) => T[];
/** Sort a snapshot read by declared keys and cut it to the declared limit. */
export declare const sortModelReadRows: <T extends RowId & Record<string, unknown>>(rows: T[], orderBy: ReadonlyArray<{
    field: string;
    direction: "asc" | "desc";
}>, limit?: number) => T[];
//# sourceMappingURL=ordering.d.ts.map
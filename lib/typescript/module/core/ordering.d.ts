import type { ClientSort, RowId } from '../types';
/** Compare supported field-order values as a total order with missing values last. */
export declare const compareOrderValues: (left: unknown, right: unknown) => number;
/** Add the canonical codepoint id tie-break to a row comparator. */
export declare const withIdTieBreak: <TRow extends RowId>(compare: (left: TRow, right: TRow) => number) => ((left: TRow, right: TRow) => number);
/** Build one canonical multi-field row comparator with missing values last and an id tie-break. */
export declare const createFieldOrderComparator: <TRow extends RowId & Record<string, unknown>>(orderBy: ReadonlyArray<{
    field: string;
    direction: "asc" | "desc";
}>) => ((left: TRow, right: TRow) => number);
/** Build the canonical comparator for a client-sorted scope. */
export declare const compareRowsBySpec: <TRow extends RowId & Record<string, unknown>>(sort: ClientSort<TRow>) => ((left: TRow, right: TRow) => number);
//# sourceMappingURL=ordering.d.ts.map
import type { DbReadOptions, DbWhere } from '../types';
type QueryWithWhere<Q, TRow> = Q & {
    where(callback: (row: {
        items: TRow;
    }) => unknown): Q;
};
type QueryRow = Record<string, unknown>;
export declare const compileDbWhereExpression: (where: DbWhere<any> | undefined, items: QueryRow) => unknown;
export declare const applyDbWhereToQuery: <TStored, Q>(query: QueryWithWhere<Q, TStored>, where: DbWhere<TStored> | undefined) => Q;
export declare const applyDbReadOptionsToQuery: <TStored, Q>(query: Q, options: DbReadOptions<TStored> | undefined) => Q;
export declare const matchesDbWhere: <TStored>(row: TStored, where: DbWhere<TStored> | undefined) => boolean;
export declare const normalizeDbCondition: <TStored>(condition?: Partial<TStored>) => Partial<TStored> | undefined;
/** Sentinel scope key shared by every fetch-state read/write for an empty or missing filter. */
export declare const ROOT_SCOPE_KEY = "__root__";
/**
 * Derive the freshness scope key for a filter/scope value.
 *
 * Single canon shared by every fetch-state read/write path (hook-level `useBaseQuery`/
 * `useBaseInfiniteQuery` and model-level `createCollectionModel`) so the same filter always maps to
 * the same key regardless of which path wrote or reads it - previously each path serialized filters
 * slightly differently (raw truthy-check vs `undefined`-stripping normalization), which could split a
 * single logical scope across two different stored keys.
 *
 * Non-plain-object input (`null`, `undefined`, an array, or a primitive) and a plain object that
 * normalizes to nothing (empty, or every value is `undefined`) both collapse to `ROOT_SCOPE_KEY`.
 */
export declare const buildScopeKey: (input: unknown) => string;
export declare const createDbWhereSignature: <TStored>(where: DbWhere<TStored> | undefined, options?: DbReadOptions<TStored>) => string;
export declare const applyDbReadOptionsToRows: <TStored>(rows: TStored[], options?: DbReadOptions<TStored>) => TStored[];
export {};
//# sourceMappingURL=compileDbWhere.d.ts.map
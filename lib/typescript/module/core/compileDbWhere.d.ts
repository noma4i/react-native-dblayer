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
export declare const createDbWhereSignature: <TStored>(where: DbWhere<TStored> | undefined, options?: DbReadOptions<TStored>) => string;
export declare const applyDbReadOptionsToRows: <TStored>(rows: TStored[], options?: DbReadOptions<TStored>) => TStored[];
export {};
//# sourceMappingURL=compileDbWhere.d.ts.map
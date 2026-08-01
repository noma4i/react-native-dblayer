import type { DbWhere, WhereExpression, WhereRowRef } from '../types';
/**
 * Compile a declared filter into a query expression of the collection engine, so a live query
 * answers the same filter that `matchesDbWhere` answers row by row. One declaration, one meaning:
 * a second hand-written interpretation of the same filter is what lets two read surfaces disagree.
 *
 * @param ref Row reference handed to the query builder's `where` callback.
 * @param where Declared filter; a filter with no condition compiles to a condition every row meets.
 * @returns Boolean expression for the engine's `where` clause.
 */
export declare const compileWhereExpression: <TStored>(ref: WhereRowRef, where: DbWhere<TStored> | undefined) => WhereExpression;
//# sourceMappingURL=compileWhereExpression.d.ts.map
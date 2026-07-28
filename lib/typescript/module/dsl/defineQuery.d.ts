import type { EnsuredRowQueryHandle, ExtractSink, QueryConfig, QueryHandle } from '../types';
/**
 * Create one extract sink only when a row exists; pair with the `{ into, rows }` extract contract.
 *
 * @param into Extract destination.
 * @param row Optional source row.
 * @returns One extract sink, or an empty list.
 */
export declare const intoIf: (into: ExtractSink["into"], row: unknown) => ExtractSink[];
/** Define a coordinator-owned GraphQL query: react-query drives freshness/single-flight/retry, results land through the store's write seams. */
export declare const defineQuery: <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>) => QueryHandle<TStored, TScope> | EnsuredRowQueryHandle<TStored, TScope>;
//# sourceMappingURL=defineQuery.d.ts.map
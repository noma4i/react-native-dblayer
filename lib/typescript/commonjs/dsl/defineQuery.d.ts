import type { EnsuredRowQueryHandle, QueryConfig, QueryHandle } from '../types';
/** Define a coordinator-owned GraphQL query: react-query drives freshness/single-flight/retry, results land through the store's write seams. */
export declare const defineQuery: <TResponse, TVars, TScope, TStored>(rawConfig: QueryConfig<TResponse, TVars, TScope, TStored>) => QueryHandle<TStored, TScope> | EnsuredRowQueryHandle<TStored, TScope>;
//# sourceMappingURL=defineQuery.d.ts.map
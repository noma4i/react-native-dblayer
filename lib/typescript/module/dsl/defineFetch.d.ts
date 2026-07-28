import type { FetchConfig, FetchHandle } from '../types';
/**
 * Define an ephemeral coordinator-owned fetch with no model-store writes.
 *
 * @param config Document or fetcher plus selection and freshness policy.
 * @returns Coordinator-backed reactive and imperative fetch methods.
 */
export declare const defineFetch: <TData, TInput = void, TSelected = TData>(config: FetchConfig<TData, TInput, TSelected>) => FetchHandle<TInput, TSelected>;
//# sourceMappingURL=defineFetch.d.ts.map
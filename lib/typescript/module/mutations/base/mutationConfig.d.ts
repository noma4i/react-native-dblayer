import type { DbCommandConfig } from '../../types';
/** Capitalize the first character; returns falsy input unchanged. */
export declare const capitalize: (value: string) => string;
export declare const resolveCommandKey: <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback?: string) => readonly unknown[];
export declare const resolveCommandLogPrefix: <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback?: string) => string;
//# sourceMappingURL=mutationConfig.d.ts.map
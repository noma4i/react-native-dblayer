/** Pick listed keys whose values are not undefined. Explicit null values are kept. */
export declare const pickDefined: <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]) => Partial<Pick<TSource, TKey>>;
/** Pick listed keys whose values are neither null nor undefined. */
export declare const pickPresent: <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]) => Partial<Pick<TSource, TKey>>;
//# sourceMappingURL=pickDefined.d.ts.map
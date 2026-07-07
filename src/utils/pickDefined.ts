/** Pick listed keys whose values are not undefined. Explicit null values are kept. */
export const pickDefined = <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]): Partial<Pick<TSource, TKey>> => {
  const output: Partial<Pick<TSource, TKey>> = {};

  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
};

/** Pick listed keys whose values are neither null nor undefined. */
export const pickPresent = <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]): Partial<Pick<TSource, TKey>> => {
  const output: Partial<Pick<TSource, TKey>> = {};

  for (const key of keys) {
    const value = source[key];
    if (value != null) {
      output[key] = value;
    }
  }

  return output;
};

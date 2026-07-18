/**
 * Pick listed keys whose values are not undefined. Explicit null values are kept.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch with undefined values removed.
 */
export const pickDefined = <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]): Partial<Pick<TSource, TKey>> =>
  omitBy(pick(source as Record<string, unknown>, keys as unknown as string[]), isUndefined) as Partial<Pick<TSource, TKey>>;

type PresentPick<TSource extends object, TKey extends keyof TSource> = Partial<{
  [K in TKey]: NonNullable<TSource[K]>;
}>;

/**
 * Pick listed keys whose values are neither null nor undefined.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch whose value types exclude null and undefined.
 */
export const pickPresent = <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]): PresentPick<TSource, TKey> =>
  pickBy(pick(source as Record<string, unknown>, keys as unknown as string[]), isNotNil) as PresentPick<TSource, TKey>;
import { isNotNil, isUndefined, omitBy, pick, pickBy } from 'es-toolkit';

import { isNotNil, isUndefined, omitBy, pick, pickBy } from 'es-toolkit';

import type { PresentPick } from '../types';
/**
 * Pick listed keys whose values are not undefined. Explicit null values are kept.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch with undefined values removed.
 */
export const pickDefined = <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]): Partial<Pick<TSource, TKey>> =>
  omitBy(pick(source, [...keys]), isUndefined) as Partial<Pick<TSource, TKey>>;

/**
 * Pick listed keys whose values are neither null nor undefined.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch whose value types exclude null and undefined.
 */
export const pickPresent = <TSource extends object, TKey extends keyof TSource>(source: TSource, keys: readonly TKey[]): PresentPick<TSource, TKey> =>
  pickBy(pick(source, [...keys]), isNotNil) as PresentPick<TSource, TKey>;

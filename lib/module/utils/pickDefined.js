"use strict";

import { isNotNil, isUndefined, omitBy, pick, pickBy } from 'es-toolkit';

/**
 * Pick listed keys whose values are not undefined. Explicit null values are kept.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch with undefined values removed.
 */
export const pickDefined = (source, keys) => omitBy(pick(source, keys), isUndefined);
/**
 * Pick listed keys whose values are neither null nor undefined.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch whose value types exclude null and undefined.
 */
export const pickPresent = (source, keys) => pickBy(pick(source, keys), isNotNil);
//# sourceMappingURL=pickDefined.js.map
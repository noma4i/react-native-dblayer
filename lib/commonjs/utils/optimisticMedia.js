'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.mergeOptimisticMedia = mergeOptimisticMedia;
var _normalizeHelpers = require('./normalizeHelpers.js');
const DEFAULT_DIMENSION_KEYS = ['width', 'height'];
const isPositiveFiniteNumber = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isMissingDimension = value => !isPositiveFiniteNumber(value);
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;

/**
 * Merge generic optimistic media continuity fields into a server media object.
 *
 * Positive optimistic dimensions are preserved when the server omits or zeroes configured dimension
 * keys, while real server dimensions win. Configured source keys prefer non-empty server strings and
 * otherwise keep non-empty optimistic strings. Nullish or non-object server values are returned as-is.
 *
 * @param optimistic Optimistic media-like record, or any nullish/non-object value.
 * @param server Server media-like record, or any nullish/non-object value.
 * @param options Dimension key pair and source-like string keys to merge.
 * @returns Server media with generic optimistic continuity fields applied, or the original server value.
 */

/**
 * Merge generic optimistic media continuity fields into a server media object.
 *
 * Positive optimistic dimensions are preserved when the server omits or zeroes configured dimension
 * keys, while real server dimensions win. Configured source keys prefer non-empty server strings and
 * otherwise keep non-empty optimistic strings. Nullish or non-object server values are returned as-is.
 *
 * @param optimistic Optimistic media-like record, or any nullish/non-object value.
 * @param server Server media-like record, or any nullish/non-object value.
 * @param options Dimension key pair and source-like string keys to merge.
 * @returns Server media with generic optimistic continuity fields applied, or the original server value.
 */

function mergeOptimisticMedia(optimistic, server, options = {}) {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(server)) return server;
  const optimisticRecord = (0, _normalizeHelpers.isNonArrayRecord)(optimistic) ? optimistic : undefined;
  const output = {
    ...server
  };
  const dimensionKeys = options.dimensionKeys ?? DEFAULT_DIMENSION_KEYS;
  for (const key of dimensionKeys) {
    if (isMissingDimension(output[key]) && optimisticRecord && isPositiveFiniteNumber(optimisticRecord[key])) {
      output[key] = optimisticRecord[key];
    }
  }
  for (const key of options.sourceKeys ?? []) {
    if (!isNonEmptyString(output[key]) && optimisticRecord && isNonEmptyString(optimisticRecord[key])) {
      output[key] = optimisticRecord[key];
    }
  }
  return output;
}
//# sourceMappingURL=optimisticMedia.js.map

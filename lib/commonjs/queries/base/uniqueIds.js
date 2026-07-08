"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createUniqueIds = exports.EMPTY_IDS = void 0;
/** Shared immutable empty id list for stable fallback reads. */
const EMPTY_IDS = exports.EMPTY_IDS = [];

/**
 * Return unique non-empty ids in first-seen order.
 *
 * @param ids Candidate ids that may be nullish or duplicated.
 * @returns A new array containing each truthy id once.
 */
const createUniqueIds = ids => {
  const seen = new Set();
  const uniqueIds = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }
  return uniqueIds;
};
exports.createUniqueIds = createUniqueIds;
//# sourceMappingURL=uniqueIds.js.map
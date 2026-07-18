"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.emptyIds = exports.dedupeIds = void 0;
/** Shared immutable empty id list for stable fallback reads. */
const emptyIds = exports.emptyIds = [];

/**
 * Return unique non-empty ids in first-seen order.
 *
 * @param ids Candidate ids that may be nullish or duplicated.
 * @returns A new array containing each truthy id once.
 */
const dedupeIds = ids => {
  const seen = new Set();
  const uniqueIds = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }
  return uniqueIds;
};
exports.dedupeIds = dedupeIds;
//# sourceMappingURL=uniqueIds.js.map
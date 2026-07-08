"use strict";

/** Shared immutable empty id list for stable fallback reads. */
export const EMPTY_IDS = [];

/**
 * Return unique non-empty ids in first-seen order.
 *
 * @param ids Candidate ids that may be nullish or duplicated.
 * @returns A new array containing each truthy id once.
 */
export const createUniqueIds = ids => {
  const seen = new Set();
  const uniqueIds = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }
  return uniqueIds;
};
//# sourceMappingURL=uniqueIds.js.map
"use strict";

export const EMPTY_IDS = [];
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
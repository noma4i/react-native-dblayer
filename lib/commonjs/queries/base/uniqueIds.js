"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createUniqueIds = exports.EMPTY_IDS = void 0;
const EMPTY_IDS = exports.EMPTY_IDS = [];
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
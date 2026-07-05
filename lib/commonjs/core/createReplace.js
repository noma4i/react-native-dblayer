"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createReplace = createReplace;
var _invariants = require("./invariants.js");
/** Create a replace writer that upserts incoming rows and deletes rows missing from the incoming set. */
function createReplace(config) {
  return (items, scopeFilter) => {
    const normalized = items.map(item => config.normalize(item)).filter(item => item !== null);
    const newIds = new Set();
    for (const item of normalized) {
      newIds.add(item.id);
      if (config.collection.has(item.id)) {
        const existing = config.collection.get(item.id);
        if (existing) {
          // Replace keeps the legacy timestamp gate only when both sides carry updatedAt.
          if (!(0, _invariants.shouldAcceptIncoming)(existing, item, {
            timestampMode: 'when-both-present',
            shouldOverwrite: config.shouldOverwrite
          })) {
            continue;
          }
        }
        config.collection.update(item.id, draft => {
          for (const [key, value] of Object.entries(item)) {
            if (value !== undefined) {
              draft[key] = value;
            }
          }
        });
      } else {
        config.collection.insert(item);
      }
    }
    const toDelete = [];
    for (const id of config.collection.keys()) {
      const idStr = String(id);
      if (newIds.has(idStr)) continue;
      if (scopeFilter) {
        const existing = config.collection.get(idStr);
        if (existing && !scopeFilter(existing)) continue;
      }
      toDelete.push(idStr);
    }
    for (const id of toDelete) {
      config.collection.delete(id);
    }
    return {
      merged: normalized.length,
      deleted: toDelete.length
    };
  };
}
//# sourceMappingURL=createReplace.js.map
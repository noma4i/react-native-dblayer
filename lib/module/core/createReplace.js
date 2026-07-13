"use strict";

import { shouldAcceptIncoming } from "./invariants.js";
import { getDbLogger } from "./logger.js";

/** Create a replace writer that upserts incoming rows and deletes rows missing from the incoming set. */
export function createReplace(config) {
  return (items, scopeFilter, protectAfterSeq) => {
    const normalized = items.map(item => config.normalize(item)).filter(item => item !== null);
    const newIds = new Set();
    let resurrectionProtectedCount = 0;
    for (const item of normalized) {
      newIds.add(item.id);
      if (protectAfterSeq !== undefined && (config.getRowDeleteSeq?.(item.id) ?? 0) > protectAfterSeq) {
        resurrectionProtectedCount++;
        continue;
      }
      if (config.collection.has(item.id)) {
        const existing = config.collection.get(item.id);
        if (existing) {
          // Replace keeps the timestamp gate only when both sides carry updatedAt.
          if (!shouldAcceptIncoming(existing, item, {
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
    let protectedCount = 0;
    for (const id of config.collection.keys()) {
      const idStr = String(id);
      if (newIds.has(idStr)) continue;
      if (scopeFilter) {
        const existing = config.collection.get(idStr);
        if (existing && !scopeFilter(existing)) continue;
      }
      if (protectAfterSeq !== undefined && (config.getRowWriteSeq?.(idStr) ?? 0) > protectAfterSeq) {
        protectedCount++;
        continue;
      }
      toDelete.push(idStr);
    }
    if (protectedCount > 0 || resurrectionProtectedCount > 0) {
      getDbLogger().debug('db', 'replace:protected', {
        protectedCount,
        resurrectionProtectedCount,
        protectAfterSeq
      });
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
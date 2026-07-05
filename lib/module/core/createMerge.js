"use strict";

import { shouldAcceptIncoming } from "./invariants.js";
import { stableSerialize } from "./serialize.js";
const fnv1a = items => {
  let hash = 2166136261;
  for (let i = 0; i < items.length; i++) {
    const s = `${stableSerialize(items[i])}|${i}`;
    for (let j = 0; j < s.length; j++) {
      hash ^= s.charCodeAt(j);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash;
};
const upsertIfNewer = (collection, item, shouldOverwrite) => {
  const key = String(item.id);
  if (!collection.has(key)) {
    collection.insert(item);
    return true;
  }
  const existing = collection.get(key);
  if (!existing) {
    collection.insert(item);
    return true;
  }

  // Merge keeps the strict timestamp gate: an existing timestamp rejects a missing incoming timestamp.
  if (!shouldAcceptIncoming(existing, item, {
    shouldOverwrite
  })) return false;
  collection.update(key, draft => {
    for (const [k, v] of Object.entries(item)) {
      if (v !== undefined) {
        draft[k] = v;
      }
    }
  });
  return true;
};

/** Create a merge writer that upserts incoming rows when they are accepted by the freshness gate. */
export function createMerge(config) {
  let lastMergeTimestamp = 0;
  let lastMergeKey = 0;
  const reset = () => {
    lastMergeTimestamp = 0;
    lastMergeKey = 0;
  };
  config.registerReset?.(reset);
  return items => {
    if (!items.length) return {
      merged: 0
    };
    const normalized = items.map(item => config.normalize(item)).filter(item => item !== null);
    const dedupeWindowMs = config.dedupeWindowMs ?? config.resolveDedupeWindowMs?.() ?? 0;
    if (dedupeWindowMs > 0) {
      const now = Date.now();
      const key = fnv1a(normalized);
      if (now - lastMergeTimestamp < dedupeWindowMs && key === lastMergeKey) {
        return {
          merged: 0
        };
      }
      lastMergeTimestamp = now;
      lastMergeKey = key;
    }
    let mergedCount = 0;
    for (const item of normalized) {
      if (upsertIfNewer(config.collection, item, config.shouldOverwrite)) {
        mergedCount++;
      }
    }
    return {
      merged: mergedCount
    };
  };
}
//# sourceMappingURL=createMerge.js.map
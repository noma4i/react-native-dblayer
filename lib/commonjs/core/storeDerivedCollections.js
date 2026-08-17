"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createDerivedCollectionCache = void 0;
var _residency = require("./residency.js");
/** Live entry counts per gauge name across every cache instance; one gauge per name for the process. */
const liveCounts = new Map();
const countLive = (gauge, delta) => {
  if (!liveCounts.has(gauge)) (0, _residency.registerResidency)(gauge, () => liveCounts.get(gauge) ?? 0);
  liveCounts.set(gauge, (liveCounts.get(gauge) ?? 0) + delta);
};

/**
 * One home for the lifetime of every collection derived from a store: scope windows and model
 * queries alike. A derived collection exists while at least one reader holds it and is disposed the
 * moment the last one leaves, so browsing scopes or filters does not accumulate live queries.
 *
 * Two caches would mean two answers to "when does a derived collection die", and the one that got
 * the answer wrong would leak quietly - nothing observable happens when a query stays alive.
 */
const createDerivedCollectionCache = gauge => {
  const entries = new Map();
  const release = (key, entry) => {
    entry.consumers -= 1;
    if (entry.consumers !== 0 || entries.get(key) !== entry) return;
    entries.delete(key);
    countLive(gauge, -1);
    void entry.collection.cleanup();
  };
  return {
    peek: key => entries.get(key)?.collection,
    acquire: (key, build) => {
      const existing = entries.get(key);
      const entry = existing ?? {
        collection: build(),
        consumers: 0
      };
      if (!existing) {
        entries.set(key, entry);
        countLive(gauge, 1);
      }
      entry.consumers += 1;
      return {
        collection: entry.collection,
        release: () => release(key, entry)
      };
    },
    disposeAll: () => {
      for (const entry of entries.values()) void entry.collection.cleanup();
      countLive(gauge, -entries.size);
      entries.clear();
    }
  };
};
exports.createDerivedCollectionCache = createDerivedCollectionCache;
//# sourceMappingURL=storeDerivedCollections.js.map
"use strict";

let liveDerivedCollectionCount = 0;
globalThis.__DBLAYER_STORE_SCOPE_COLLECTIONS__ = {
  count: () => liveDerivedCollectionCount
};

/**
 * One home for the lifetime of every collection derived from a store: scope windows and model
 * queries alike. A derived collection exists while at least one reader holds it and is disposed the
 * moment the last one leaves, so browsing scopes or filters does not accumulate live queries.
 *
 * Two caches would mean two answers to "when does a derived collection die", and the one that got
 * the answer wrong would leak quietly - nothing observable happens when a query stays alive.
 */
export const createDerivedCollectionCache = () => {
  const entries = new Map();
  const release = (key, entry) => {
    entry.consumers -= 1;
    if (entry.consumers !== 0 || entries.get(key) !== entry) return;
    entries.delete(key);
    liveDerivedCollectionCount -= 1;
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
        liveDerivedCollectionCount += 1;
      }
      entry.consumers += 1;
      return {
        collection: entry.collection,
        release: () => release(key, entry)
      };
    },
    disposeAll: () => {
      for (const entry of entries.values()) void entry.collection.cleanup();
      liveDerivedCollectionCount -= entries.size;
      entries.clear();
    }
  };
};
//# sourceMappingURL=storeDerivedCollections.js.map
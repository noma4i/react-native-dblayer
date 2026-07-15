"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createScopeIndex = void 0;
const createScopeIndex = options => {
  const {
    modelId,
    storage,
    prefix
  } = options;
  const scopes = new Map();
  const dirty = new Set();
  const removed = new Set();
  const empty = () => ({
    generation: 0,
    coverage: 'delta',
    entries: []
  });
  const storageKey = key => `${prefix()}scope:${modelId}:${key}`;
  const commit = (key, next) => {
    removed.delete(key);
    scopes.set(key, next);
    dirty.add(key);
    return next;
  };
  return {
    read: key => scopes.get(key) ?? empty(),
    write: (key, next) => {
      commit(key, next);
    },
    reconcile: (key, coverage, incoming, opts) => {
      const previous = scopes.get(key) ?? empty();
      const generation = previous.generation + 1;
      if (coverage === 'complete') {
        const incomingIds = new Set(incoming.map(row => row.id));
        const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
        const entries = incoming.map((row, order) => ({
          id: row.id,
          order,
          seq: generation,
          edge: row.edge
        }));
        return {
          next: commit(key, {
            generation,
            coverage,
            entries
          }),
          detachedIds
        };
      }
      if (coverage === 'page' && opts?.resetOrder) {
        const previousById = new Map(previous.entries.map(entry => [entry.id, entry]));
        const incomingIds = new Set(incoming.map(row => row.id));
        const head = incoming.map((row, order) => ({
          id: row.id,
          order,
          seq: generation,
          edge: row.edge ?? previousById.get(row.id)?.edge
        }));
        const tail = previous.entries.filter(entry => !incomingIds.has(entry.id)).sort((a, b) => a.order - b.order).map((entry, index) => ({
          ...entry,
          order: incoming.length + index
        }));
        return {
          next: commit(key, {
            generation,
            coverage: previous.coverage === 'complete' ? 'complete' : coverage,
            entries: [...head, ...tail]
          }),
          detachedIds: []
        };
      }
      const byId = new Map(previous.entries.map(entry => [entry.id, entry]));
      let appendOrder = previous.entries.reduce((max, entry) => Math.max(max, entry.order), -1) + 1;
      for (const row of incoming) {
        const existing = byId.get(row.id);
        if (existing) {
          byId.set(row.id, {
            ...existing,
            seq: generation,
            edge: row.edge ?? existing.edge
          });
        } else {
          byId.set(row.id, {
            id: row.id,
            order: appendOrder,
            seq: generation,
            edge: row.edge
          });
          appendOrder += 1;
        }
      }
      const entries = [...byId.values()].sort((a, b) => a.order - b.order);
      return {
        next: commit(key, {
          generation,
          coverage: previous.coverage === 'complete' ? 'complete' : coverage,
          entries
        }),
        detachedIds: []
      };
    },
    detach: (key, ids) => {
      const previous = scopes.get(key) ?? empty();
      const removal = new Set(ids);
      return commit(key, {
        generation: previous.generation + 1,
        coverage: previous.coverage,
        entries: previous.entries.filter(entry => !removal.has(entry.id))
      });
    },
    trim: (key, maxRows) => {
      const previous = scopes.get(key) ?? empty();
      if (previous.entries.length <= maxRows) return [];
      const kept = previous.entries.slice(0, maxRows);
      const trimmedIds = previous.entries.slice(maxRows).map(entry => entry.id);
      commit(key, {
        generation: previous.generation + 1,
        coverage: previous.coverage,
        entries: kept
      });
      return trimmedIds;
    },
    remove: key => {
      scopes.delete(key);
      dirty.delete(key);
      removed.add(key);
    },
    keys: () => [...scopes.keys()],
    persistEntries: () => {
      const entries = [...dirty].map(key => ({
        key: storageKey(key),
        value: JSON.stringify(scopes.get(key) ?? empty())
      }));
      dirty.clear();
      for (const key of removed) entries.push({
        key: storageKey(key),
        value: null
      });
      removed.clear();
      return entries;
    },
    hydrate: () => {
      scopes.clear();
      dirty.clear();
      removed.clear();
      for (const fullKey of storage.keys(storageKey(''))) {
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          scopes.set(fullKey.slice(storageKey('').length), JSON.parse(raw));
        } catch {
          storage.set([{
            key: fullKey,
            value: null
          }]);
        }
      }
    },
    reset: () => {
      scopes.clear();
      dirty.clear();
      removed.clear();
    }
  };
};
exports.createScopeIndex = createScopeIndex;
//# sourceMappingURL=scopeIndex.js.map
"use strict";

import { sortBy } from 'es-toolkit';
export const createScopeIndex = options => {
  const {
    modelId,
    scopeNames,
    storage,
    prefix
  } = options;
  const scopes = new Map();
  const dirty = new Set();
  const removed = new Set();
  const memberSets = new Map();
  const keysByRow = new Map();
  const reactiveEpochs = new Map();
  const orderRevisions = new Map();
  const accessTimes = new Map();
  const empty = () => ({
    generation: 0,
    coverage: 'delta',
    entries: []
  });
  const storageKey = key => `${prefix()}scope:${modelId}:${key}`;
  const touch = key => {
    reactiveEpochs.set(key, (reactiveEpochs.get(key) ?? 0) + 1);
  };
  const boundaryAddFor = (key, previous, coverage, incoming, opts) => {
    if (coverage !== 'delta' && coverage !== 'page' || opts?.resetOrder || incoming.some(row => typeof row.order !== 'number')) return undefined;
    const members = memberSets.get(key);
    if (incoming.some(row => members?.has(row.id))) return undefined;
    if (previous.entries.length === 0) return {
      side: 'tail',
      ids: incoming.map(row => row.id)
    };
    const headOrder = previous.entries[0].order;
    const tailOrder = previous.entries.at(-1).order;
    if (incoming.every(row => row.order < headOrder)) return {
      side: 'head',
      ids: incoming.map(row => row.id)
    };
    if (incoming.every(row => row.order > tailOrder)) return {
      side: 'tail',
      ids: incoming.map(row => row.id)
    };
    return undefined;
  };
  const indexCommit = (key, previous, next) => {
    const nextIds = new Set(next.entries.map(entry => entry.id));
    if (previous) {
      for (const entry of previous.entries) {
        if (nextIds.has(entry.id)) continue;
        const keys = keysByRow.get(entry.id);
        if (!keys) continue;
        keys.delete(key);
        if (keys.size === 0) keysByRow.delete(entry.id);
      }
    }
    for (const id of nextIds) {
      let keys = keysByRow.get(id);
      if (!keys) {
        keys = new Set();
        keysByRow.set(id, keys);
      }
      keys.add(key);
    }
    memberSets.set(key, nextIds);
  };
  const commit = (key, next, fastAdd) => {
    if (fastAdd) {
      orderRevisions.set(key, (orderRevisions.get(key) ?? 0) + 1);
      let members = memberSets.get(key);
      if (!members) {
        members = new Set();
        memberSets.set(key, members);
      }
      for (const id of fastAdd) {
        members.add(id);
        let keys = keysByRow.get(id);
        if (!keys) {
          keys = new Set();
          keysByRow.set(id, keys);
        }
        keys.add(key);
      }
      removed.delete(key);
      scopes.set(key, next);
      dirty.add(key);
      touch(key);
      return next;
    }
    const previousOrder = (scopes.get(key)?.entries ?? []).map(entry => entry.id).join('\0');
    const nextOrder = next.entries.map(entry => entry.id).join('\0');
    if (previousOrder !== nextOrder) orderRevisions.set(key, (orderRevisions.get(key) ?? 0) + 1);
    removed.delete(key);
    indexCommit(key, scopes.get(key), next);
    scopes.set(key, next);
    dirty.add(key);
    touch(key);
    return next;
  };
  const reconcileNext = (key, coverage, incoming, opts) => {
    const previous = scopes.get(key) ?? empty();
    const generation = previous.generation + 1;
    const boundaryAdd = boundaryAddFor(key, previous, coverage, incoming, opts);
    if (boundaryAdd) {
      const sortedIncoming = sortBy(incoming, [row => row.order, row => row.id]).map(row => ({
        id: row.id,
        order: row.order,
        seq: generation,
        edge: row.edge
      }));
      const entries = boundaryAdd.side === 'head' ? [...sortedIncoming, ...previous.entries] : [...previous.entries, ...sortedIncoming];
      return {
        next: {
          generation,
          coverage: previous.coverage === 'complete' ? 'complete' : coverage,
          entries
        },
        detachedIds: []
      };
    }
    if (coverage === 'complete') {
      const incomingIds = new Set(incoming.map(row => row.id));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
      const entries = incoming.map((row, index) => ({
        id: row.id,
        order: row.order ?? index,
        seq: generation,
        edge: row.edge
      }));
      return {
        next: {
          generation,
          coverage,
          entries
        },
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
        next: {
          generation,
          coverage: previous.coverage === 'complete' ? 'complete' : coverage,
          entries: [...head, ...tail]
        },
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
          order: row.order ?? existing.order,
          seq: generation,
          edge: row.edge ?? existing.edge
        });
      } else {
        const order = row.order ?? appendOrder;
        byId.set(row.id, {
          id: row.id,
          order,
          seq: generation,
          edge: row.edge
        });
        appendOrder = Math.max(appendOrder, order + 1);
      }
    }
    const entries = [...byId.values()].sort((a, b) => a.order - b.order);
    return {
      next: {
        generation,
        coverage: previous.coverage === 'complete' ? 'complete' : coverage,
        entries
      },
      detachedIds: []
    };
  };
  const trimValue = (value, maxRows) => {
    if (value.entries.length <= maxRows) return {
      next: value,
      trimmedIds: []
    };
    return {
      next: {
        generation: value.generation + 1,
        coverage: value.coverage,
        entries: value.entries.slice(0, maxRows)
      },
      trimmedIds: value.entries.slice(maxRows).map(entry => entry.id)
    };
  };
  const trimNext = (key, maxRows) => trimValue(scopes.get(key) ?? empty(), maxRows);
  return {
    read: key => scopes.get(key) ?? empty(),
    write: (key, next) => {
      commit(key, next);
    },
    reconcile: (key, coverage, incoming, opts) => {
      const previous = scopes.get(key) ?? empty();
      const boundaryAdd = boundaryAddFor(key, previous, coverage, incoming, opts);
      const result = reconcileNext(key, coverage, incoming, opts);
      return {
        next: commit(key, result.next, boundaryAdd?.ids),
        detachedIds: result.detachedIds
      };
    },
    reconcileNext,
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
      const result = trimNext(key, maxRows);
      if (result.trimmedIds.length > 0) commit(key, result.next);
      return result.trimmedIds;
    },
    trimValue,
    trimNext,
    remove: key => {
      const members = memberSets.get(key);
      if (members) {
        for (const id of members) {
          const keys = keysByRow.get(id);
          if (!keys) continue;
          keys.delete(key);
          if (keys.size === 0) keysByRow.delete(id);
        }
        memberSets.delete(key);
      }
      scopes.delete(key);
      dirty.delete(key);
      removed.add(key);
      accessTimes.delete(key);
      touch(key);
    },
    keys: () => [...scopes.keys()],
    noteAccess: key => {
      accessTimes.set(key, Date.now());
    },
    lastAccess: key => accessTimes.get(key),
    has: (key, id) => memberSets.get(key)?.has(id) ?? false,
    keysOf: id => [...(keysByRow.get(id) ?? [])],
    reactiveEpoch: key => reactiveEpochs.get(key) ?? 0,
    orderRevision: key => orderRevisions.get(key) ?? 0,
    touchMembers: ids => {
      const touched = new Set();
      for (const id of ids) {
        for (const key of keysByRow.get(id) ?? []) touched.add(key);
      }
      for (const key of touched) touch(key);
      return [...touched];
    },
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
      memberSets.clear();
      keysByRow.clear();
      reactiveEpochs.clear();
      accessTimes.clear();
      for (const fullKey of storage.keys(storageKey(''))) {
        const key = fullKey.slice(storageKey('').length);
        if (scopeNames !== undefined && !scopeNames.some(scopeName => key.startsWith(`${scopeName}:`))) {
          storage.set([{
            key: fullKey,
            value: null
          }]);
          continue;
        }
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          scopes.set(key, JSON.parse(raw));
          accessTimes.set(key, Date.now());
        } catch {
          storage.set([{
            key: fullKey,
            value: null
          }]);
        }
      }
      memberSets.clear();
      keysByRow.clear();
      reactiveEpochs.clear();
      for (const [key, value] of scopes) indexCommit(key, undefined, value);
    },
    reset: () => {
      scopes.clear();
      dirty.clear();
      removed.clear();
      memberSets.clear();
      keysByRow.clear();
      reactiveEpochs.clear();
      accessTimes.clear();
    }
  };
};
//# sourceMappingURL=scopeIndex.js.map
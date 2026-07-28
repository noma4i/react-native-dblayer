"use strict";

import { noteDataLoss, noteScopeKeyMigration } from "../diagnostics.js";
import { compositeKey } from "../serialize.js";
import { sortBy } from 'es-toolkit';
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "../persistenceCodec.js";
import { isRecord } from "../../utils/normalizeHelpers.js";
const isScopeIndexValue = value => isRecord(value) && typeof value.generation === 'number' && (value.coverage === 'delta' || value.coverage === 'page' || value.coverage === 'complete') && Array.isArray(value.entries) && value.entries.every(entry => isRecord(entry) && typeof entry.id === 'string' && typeof entry.order === 'number' && typeof entry.seq === 'number' && (entry.edge === undefined || isRecord(entry.edge)));
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
  const orderRevisions = new Map();
  const accessTimes = new Map();
  const empty = () => ({
    generation: 0,
    coverage: 'delta',
    entries: []
  });
  const storageKey = key => `${prefix()}scope:${modelId}:${key}`;
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
  const sameEntryOrder = (previous, next) => {
    if (!previous) return next.length === 0;
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index].id !== next[index].id) return false;
    }
    return true;
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
      return next;
    }
    if (!sameEntryOrder(scopes.get(key)?.entries, next.entries)) orderRevisions.set(key, (orderRevisions.get(key) ?? 0) + 1);
    removed.delete(key);
    indexCommit(key, scopes.get(key), next);
    scopes.set(key, next);
    dirty.add(key);
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
      /** Complete snapshots deduplicate like delta/page: the last payload occurrence supplies the retained entry. */
      const incomingById = new Map();
      for (const row of incoming) incomingById.set(row.id, row);
      const deduplicated = [...incomingById.values()];
      const incomingIds = new Set(deduplicated.map(row => row.id));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
      const entries = deduplicated.map((row, index) => ({
        id: row.id,
        order: row.order ?? index,
        seq: generation + index,
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
      if (result.detachedIds.length > 0) noteDataLoss('scope-complete-detach', modelId, result.detachedIds.length);
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
      if (result.trimmedIds.length > 0) {
        commit(key, result.next);
        noteDataLoss('scope-retention-trim', modelId, result.trimmedIds.length);
      }
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
    },
    keys: () => [...scopes.keys()],
    noteAccess: key => {
      accessTimes.set(key, Date.now());
    },
    lastAccess: key => accessTimes.get(key),
    has: (key, id) => memberSets.get(key)?.has(id) ?? false,
    keysOf: id => [...(keysByRow.get(id) ?? [])],
    orderRevision: key => orderRevisions.get(key) ?? 0,
    touchMembers: ids => {
      const touched = new Set();
      for (const id of ids) {
        for (const key of keysByRow.get(id) ?? []) touched.add(key);
      }
      return [...touched];
    },
    persistEntries: () => {
      const entries = [...dirty].map(key => ({
        key: storageKey(key),
        value: encodePersistence(scopes.get(key) ?? empty())
      }));
      for (const key of removed) entries.push({
        key: storageKey(key),
        value: null
      });
      return entries;
    },
    ackPersist: () => {
      dirty.clear();
      removed.clear();
    },
    hydrate: () => {
      scopes.clear();
      dirty.clear();
      removed.clear();
      memberSets.clear();
      keysByRow.clear();
      accessTimes.clear();
      const loaded = new Map();
      const migrated = new Map();
      const orderedScopeNames = [...(scopeNames ?? [])].sort((left, right) => right.length - left.length);
      for (const fullKey of storage.keys(storageKey(''))) {
        const persistedKey = fullKey.slice(storageKey('').length);
        const canonicalScopeName = orderedScopeNames.find(scopeName => persistedKey.startsWith(compositeKey(scopeName, '')));
        const colonDelimitedScopeName = canonicalScopeName ? undefined : orderedScopeNames.find(scopeName => persistedKey.startsWith(`${scopeName}:`));
        const key = canonicalScopeName ? persistedKey : colonDelimitedScopeName ? compositeKey(colonDelimitedScopeName, persistedKey.slice(colonDelimitedScopeName.length + 1)) : null;
        if (!key) {
          storage.set([{
            key: fullKey,
            value: null
          }]);
          noteDataLoss('corrupt-scope', modelId, 1);
          continue;
        }
        const raw = storage.get(fullKey);
        if (!raw) continue;
        const value = decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isScopeIndexValue);
        if (value) {
          const entry = {
            raw,
            value,
            canonical: canonicalScopeName !== undefined
          };
          const existing = loaded.get(key);
          if (!existing || entry.canonical) loaded.set(key, entry);
          if (colonDelimitedScopeName) migrated.set(fullKey, key);
        } else {
          storage.set([{
            key: fullKey,
            value: null
          }]);
          noteDataLoss('corrupt-scope', modelId, 1);
        }
      }
      for (const [key, entry] of loaded) {
        scopes.set(key, entry.value);
        accessTimes.set(key, Date.now());
      }
      if (migrated.size > 0) {
        const entries = [];
        const migratedKeys = new Set(migrated.values());
        for (const key of migratedKeys) {
          const entry = loaded.get(key);
          if (!entry.canonical) entries.push({
            key: storageKey(key),
            value: entry.raw
          });
        }
        for (const fullKey of migrated.keys()) entries.push({
          key: fullKey,
          value: null
        });
        storage.set(entries);
        noteScopeKeyMigration(migrated.size);
      }
      memberSets.clear();
      keysByRow.clear();
      for (const [key, value] of scopes) indexCommit(key, undefined, value);
    },
    reset: () => {
      scopes.clear();
      dirty.clear();
      removed.clear();
      memberSets.clear();
      keysByRow.clear();
      accessTimes.clear();
    }
  };
};
//# sourceMappingURL=scopeIndex.js.map
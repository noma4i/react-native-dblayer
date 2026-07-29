"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createScopeIndex = void 0;
var _diagnostics = require("../diagnostics.js");
var _serialize = require("../serialize.js");
var _orderKey = require("../orderKey.js");
var _persistenceCodec = require("../persistenceCodec.js");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
const isScopeIndexValue = value => (0, _normalizeHelpers.isRecord)(value) && typeof value.generation === 'number' && (value.coverage === 'delta' || value.coverage === 'page' || value.coverage === 'complete') && Array.isArray(value.entries) && value.entries.every(entry => (0, _normalizeHelpers.isRecord)(entry) && typeof entry.id === 'string' && typeof entry.orderKey === 'string' && (entry.edge === undefined || (0, _normalizeHelpers.isRecord)(entry.edge)));
const compareEntries = (left, right) => (0, _serialize.compareCodepoints)(left.orderKey, right.orderKey) || (0, _serialize.compareCodepoints)(left.id, right.id);
const sameIdSequence = (previous, nextIds) => {
  if (previous.length !== nextIds.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index].id !== nextIds[index]) return false;
  }
  return true;
};
const createScopeIndex = options => {
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
  let stagedScopes = null;
  const empty = () => ({
    generation: 0,
    coverage: 'delta',
    entries: []
  });
  const storageKey = key => `${prefix()}scope:${modelId}:${key}`;
  const current = key => {
    if (stagedScopes?.has(key)) return stagedScopes.get(key) ?? undefined;
    return scopes.get(key);
  };
  const removeCommitted = key => {
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
    return sameIdSequence(previous, next.map(entry => entry.id));
  };
  const commit = (key, next, fastAdd) => {
    if (stagedScopes) {
      stagedScopes.set(key, next);
      return next;
    }
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

  /** Merge entries carrying final keys into an existing key-ordered list; a re-appearing id lands on its new key. */
  const mergeByKey = (previous, incoming) => {
    const replaced = new Set(incoming.map(entry => entry.id));
    const merged = previous.filter(entry => !replaced.has(entry.id));
    merged.push(...incoming);
    merged.sort(compareEntries);
    return merged;
  };
  const reconcileNext = (key, coverage, incoming, opts) => {
    const previous = current(key) ?? empty();
    const generation = previous.generation + 1;
    const previousById = new Map(previous.entries.map(entry => [entry.id, entry]));
    const retainedCoverage = previous.coverage === 'complete' ? 'complete' : coverage;
    if (coverage === 'complete') {
      /** Complete snapshots deduplicate like delta/page: the last payload occurrence supplies the retained entry. */
      const incomingById = new Map();
      for (const row of incoming) incomingById.set(row.id, row);
      const deduplicated = [...incomingById.values()];
      const incomingIds = new Set(deduplicated.map(row => row.id));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
      if (sameIdSequence(previous.entries, deduplicated.map(row => row.id))) {
        const entries = previous.entries.map((entry, index) => ({
          ...entry,
          edge: deduplicated[index].edge ?? entry.edge
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
      const keys = (0, _orderKey.keysForSequence)(deduplicated.length);
      const entries = deduplicated.map((row, index) => ({
        id: row.id,
        orderKey: row.orderKey ?? keys[index],
        edge: row.edge
      }));
      return {
        next: {
          generation,
          coverage,
          entries: [...entries].sort(compareEntries)
        },
        detachedIds
      };
    }
    if (coverage === 'page' && opts?.resetOrder) {
      const incomingById = new Map();
      for (const row of incoming) incomingById.set(row.id, row);
      const head = [...incomingById.values()];
      const tail = previous.entries.filter(entry => !incomingById.has(entry.id));
      if (sameIdSequence(previous.entries, [...head.map(row => row.id), ...tail.map(entry => entry.id)])) {
        const entries = previous.entries.map(entry => ({
          ...entry,
          edge: incomingById.get(entry.id)?.edge ?? entry.edge
        }));
        return {
          next: {
            generation,
            coverage: retainedCoverage,
            entries
          },
          detachedIds: []
        };
      }
      const headKeys = (0, _orderKey.keysForSequence)(head.length, undefined, tail[0]?.orderKey);
      const headEntries = head.map((row, index) => ({
        id: row.id,
        orderKey: headKeys[index],
        edge: row.edge ?? previousById.get(row.id)?.edge
      }));
      return {
        next: {
          generation,
          coverage: retainedCoverage,
          entries: [...headEntries, ...tail]
        },
        detachedIds: []
      };
    }
    const keyed = [];
    const keyless = [];
    for (const row of incoming) {
      const existing = previousById.get(row.id);
      if (row.orderKey !== undefined) keyed.push({
        id: row.id,
        orderKey: row.orderKey,
        edge: row.edge ?? existing?.edge
      });else if (existing) keyed.push({
        ...existing,
        edge: row.edge ?? existing.edge
      });else keyless.push(row);
    }
    const afterKeyed = mergeByKey(previous.entries, keyed);
    const tailKeys = (0, _orderKey.keysForSequence)(keyless.length, afterKeyed.at(-1)?.orderKey);
    const entries = [...afterKeyed, ...keyless.map((row, index) => ({
      id: row.id,
      orderKey: tailKeys[index],
      edge: row.edge
    }))];
    return {
      next: {
        generation,
        coverage: retainedCoverage,
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
  return {
    beginApply: () => {
      if (stagedScopes) throw new Error(`Scope apply already active for ${modelId}`);
      stagedScopes = new Map();
    },
    commitApply: () => {
      if (!stagedScopes) throw new Error(`Scope apply is not active for ${modelId}`);
      const staged = stagedScopes;
      stagedScopes = null;
      for (const [key, value] of staged) {
        if (value === null) removeCommitted(key);else commit(key, value);
      }
    },
    abortApply: () => {
      stagedScopes = null;
    },
    read: key => current(key) ?? empty(),
    write: (key, next) => {
      commit(key, next);
    },
    reconcileNext,
    applyDelta: (key, append, detach) => {
      const previous = current(key) ?? empty();
      const removal = new Set(detach);
      const base = removal.size > 0 ? previous.entries.filter(entry => !removal.has(entry.id)) : previous.entries;
      const members = stagedScopes ? new Set(previous.entries.map(entry => entry.id)) : memberSets.get(key);
      const pureAppend = removal.size === 0 && append.every(entry => !members?.has(entry.id)) && (base.length === 0 || append.every(entry => (0, _serialize.compareCodepoints)(entry.orderKey, base.at(-1).orderKey) > 0));
      const entries = pureAppend ? [...base, ...[...append].sort(compareEntries)] : mergeByKey(base, append);
      const next = {
        generation: previous.generation + 1,
        coverage: previous.coverage,
        entries
      };
      return commit(key, next, pureAppend ? append.map(entry => entry.id) : undefined);
    },
    detach: (key, ids) => {
      const previous = current(key) ?? empty();
      const removal = new Set(ids);
      return commit(key, {
        generation: previous.generation + 1,
        coverage: previous.coverage,
        entries: previous.entries.filter(entry => !removal.has(entry.id))
      });
    },
    trimValue,
    remove: key => {
      if (stagedScopes) {
        stagedScopes.set(key, null);
        return;
      }
      removeCommitted(key);
    },
    keys: () => {
      if (!stagedScopes) return [...scopes.keys()];
      const keys = new Set(scopes.keys());
      for (const [key, value] of stagedScopes) {
        if (value === null) keys.delete(key);else keys.add(key);
      }
      return [...keys];
    },
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
        value: (0, _persistenceCodec.encodePersistence)(scopes.get(key) ?? empty())
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
      stagedScopes = null;
      scopes.clear();
      dirty.clear();
      removed.clear();
      memberSets.clear();
      keysByRow.clear();
      accessTimes.clear();
      for (const fullKey of storage.keys(storageKey(''))) {
        const key = fullKey.slice(storageKey('').length);
        const raw = storage.get(fullKey);
        if (!raw) continue;
        /** A key that does not belong to a declared scope (renamed/removed scope, foreign format) is stale state: drop it as corrupt. */
        const declared = scopeNames === undefined || scopeNames.some(scopeName => key.startsWith((0, _serialize.compositeKey)(scopeName, '')));
        const value = declared ? (0, _persistenceCodec.decodeSupportedPersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isScopeIndexValue) : undefined;
        if (value) {
          scopes.set(key, value);
          accessTimes.set(key, Date.now());
        } else {
          storage.set([{
            key: fullKey,
            value: null
          }]);
          (0, _diagnostics.noteDataLoss)('corrupt-scope', modelId, 1);
        }
      }
      for (const [key, value] of scopes) indexCommit(key, undefined, value);
    },
    reset: () => {
      stagedScopes = null;
      scopes.clear();
      dirty.clear();
      removed.clear();
      memberSets.clear();
      keysByRow.clear();
      accessTimes.clear();
    }
  };
};
exports.createScopeIndex = createScopeIndex;
//# sourceMappingURL=scopeIndex.js.map
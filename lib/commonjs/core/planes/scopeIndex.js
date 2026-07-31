"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isScopeIndexValue = exports.isScopeEntrySet = exports.isScopeEntry = exports.deduplicateScopeEntriesById = exports.createScopeIndex = void 0;
var _diagnostics = require("../diagnostics.js");
var _serialize = require("../serialize.js");
var _orderKey = require("../orderKey.js");
var _persistenceCodec = require("../persistenceCodec.js");
var _arrayEquality = require("../../utils/arrayEquality.js");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
const isScopeEntry = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && (0, _normalizeHelpers.isNonEmptyString)(value.id) && (0, _orderKey.isOrderKey)(value.orderKey);
exports.isScopeEntry = isScopeEntry;
const compareEntries = (left, right) => (0, _serialize.compareCodepoints)(left.orderKey, right.orderKey) || (0, _serialize.compareCodepoints)(left.id, right.id);

/** Deduplicate scope entries by id before planning or apply; the last payload occurrence supplies the retained value. */
const deduplicateScopeEntriesById = entries => {
  const byId = new Map();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
};

/** Validate one unordered scope-entry set: every entry is valid and both member ids and order keys are unique. */
exports.deduplicateScopeEntriesById = deduplicateScopeEntriesById;
const isScopeEntrySet = value => {
  if (!Array.isArray(value) || !value.every(isScopeEntry)) return false;
  const ids = new Set();
  const orderKeys = new Set();
  for (const entry of value) {
    if (ids.has(entry.id) || orderKeys.has(entry.orderKey)) return false;
    ids.add(entry.id);
    orderKeys.add(entry.orderKey);
  }
  return true;
};
exports.isScopeEntrySet = isScopeEntrySet;
const isScopeIndexValue = value => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(value)) return false;
  const entries = value.entries;
  if (!(0, _normalizeHelpers.isNonNegativeSafeInteger)(value.generation) || value.coverage !== 'delta' && value.coverage !== 'page' && value.coverage !== 'complete' || !isScopeEntrySet(entries)) return false;
  if (value.generation === 0 && (value.coverage !== 'delta' || entries.length > 0)) return false;
  return entries.every((entry, index) => index === 0 || compareEntries(entries[index - 1], entry) < 0);
};
exports.isScopeIndexValue = isScopeIndexValue;
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
  const storagePrefix = () => (0, _serialize.compositeStorageKey)(prefix(), 'scope', modelId);
  const storageKey = key => (0, _serialize.compositeStorageKey)(prefix(), 'scope', modelId, key);
  const current = key => {
    if (stagedScopes?.has(key)) return stagedScopes.get(key) ?? undefined;
    return scopes.get(key);
  };
  const removeCommitted = key => {
    const members = memberSets.get(key);
    if (members) {
      for (const id of members) {
        const keys = keysByRow.get(id);
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
    return (0, _arrayEquality.arraysShallowEqual)(previous, next.map(entry => entry.id), (entry, id) => entry.id === id);
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
  const scopeEntry = (id, orderKey) => ({
    id,
    orderKey
  });
  const reconcileNext = (key, coverage, incoming, opts) => {
    const previous = current(key) ?? empty();
    const generation = previous.generation + 1;
    const previousById = new Map(previous.entries.map(entry => [entry.id, entry]));
    const retainedCoverage = previous.coverage === 'complete' ? 'complete' : coverage;
    const deduplicated = deduplicateScopeEntriesById(incoming);
    const result = (next, detachedIds) => {
      if (!isScopeIndexValue(next)) throw new Error(`Invalid scope index value for ${modelId}:${key}`);
      return {
        next,
        detachedIds
      };
    };
    if (coverage === 'complete') {
      const incomingIds = new Set(deduplicated.map(row => row.id));
      // A server snapshot can neither confirm nor deny a row an open operation still holds, so a
      // held member missing from the payload keeps its entry (and key) instead of being detached.
      const held = previous.entries.filter(entry => !incomingIds.has(entry.id) && (opts?.protectedIds?.has(entry.id) ?? false));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id) && !opts?.protectedIds?.has(entry.id)).map(entry => entry.id);
      if (held.length === 0 && (0, _arrayEquality.arraysShallowEqual)(previous.entries, deduplicated.map(row => row.id), (entry, id) => entry.id === id)) {
        const entries = previous.entries.map(entry => scopeEntry(entry.id, entry.orderKey));
        return result({
          generation,
          coverage,
          entries
        }, detachedIds);
      }
      const keys = (0, _orderKey.keysForSequence)(deduplicated.length);
      const entries = deduplicated.map((row, index) => scopeEntry(row.id, row.orderKey ?? keys[index]));
      const merged = [...entries, ...held.map(entry => scopeEntry(entry.id, entry.orderKey))];
      return result({
        generation,
        coverage,
        entries: merged.sort(compareEntries)
      }, detachedIds);
    }
    if (coverage === 'page' && opts?.resetOrder) {
      const incomingById = new Map(deduplicated.map(row => [row.id, row]));
      const head = deduplicated;
      const tail = previous.entries.filter(entry => !incomingById.has(entry.id));
      if ((0, _arrayEquality.arraysShallowEqual)(previous.entries, [...head.map(row => row.id), ...tail.map(entry => entry.id)], (entry, id) => entry.id === id)) {
        const entries = previous.entries.map(entry => scopeEntry(entry.id, entry.orderKey));
        return result({
          generation,
          coverage: retainedCoverage,
          entries
        }, []);
      }
      const headKeys = (0, _orderKey.keysForSequence)(head.length, undefined, tail[0]?.orderKey);
      const headEntries = head.map((row, index) => scopeEntry(row.id, headKeys[index]));
      return result({
        generation,
        coverage: retainedCoverage,
        entries: [...headEntries, ...tail]
      }, []);
    }
    const keyed = [];
    const keyless = [];
    for (const row of deduplicated) {
      const existing = previousById.get(row.id);
      if (row.orderKey !== undefined) keyed.push(scopeEntry(row.id, row.orderKey));else if (existing) keyed.push(scopeEntry(existing.id, existing.orderKey));else keyless.push(row);
    }
    const afterKeyed = mergeByKey(previous.entries, keyed);
    const tailKeys = (0, _orderKey.keysForSequence)(keyless.length, afterKeyed.at(-1)?.orderKey);
    const entries = [...afterKeyed, ...keyless.map((row, index) => scopeEntry(row.id, tailKeys[index]))];
    return result({
      generation,
      coverage: retainedCoverage,
      entries
    }, []);
  };
  const trimValue = (value, maxRows, protectedIds) => {
    if (value.entries.length <= maxRows) return {
      next: value,
      trimmedIds: []
    };
    const kept = [];
    const trimmedIds = [];
    let budget = maxRows;
    for (const entry of value.entries) {
      // A held row never trims and never consumes the budget: retention bounds server history, not
      // the consumer's own unresolved writes.
      if (protectedIds?.has(entry.id)) {
        kept.push(entry);
        continue;
      }
      if (budget > 0) {
        kept.push(entry);
        budget -= 1;
        continue;
      }
      trimmedIds.push(entry.id);
    }
    if (trimmedIds.length === 0) return {
      next: value,
      trimmedIds: []
    };
    return {
      next: {
        generation: value.generation + 1,
        coverage: value.coverage,
        entries: kept
      },
      trimmedIds
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
      append = deduplicateScopeEntriesById(append);
      const removal = new Set(detach);
      const base = removal.size > 0 ? previous.entries.filter(entry => !removal.has(entry.id)) : previous.entries;
      const members = stagedScopes ? new Set(previous.entries.map(entry => entry.id)) : memberSets.get(key) ?? new Set();
      const pureAppend = removal.size === 0 && append.every(entry => !members.has(entry.id)) && (base.length === 0 || append.every(entry => (0, _serialize.compareCodepoints)(entry.orderKey, base.at(-1).orderKey) > 0));
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
        value: (0, _persistenceCodec.encodePersistence)(scopes.get(key))
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
      for (const fullKey of storage.keys(storagePrefix())) {
        const encoded = (0, _serialize.parseCompositeKey)(fullKey.slice(storagePrefix().length));
        const key = encoded?.length === 1 ? encoded[0] : undefined;
        const raw = storage.get(fullKey);
        if (!raw) continue;
        /** A key that does not belong to a declared scope (renamed/removed scope, foreign format) is stale state: drop it as corrupt. */
        const scopeParts = key === undefined ? undefined : (0, _serialize.parseCompositeKey)(key);
        const declared = scopeParts?.length === 2 && (0, _normalizeHelpers.isNonEmptyString)(scopeParts[0]) && (0, _normalizeHelpers.isNonEmptyString)(scopeParts[1]) && (scopeNames === undefined || scopeNames.includes(scopeParts[0]));
        const value = declared ? (0, _persistenceCodec.decodeSupportedPersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isScopeIndexValue) : undefined;
        if (key !== undefined && value) {
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
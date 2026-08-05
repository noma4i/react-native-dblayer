"use strict";

import { noteDataLoss } from "../diagnostics.js";
import { compareCodepoints, compositeStorageKey, parseCompositeKey } from "../serialize.js";
import { isOrderKey, keysForSequence } from "../orderKey.js";
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "../persistenceCodec.js";
import { arraysShallowEqual } from "../../utils/arrayEquality.js";
import { isNonArrayRecord, isNonEmptyString, isNonNegativeSafeInteger } from "../../utils/normalizeHelpers.js";
export const isScopeEntry = value => isNonArrayRecord(value) && isNonEmptyString(value.id) && isOrderKey(value.orderKey);
const compareEntries = (left, right) => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.id, right.id);

/** Deduplicate scope entries by id before planning or apply; the last payload occurrence supplies the retained value. */
export const deduplicateScopeEntriesById = entries => {
  const byId = new Map();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
};

/** Validate one unordered scope-entry set: every entry is valid and both member ids and order keys are unique. */
export const isScopeEntrySet = value => {
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
export const isScopeIndexValue = value => {
  if (!isNonArrayRecord(value)) return false;
  const entries = value.entries;
  if (!isNonNegativeSafeInteger(value.generation) || value.coverage !== 'delta' && value.coverage !== 'page' && value.coverage !== 'complete' || !isScopeEntrySet(entries)) return false;
  if (value.generation === 0 && (value.coverage !== 'delta' || entries.length > 0)) return false;
  return entries.every((entry, index) => index === 0 || compareEntries(entries[index - 1], entry) < 0);
};
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
  let stagedScopes = null;
  const empty = () => ({
    generation: 0,
    coverage: 'delta',
    entries: []
  });
  const storagePrefix = () => compositeStorageKey(prefix(), 'scope', modelId);
  const storageKey = key => compositeStorageKey(prefix(), 'scope', modelId, key);
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

  /**
   * The ONE place membership projections change. Both landing paths call it - the diffing commit with
   * the ids that left, the append fast path with none - so `memberSets` and `keysByRow` cannot be
   * repaired by one path and left stale by the other.
   */
  const indexMembership = (key, members, departed) => {
    for (const id of departed) {
      const keys = keysByRow.get(id);
      keys.delete(key);
      if (keys.size === 0) keysByRow.delete(id);
    }
    for (const id of members) {
      let keys = keysByRow.get(id);
      if (!keys) {
        keys = new Set();
        keysByRow.set(id, keys);
      }
      keys.add(key);
    }
    memberSets.set(key, members);
  };
  const indexCommit = (key, previous, next) => {
    const nextIds = new Set(next.entries.map(entry => entry.id));
    const departed = (previous?.entries ?? []).filter(entry => !nextIds.has(entry.id)).map(entry => entry.id);
    indexMembership(key, nextIds, departed);
  };
  const sameEntryOrder = (previous, next) => {
    if (!previous) return next.length === 0;
    return arraysShallowEqual(previous, next.map(entry => entry.id), (entry, id) => entry.id === id);
  };
  const commit = (key, next, fastAdd) => {
    if (stagedScopes) {
      stagedScopes.set(key, next);
      return next;
    }
    if (fastAdd) {
      orderRevisions.set(key, (orderRevisions.get(key) ?? 0) + 1);
      const members = memberSets.get(key) ?? new Set();
      for (const id of fastAdd) members.add(id);
      indexMembership(key, members, []);
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
      if (held.length === 0 && arraysShallowEqual(previous.entries, deduplicated.map(row => row.id), (entry, id) => entry.id === id)) {
        const entries = previous.entries.map(entry => scopeEntry(entry.id, entry.orderKey));
        return result({
          generation,
          coverage,
          entries
        }, detachedIds);
      }
      const keys = keysForSequence(deduplicated.length);
      // Held rows keep their keys, so freshly generated keys must steer around them: a collision
      // would fail the uniqueness invariant and refuse the whole reconcile.
      const taken = new Set(held.map(entry => entry.orderKey));
      for (const row of deduplicated) if (row.orderKey !== undefined) taken.add(row.orderKey);
      const entries = deduplicated.map((row, index) => {
        if (row.orderKey !== undefined) return scopeEntry(row.id, row.orderKey);
        let key = keys[index];
        while (taken.has(key)) key = keysForSequence(1, key, keys[index + 1])[0];
        taken.add(key);
        return scopeEntry(row.id, key);
      });
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
      if (arraysShallowEqual(previous.entries, [...head.map(row => row.id), ...tail.map(entry => entry.id)], (entry, id) => entry.id === id)) {
        const entries = previous.entries.map(entry => scopeEntry(entry.id, entry.orderKey));
        return result({
          generation,
          coverage: retainedCoverage,
          entries
        }, []);
      }
      const headKeys = keysForSequence(head.length, undefined, tail[0]?.orderKey);
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
    const tailKeys = keysForSequence(keyless.length, afterKeyed.at(-1)?.orderKey);
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
      const pureAppend = removal.size === 0 && append.every(entry => !members.has(entry.id)) && (base.length === 0 || append.every(entry => compareCodepoints(entry.orderKey, base.at(-1).orderKey) > 0));
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
    residentRowKeys: () => keysByRow.size,
    orderRevision: key => orderRevisions.get(key) ?? 0,
    touchMembers: ids => {
      const touched = new Set();
      for (const id of ids) {
        for (const key of keysByRow.get(id) ?? []) touched.add(key);
      }
      return [...touched];
    },
    persistEntries: () => {
      const changed = new Set([...dirty, ...removed, ...(stagedScopes?.keys() ?? [])]);
      const entries = [];
      for (const key of changed) {
        const value = stagedScopes?.has(key) ? stagedScopes.get(key) : scopes.get(key);
        entries.push({
          key: storageKey(key),
          value: value ? encodePersistence(value) : null
        });
      }
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
      orderRevisions.clear();
      accessTimes.clear();
      for (const fullKey of storage.keys(storagePrefix())) {
        const encoded = parseCompositeKey(fullKey.slice(storagePrefix().length));
        const key = encoded?.length === 1 ? encoded[0] : undefined;
        const raw = storage.get(fullKey);
        /** A key that does not belong to a declared scope (renamed/removed scope, foreign format) is stale state: drop it as corrupt. */
        const scopeParts = key === undefined ? undefined : parseCompositeKey(key);
        const declared = scopeParts?.length === 2 && isNonEmptyString(scopeParts[0]) && isNonEmptyString(scopeParts[1]) && (scopeNames === undefined || scopeNames.includes(scopeParts[0]));
        // An absent or empty raw value is unreadable state: it takes the corrupt branch, never a silent skip.
        const value = raw && declared ? decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isScopeIndexValue) : undefined;
        if (key !== undefined && value) {
          scopes.set(key, value);
          accessTimes.set(key, Date.now());
        } else {
          storage.set(fullKey, null);
          noteDataLoss('corrupt-scope', modelId, 1);
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
      orderRevisions.clear();
      accessTimes.clear();
    }
  };
};
//# sourceMappingURL=scopeIndex.js.map
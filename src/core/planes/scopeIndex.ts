import type { StoragePlane, IncomingScopeRow, ReconcileResult, ScopeCoverage, ScopeEntry, ScopeIndex, ScopeIndexValue } from '../../types';
import { noteDataLoss } from '../diagnostics';
import { compareCodepoints, compositeStorageKey, parseCompositeKey } from '../serialize';
import { isOrderKey, keysForSequence } from '../orderKey';
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from '../persistenceCodec';
import { arraysShallowEqual } from '../../utils/arrayEquality';
import { isNonArrayRecord, isNonEmptyString, isNonNegativeSafeInteger } from '../../utils/normalizeHelpers';

export const isScopeEntry = (value: unknown): value is ScopeEntry =>
  isNonArrayRecord(value) && isNonEmptyString(value.id) && isOrderKey(value.orderKey) && (value.edge === undefined || isNonArrayRecord(value.edge));

const compareEntries = (left: ScopeEntry, right: ScopeEntry): number => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.id, right.id);

/** Deduplicate scope entries by id before planning or apply; the last payload occurrence supplies the retained value. */
export const deduplicateScopeEntriesById = <T extends { id: string }>(entries: readonly T[]): T[] => {
  const byId = new Map<string, T>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
};

/** Validate one unordered scope-entry set: every entry is valid and both member ids and order keys are unique. */
export const isScopeEntrySet = (value: unknown): value is ScopeEntry[] => {
  if (!Array.isArray(value) || !value.every(isScopeEntry)) return false;
  const ids = new Set<string>();
  const orderKeys = new Set<string>();
  for (const entry of value) {
    if (ids.has(entry.id) || orderKeys.has(entry.orderKey)) return false;
    ids.add(entry.id);
    orderKeys.add(entry.orderKey);
  }
  return true;
};

export const isScopeIndexValue = (value: unknown): value is ScopeIndexValue => {
  if (!isNonArrayRecord(value)) return false;
  const entries = value.entries;
  if (!isNonNegativeSafeInteger(value.generation) || (value.coverage !== 'delta' && value.coverage !== 'page' && value.coverage !== 'complete') || !isScopeEntrySet(entries))
    return false;
  if (value.generation === 0 && (value.coverage !== 'delta' || entries.length > 0)) return false;
  return entries.every((entry, index) => index === 0 || compareEntries(entries[index - 1]!, entry) < 0);
};

export const createScopeIndex = (options: { modelId: string; scopeNames?: string[]; storage: StoragePlane; prefix: () => string }): ScopeIndex => {
  const { modelId, scopeNames, storage, prefix } = options;
  const scopes = new Map<string, ScopeIndexValue>();
  const dirty = new Set<string>();
  const removed = new Set<string>();
  const memberSets = new Map<string, Set<string>>();
  const keysByRow = new Map<string, Set<string>>();
  const orderRevisions = new Map<string, number>();
  const accessTimes = new Map<string, number>();
  let stagedScopes: Map<string, ScopeIndexValue | null> | null = null;
  const empty = (): ScopeIndexValue => ({ generation: 0, coverage: 'delta', entries: [] });
  const storagePrefix = () => compositeStorageKey(prefix(), 'scope', modelId);
  const storageKey = (key: string) => compositeStorageKey(prefix(), 'scope', modelId, key);
  const current = (key: string): ScopeIndexValue | undefined => {
    if (stagedScopes?.has(key)) return stagedScopes.get(key) ?? undefined;
    return scopes.get(key);
  };
  const removeCommitted = (key: string): void => {
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

  const indexCommit = (key: string, previous: ScopeIndexValue | undefined, next: ScopeIndexValue): void => {
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

  const sameEntryOrder = (previous: ScopeEntry[] | undefined, next: ScopeEntry[]): boolean => {
    if (!previous) return next.length === 0;
    return arraysShallowEqual(
      previous,
      next.map(entry => entry.id),
      (entry, id) => entry.id === id
    );
  };

  const commit = (key: string, next: ScopeIndexValue, fastAdd?: string[]): ScopeIndexValue => {
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
  const mergeByKey = (previous: ScopeEntry[], incoming: ScopeEntry[]): ScopeEntry[] => {
    const replaced = new Set(incoming.map(entry => entry.id));
    const merged = previous.filter(entry => !replaced.has(entry.id));
    merged.push(...incoming);
    merged.sort(compareEntries);
    return merged;
  };
  const scopeEntry = (id: string, orderKey: string, edge?: Record<string, unknown>): ScopeEntry => ({
    id,
    orderKey,
    ...(edge ? { edge } : {})
  });

  const reconcileNext = (key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult => {
    const previous = current(key) ?? empty();
    const generation = previous.generation + 1;
    const previousById = new Map(previous.entries.map(entry => [entry.id, entry] as const));
    const retainedCoverage = previous.coverage === 'complete' ? 'complete' : coverage;
    const deduplicated = deduplicateScopeEntriesById(incoming);
    const result = (next: ScopeIndexValue, detachedIds: string[]): ReconcileResult => {
      if (!isScopeIndexValue(next)) throw new Error(`Invalid scope index value for ${modelId}:${key}`);
      return { next, detachedIds };
    };

    if (coverage === 'complete') {
      const incomingIds = new Set(deduplicated.map(row => row.id));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
      if (
        arraysShallowEqual(
          previous.entries,
          deduplicated.map(row => row.id),
          (entry, id) => entry.id === id
        )
      ) {
        const entries = previous.entries.map((entry, index) => scopeEntry(entry.id, entry.orderKey, deduplicated[index]!.edge ?? entry.edge));
        return result({ generation, coverage, entries }, detachedIds);
      }
      const keys = keysForSequence(deduplicated.length);
      const entries = deduplicated.map((row, index) => scopeEntry(row.id, row.orderKey ?? keys[index]!, row.edge));
      return result({ generation, coverage, entries: [...entries].sort(compareEntries) }, detachedIds);
    }

    if (coverage === 'page' && opts?.resetOrder) {
      const incomingById = new Map(deduplicated.map(row => [row.id, row] as const));
      const head = deduplicated;
      const tail = previous.entries.filter(entry => !incomingById.has(entry.id));
      if (arraysShallowEqual(previous.entries, [...head.map(row => row.id), ...tail.map(entry => entry.id)], (entry, id) => entry.id === id)) {
        const entries = previous.entries.map(entry => scopeEntry(entry.id, entry.orderKey, incomingById.get(entry.id)?.edge ?? entry.edge));
        return result({ generation, coverage: retainedCoverage, entries }, []);
      }
      const headKeys = keysForSequence(head.length, undefined, tail[0]?.orderKey);
      const headEntries = head.map((row, index) => scopeEntry(row.id, headKeys[index]!, row.edge ?? previousById.get(row.id)?.edge));
      return result({ generation, coverage: retainedCoverage, entries: [...headEntries, ...tail] }, []);
    }

    const keyed: ScopeEntry[] = [];
    const keyless: IncomingScopeRow[] = [];
    for (const row of deduplicated) {
      const existing = previousById.get(row.id);
      if (row.orderKey !== undefined) keyed.push(scopeEntry(row.id, row.orderKey, row.edge ?? existing?.edge));
      else if (existing) keyed.push(scopeEntry(existing.id, existing.orderKey, row.edge ?? existing.edge));
      else keyless.push(row);
    }
    const afterKeyed = mergeByKey(previous.entries, keyed);
    const tailKeys = keysForSequence(keyless.length, afterKeyed.at(-1)?.orderKey);
    const entries = [...afterKeyed, ...keyless.map((row, index) => scopeEntry(row.id, tailKeys[index]!, row.edge))];
    return result({ generation, coverage: retainedCoverage, entries }, []);
  };

  const trimValue = (value: ScopeIndexValue, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] } => {
    if (value.entries.length <= maxRows) return { next: value, trimmedIds: [] };
    return {
      next: { generation: value.generation + 1, coverage: value.coverage, entries: value.entries.slice(0, maxRows) },
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
        if (value === null) removeCommitted(key);
        else commit(key, value);
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
      const members = stagedScopes ? new Set(previous.entries.map(entry => entry.id)) : memberSets.get(key);
      const pureAppend =
        removal.size === 0 &&
        append.every(entry => !members?.has(entry.id)) &&
        (base.length === 0 || append.every(entry => compareCodepoints(entry.orderKey, base.at(-1)!.orderKey) > 0));
      const entries = pureAppend ? [...base, ...[...append].sort(compareEntries)] : mergeByKey(base, append);
      const next = { generation: previous.generation + 1, coverage: previous.coverage, entries };
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
        if (value === null) keys.delete(key);
        else keys.add(key);
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
      const touched = new Set<string>();
      for (const id of ids) {
        for (const key of keysByRow.get(id) ?? []) touched.add(key);
      }
      return [...touched];
    },
    persistEntries: () => {
      const entries: Array<{ key: string; value: string | null }> = [...dirty].map(key => ({ key: storageKey(key), value: encodePersistence(scopes.get(key) ?? empty()) }));
      for (const key of removed) entries.push({ key: storageKey(key), value: null });
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
        const encoded = parseCompositeKey(fullKey.slice(storagePrefix().length));
        const key = encoded?.length === 1 ? encoded[0] : undefined;
        const raw = storage.get(fullKey);
        if (!raw) continue;
        /** A key that does not belong to a declared scope (renamed/removed scope, foreign format) is stale state: drop it as corrupt. */
        const scopeParts = key === undefined ? undefined : parseCompositeKey(key);
        const declared =
          scopeParts?.length === 2 && isNonEmptyString(scopeParts[0]) && isNonEmptyString(scopeParts[1]) && (scopeNames === undefined || scopeNames.includes(scopeParts[0]));
        const value = declared ? decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isScopeIndexValue) : undefined;
        if (key !== undefined && value) {
          scopes.set(key, value);
          accessTimes.set(key, Date.now());
        } else {
          storage.set([{ key: fullKey, value: null }]);
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
      accessTimes.clear();
    }
  };
};

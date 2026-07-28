import type { StoragePlane , IncomingScopeRow, ReconcileResult, ScopeCoverage, ScopeEntry, ScopeIndex, ScopeIndexValue } from '../../types';
import { noteDataLoss } from '../diagnostics';
import { compareCodepoints, compositeKey } from '../serialize';
import { keysForSequence } from '../orderKey';
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from '../persistenceCodec';
import { isRecord } from '../../utils/normalizeHelpers';

const isScopeIndexValue = (value: unknown): value is ScopeIndexValue =>
  isRecord(value) &&
  typeof value.generation === 'number' &&
  (value.coverage === 'delta' || value.coverage === 'page' || value.coverage === 'complete') &&
  Array.isArray(value.entries) &&
  value.entries.every(entry => isRecord(entry) && typeof entry.id === 'string' && typeof entry.orderKey === 'string' && (entry.edge === undefined || isRecord(entry.edge)));

const compareEntries = (left: ScopeEntry, right: ScopeEntry): number => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.id, right.id);

const sameIdSequence = (previous: ScopeEntry[], nextIds: readonly string[]): boolean => {
  if (previous.length !== nextIds.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]!.id !== nextIds[index]) return false;
  }
  return true;
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
  const empty = (): ScopeIndexValue => ({ generation: 0, coverage: 'delta', entries: [] });
  const storageKey = (key: string) => `${prefix()}scope:${modelId}:${key}`;

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
    return sameIdSequence(previous, next.map(entry => entry.id));
  };

  const commit = (key: string, next: ScopeIndexValue, fastAdd?: string[]): ScopeIndexValue => {
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

  const reconcileNext = (key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult => {
    const previous = scopes.get(key) ?? empty();
    const generation = previous.generation + 1;
    const previousById = new Map(previous.entries.map(entry => [entry.id, entry] as const));
    const retainedCoverage = previous.coverage === 'complete' ? 'complete' : coverage;

    if (coverage === 'complete') {
      /** Complete snapshots deduplicate like delta/page: the last payload occurrence supplies the retained entry. */
      const incomingById = new Map<string, IncomingScopeRow>();
      for (const row of incoming) incomingById.set(row.id, row);
      const deduplicated = [...incomingById.values()];
      const incomingIds = new Set(deduplicated.map(row => row.id));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
      if (sameIdSequence(previous.entries, deduplicated.map(row => row.id))) {
        const entries = previous.entries.map((entry, index) => ({ ...entry, edge: deduplicated[index]!.edge ?? entry.edge }));
        return { next: { generation, coverage, entries }, detachedIds };
      }
      const keys = keysForSequence(deduplicated.length);
      const entries = deduplicated.map((row, index) => ({ id: row.id, orderKey: row.orderKey ?? keys[index]!, edge: row.edge }));
      return { next: { generation, coverage, entries: [...entries].sort(compareEntries) }, detachedIds };
    }

    if (coverage === 'page' && opts?.resetOrder) {
      const incomingById = new Map<string, IncomingScopeRow>();
      for (const row of incoming) incomingById.set(row.id, row);
      const head = [...incomingById.values()];
      const tail = previous.entries.filter(entry => !incomingById.has(entry.id));
      if (sameIdSequence(previous.entries, [...head.map(row => row.id), ...tail.map(entry => entry.id)])) {
        const entries = previous.entries.map(entry => ({ ...entry, edge: incomingById.get(entry.id)?.edge ?? entry.edge }));
        return { next: { generation, coverage: retainedCoverage, entries }, detachedIds: [] };
      }
      const headKeys = keysForSequence(head.length, undefined, tail[0]?.orderKey);
      const headEntries = head.map((row, index) => ({ id: row.id, orderKey: headKeys[index]!, edge: row.edge ?? previousById.get(row.id)?.edge }));
      return { next: { generation, coverage: retainedCoverage, entries: [...headEntries, ...tail] }, detachedIds: [] };
    }

    const keyed: ScopeEntry[] = [];
    const keyless: IncomingScopeRow[] = [];
    for (const row of incoming) {
      const existing = previousById.get(row.id);
      if (row.orderKey !== undefined) keyed.push({ id: row.id, orderKey: row.orderKey, edge: row.edge ?? existing?.edge });
      else if (existing) keyed.push({ ...existing, edge: row.edge ?? existing.edge });
      else keyless.push(row);
    }
    const afterKeyed = mergeByKey(previous.entries, keyed);
    const tailKeys = keysForSequence(keyless.length, afterKeyed.at(-1)?.orderKey);
    const entries = [...afterKeyed, ...keyless.map((row, index) => ({ id: row.id, orderKey: tailKeys[index]!, edge: row.edge }))];
    return { next: { generation, coverage: retainedCoverage, entries }, detachedIds: [] };
  };

  const trimValue = (value: ScopeIndexValue, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] } => {
    if (value.entries.length <= maxRows) return { next: value, trimmedIds: [] };
    return {
      next: { generation: value.generation + 1, coverage: value.coverage, entries: value.entries.slice(0, maxRows) },
      trimmedIds: value.entries.slice(maxRows).map(entry => entry.id)
    };
  };

  return {
    read: key => scopes.get(key) ?? empty(),
    write: (key, next) => {
      commit(key, next);
    },
    reconcileNext,
    applyDelta: (key, append, detach) => {
      const previous = scopes.get(key) ?? empty();
      const removal = new Set(detach);
      const base = removal.size > 0 ? previous.entries.filter(entry => !removal.has(entry.id)) : previous.entries;
      const members = memberSets.get(key);
      const pureAppend =
        removal.size === 0 &&
        append.every(entry => !members?.has(entry.id)) &&
        (base.length === 0 || append.every(entry => compareCodepoints(entry.orderKey, base.at(-1)!.orderKey) > 0));
      const entries = pureAppend ? [...base, ...[...append].sort(compareEntries)] : mergeByKey(base, append);
      const next = { generation: previous.generation + 1, coverage: previous.coverage, entries };
      return commit(key, next, pureAppend ? append.map(entry => entry.id) : undefined);
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
    trimValue,
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
        const declared = scopeNames === undefined || scopeNames.some(scopeName => key.startsWith(compositeKey(scopeName, '')));
        const value = declared ? decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isScopeIndexValue) : undefined;
        if (value) {
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
      scopes.clear();
      dirty.clear();
      removed.clear();
      memberSets.clear();
      keysByRow.clear();
      accessTimes.clear();
    }
  };
};

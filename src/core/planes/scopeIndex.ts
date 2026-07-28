import type { StoragePlane , IncomingScopeRow, ReconcileResult, ScopeCoverage, ScopeEntry, ScopeIndex, ScopeIndexValue } from '../../types';
import { noteDataLoss, noteScopeKeyMigration } from '../diagnostics';
import { compositeKey } from '../serialize';
import { sortBy } from 'es-toolkit';

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

  const boundaryAddFor = (
    key: string,
    previous: ScopeIndexValue,
    coverage: ScopeCoverage,
    incoming: IncomingScopeRow[],
    opts?: { resetOrder?: boolean }
  ): { side: 'head' | 'tail'; ids: string[] } | undefined => {
    if ((coverage !== 'delta' && coverage !== 'page') || opts?.resetOrder || incoming.some(row => typeof row.order !== 'number')) return undefined;
    const members = memberSets.get(key);
    if (incoming.some(row => members?.has(row.id))) return undefined;
    if (previous.entries.length === 0) return { side: 'tail', ids: incoming.map(row => row.id) };
    const headOrder = previous.entries[0]!.order;
    const tailOrder = previous.entries.at(-1)!.order;
    if (incoming.every(row => row.order! < headOrder)) return { side: 'head', ids: incoming.map(row => row.id) };
    if (incoming.every(row => row.order! > tailOrder)) return { side: 'tail', ids: incoming.map(row => row.id) };
    return undefined;
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
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index]!.id !== next[index]!.id) return false;
    }
    return true;
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

  const reconcileNext = (key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult => {
    const previous = scopes.get(key) ?? empty();
    const generation = previous.generation + 1;
    const boundaryAdd = boundaryAddFor(key, previous, coverage, incoming, opts);

    if (boundaryAdd) {
      const sortedIncoming = sortBy(incoming, [row => row.order, row => row.id]).map(row => ({ id: row.id, order: row.order!, seq: generation, edge: row.edge }));
      const entries = boundaryAdd.side === 'head' ? [...sortedIncoming, ...previous.entries] : [...previous.entries, ...sortedIncoming];
      return { next: { generation, coverage: previous.coverage === 'complete' ? 'complete' : coverage, entries }, detachedIds: [] };
    }

    if (coverage === 'complete') {
      /** Complete snapshots deduplicate like delta/page: the last payload occurrence supplies the retained entry. */
      const incomingById = new Map<string, IncomingScopeRow>();
      for (const row of incoming) incomingById.set(row.id, row);
      const deduplicated = [...incomingById.values()];
      const incomingIds = new Set(deduplicated.map(row => row.id));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
      const entries = deduplicated.map((row, index) => ({ id: row.id, order: row.order ?? index, seq: generation + index, edge: row.edge }));
      return { next: { generation, coverage, entries }, detachedIds };
    }

    if (coverage === 'page' && opts?.resetOrder) {
      const previousById = new Map(previous.entries.map(entry => [entry.id, entry] as const));
      const incomingIds = new Set(incoming.map(row => row.id));
      const head = incoming.map((row, order) => ({ id: row.id, order, seq: generation, edge: row.edge ?? previousById.get(row.id)?.edge }));
      const tail = previous.entries
        .filter(entry => !incomingIds.has(entry.id))
        .sort((a, b) => a.order - b.order)
        .map((entry, index) => ({ ...entry, order: incoming.length + index }));
      return { next: { generation, coverage: previous.coverage === 'complete' ? 'complete' : coverage, entries: [...head, ...tail] }, detachedIds: [] };
    }

    const byId = new Map(previous.entries.map(entry => [entry.id, entry] as const));
    let appendOrder = previous.entries.reduce((max, entry) => Math.max(max, entry.order), -1) + 1;
    for (const row of incoming) {
      const existing = byId.get(row.id);
      if (existing) {
        byId.set(row.id, { ...existing, order: row.order ?? existing.order, seq: generation, edge: row.edge ?? existing.edge });
      } else {
        const order = row.order ?? appendOrder;
        byId.set(row.id, { id: row.id, order, seq: generation, edge: row.edge });
        appendOrder = Math.max(appendOrder, order + 1);
      }
    }
    const entries = [...byId.values()].sort((a, b) => a.order - b.order);
    return { next: { generation, coverage: previous.coverage === 'complete' ? 'complete' : coverage, entries }, detachedIds: [] };
  };

  const trimValue = (value: ScopeIndexValue, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] } => {
    if (value.entries.length <= maxRows) return { next: value, trimmedIds: [] };
    return {
      next: { generation: value.generation + 1, coverage: value.coverage, entries: value.entries.slice(0, maxRows) },
      trimmedIds: value.entries.slice(maxRows).map(entry => entry.id)
    };
  };

  const trimNext = (key: string, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] } => trimValue(scopes.get(key) ?? empty(), maxRows);

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
      return { next: commit(key, result.next, boundaryAdd?.ids), detachedIds: result.detachedIds };
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
      const touched = new Set<string>();
      for (const id of ids) {
        for (const key of keysByRow.get(id) ?? []) touched.add(key);
      }
      return [...touched];
    },
    persistEntries: () => {
      const entries: Array<{ key: string; value: string | null }> = [...dirty].map(key => ({ key: storageKey(key), value: JSON.stringify(scopes.get(key) ?? empty()) }));
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
      const loaded = new Map<string, { raw: string; value: ScopeIndexValue; canonical: boolean }>();
      const migrated = new Map<string, string>();
      const orderedScopeNames = [...(scopeNames ?? [])].sort((left, right) => right.length - left.length);
      for (const fullKey of storage.keys(storageKey(''))) {
        const persistedKey = fullKey.slice(storageKey('').length);
        const canonicalScopeName = orderedScopeNames.find(scopeName => persistedKey.startsWith(compositeKey(scopeName, '')));
        const colonDelimitedScopeName = canonicalScopeName ? undefined : orderedScopeNames.find(scopeName => persistedKey.startsWith(`${scopeName}:`));
        const key = canonicalScopeName
          ? persistedKey
          : colonDelimitedScopeName
            ? compositeKey(colonDelimitedScopeName, persistedKey.slice(colonDelimitedScopeName.length + 1))
            : null;
        if (!key) {
          storage.set([{ key: fullKey, value: null }]);
          noteDataLoss('corrupt-scope', modelId, 1);
          continue;
        }
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          const entry = { raw, value: JSON.parse(raw) as ScopeIndexValue, canonical: canonicalScopeName !== undefined };
          const existing = loaded.get(key);
          if (!existing || entry.canonical) loaded.set(key, entry);
          if (colonDelimitedScopeName) migrated.set(fullKey, key);
        } catch {
          storage.set([{ key: fullKey, value: null }]);
          noteDataLoss('corrupt-scope', modelId, 1);
        }
      }
      for (const [key, entry] of loaded) {
        scopes.set(key, entry.value);
        accessTimes.set(key, Date.now());
      }
      if (migrated.size > 0) {
        const entries: Array<{ key: string; value: string | null }> = [];
        const migratedKeys = new Set(migrated.values());
        for (const key of migratedKeys) {
          const entry = loaded.get(key)!;
          if (!entry.canonical) entries.push({ key: storageKey(key), value: entry.raw });
        }
        for (const fullKey of migrated.keys()) entries.push({ key: fullKey, value: null });
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

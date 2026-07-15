import type { StoragePlane } from './storagePlane';

export type Coverage = 'complete' | 'page' | 'delta';

export type ScopeEntry = { id: string; order: number; seq: number; edge?: Record<string, unknown> };

export type ScopeIndexValue = { generation: number; coverage: Coverage; entries: ScopeEntry[] };

export type IncomingScopeRow = { id: string; edge?: Record<string, unknown>; order?: number };

export type ReconcileResult = { next: ScopeIndexValue; detachedIds: string[] };

export type ScopeIndex = {
  read(key: string): ScopeIndexValue;
  write(key: string, next: ScopeIndexValue): void;
  /**
   * Reconcile a server response against the scope membership ledger.
   * - 'complete': incoming rows become the exact membership in server order; previous members
   *   absent from the response are DETACHED (returned in detachedIds; entity rows untouched).
   * - 'page': incoming rows upsert into membership (existing keep their order, new append in
   *   server order); nothing is detached.
   *   With opts.resetOrder (a first-page refetch) incoming rows become the new head order and previous members keep relative order after them.
   * - 'delta': same merge semantics as 'page' (single-row/subscription-driven updates).
   */
  reconcile(key: string, coverage: Coverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult;
  reconcileNext(key: string, coverage: Coverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult;
  detach(key: string, ids: string[]): ScopeIndexValue;
  trim(key: string, maxRows: number): string[];
  trimValue(value: ScopeIndexValue, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] };
  trimNext(key: string, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] };
  /** Drop a scope key entirely (GC of empty/dead scopes); persisted entry is deleted on next flush. */
  remove(key: string): void;
  keys(): string[];
  /** O(1) membership check backed by the derived member index. */
  has(key: string, id: string): boolean;
  /** All scope keys containing the row - the reverse membership index. */
  keysOf(id: string): string[];
  persistEntries(): Array<{ key: string; value: string | null }>;
  hydrate(): void;
  reset(): void;
};

export const createScopeIndex = (options: { modelId: string; scopeNames?: string[]; storage: StoragePlane; prefix: () => string }): ScopeIndex => {
  const { modelId, scopeNames, storage, prefix } = options;
  const scopes = new Map<string, ScopeIndexValue>();
  const dirty = new Set<string>();
  const removed = new Set<string>();
  const memberSets = new Map<string, Set<string>>();
  const keysByRow = new Map<string, Set<string>>();
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

  const commit = (key: string, next: ScopeIndexValue): ScopeIndexValue => {
    removed.delete(key);
    indexCommit(key, scopes.get(key), next);
    scopes.set(key, next);
    dirty.add(key);
    return next;
  };

  const reconcileNext = (key: string, coverage: Coverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult => {
    const previous = scopes.get(key) ?? empty();
    const generation = previous.generation + 1;

    if (coverage === 'complete') {
      const incomingIds = new Set(incoming.map(row => row.id));
      const detachedIds = previous.entries.filter(entry => !incomingIds.has(entry.id)).map(entry => entry.id);
      const entries = incoming.map((row, index) => ({ id: row.id, order: row.order ?? index, seq: generation, edge: row.edge }));
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
      const result = reconcileNext(key, coverage, incoming, opts);
      return { next: commit(key, result.next), detachedIds: result.detachedIds };
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
    },
    keys: () => [...scopes.keys()],
    has: (key, id) => memberSets.get(key)?.has(id) ?? false,
    keysOf: id => [...(keysByRow.get(id) ?? [])],
    persistEntries: () => {
      const entries: Array<{ key: string; value: string | null }> = [...dirty].map(key => ({ key: storageKey(key), value: JSON.stringify(scopes.get(key) ?? empty()) }));
      dirty.clear();
      for (const key of removed) entries.push({ key: storageKey(key), value: null });
      removed.clear();
      return entries;
    },
    hydrate: () => {
      scopes.clear();
      dirty.clear();
      removed.clear();
      memberSets.clear();
      keysByRow.clear();
      for (const fullKey of storage.keys(storageKey(''))) {
        const key = fullKey.slice(storageKey('').length);
        if (scopeNames !== undefined && !scopeNames.some(scopeName => key.startsWith(`${scopeName}:`))) {
          storage.set([{ key: fullKey, value: null }]);
          continue;
        }
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          scopes.set(key, JSON.parse(raw) as ScopeIndexValue);
        } catch {
          storage.set([{ key: fullKey, value: null }]);
        }
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
    }
  };
};

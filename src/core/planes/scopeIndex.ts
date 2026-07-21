import type { StoragePlane } from './storagePlane';
import { sortBy } from 'es-toolkit';

export type ScopeCoverage = 'complete' | 'page' | 'delta';

type ScopeEntry = { id: string; order: number; seq: number; edge?: Record<string, unknown> };

export type ScopeIndexValue = { generation: number; coverage: ScopeCoverage; entries: ScopeEntry[] };

type IncomingScopeRow = { id: string; edge?: Record<string, unknown>; order?: number };

type ReconcileResult = { next: ScopeIndexValue; detachedIds: string[] };

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
  reconcile(key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult;
  reconcileNext(key: string, coverage: ScopeCoverage, incoming: IncomingScopeRow[], opts?: { resetOrder?: boolean }): ReconcileResult;
  detach(key: string, ids: string[]): ScopeIndexValue;
  trim(key: string, maxRows: number): string[];
  trimValue(value: ScopeIndexValue, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] };
  trimNext(key: string, maxRows: number): { next: ScopeIndexValue; trimmedIds: string[] };
  /** Drop a scope key entirely (GC of empty/dead scopes); persisted entry is deleted on next flush. */
  remove(key: string): void;
  keys(): string[];
  /** Record an in-memory read timestamp for one scope key. */
  noteAccess(key: string): void;
  /** Return the most recent in-memory read timestamp for one scope key. */
  lastAccess(key: string): number | undefined;
  /** O(1) membership check backed by the derived member index. */
  has(key: string, id: string): boolean;
  /** All scope keys containing the row - the reverse membership index. */
  keysOf(id: string): string[];
  /** Ephemeral read revision used by reactive scope subscribers; never persisted. */
  reactiveEpoch(key: string): number;
  orderRevision(key: string): number;
  /** Bump the revisions of scopes that currently contain one of these rows. */
  touchMembers(ids: string[]): string[];
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
  const reactiveEpochs = new Map<string, number>();
  const orderRevisions = new Map<string, number>();
  const accessTimes = new Map<string, number>();
  const empty = (): ScopeIndexValue => ({ generation: 0, coverage: 'delta', entries: [] });
  const storageKey = (key: string) => `${prefix()}scope:${modelId}:${key}`;
  const touch = (key: string): void => {
    reactiveEpochs.set(key, (reactiveEpochs.get(key) ?? 0) + 1);
  };

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
      const previous = scopes.get(key) ?? empty();
      const boundaryAdd = boundaryAddFor(key, previous, coverage, incoming, opts);
      const result = reconcileNext(key, coverage, incoming, opts);
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
      const touched = new Set<string>();
      for (const id of ids) {
        for (const key of keysByRow.get(id) ?? []) touched.add(key);
      }
      for (const key of touched) touch(key);
      return [...touched];
    },
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
      reactiveEpochs.clear();
      accessTimes.clear();
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
          accessTimes.set(key, Date.now());
        } catch {
          storage.set([{ key: fullKey, value: null }]);
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

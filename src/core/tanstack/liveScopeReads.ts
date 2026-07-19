import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ApplyTarget } from '../apply/transaction';
import { getCommitBus } from '../../dsl/configure';
import { arraysShallowEqual, rowsShallowEqual } from '../../read/useLiveRead';
import { createProjectionGate, type ProjectionOptions, validateProjectionOptions } from '../../read/projectionGate';
import { createLiveQueryCollection, ensureMembershipCollection, ensureModelCollection, eq, registerLiveScopeReadReset, type StoredRowShape } from './facade';

type ScopeSortMeta = ReturnType<ApplyTarget[`scopeSortMeta`]>;
type LiveQuery = ReturnType<typeof createLiveQueryCollection>;
type ScopeLiveEntry = {
  scopeKey: string;
  liveQuery: LiveQuery;
  subscription: { unsubscribe(): void };
  scopeSubscription: { unsubscribe(): void };
  refCount: number;
  snapshot: StoredRowShape[];
  rowCache: Map<string, StoredRowShape>;
  sourceCache: WeakMap<StoredRowShape, StoredRowShape>;
  listeners: Set<() => void>;
};
type ScopeLiveWindowSnapshot = { rows: StoredRowShape[]; totalCount: number };

const EMPTY_ROWS: StoredRowShape[] = [];
const entries = new Map<string, ScopeLiveEntry>();

/** Returns internal shared-live-query registry totals for contract tests. */
export function getScopeLiveReadRegistryStats(): { entryCount: number; refCount: number } {
  return {
    entryCount: entries.size,
    refCount: [...entries.values()].reduce((count, entry) => count + entry.refCount, 0)
  };
}

const plainRow = (row: StoredRowShape): StoredRowShape => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith(`$`))) as StoredRowShape;

const updateSnapshot = (entry: ScopeLiveEntry): void => {
  const sourceRows = entry.liveQuery.toArray as StoredRowShape[];
  const next = sourceRows.map(source => {
    const cached = entry.sourceCache.get(source);
    if (cached) return cached;
    const row = plainRow(source);
    const current = entry.rowCache.get(row.id);
    const resolved = current && rowsShallowEqual(current, row) ? current : row;
    entry.rowCache.set(row.id, resolved);
    entry.sourceCache.set(source, resolved);
    return resolved;
  });
  if (arraysShallowEqual(entry.snapshot, next)) {
    return;
  }
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
};

const notifyEmptyScope = (entry: ScopeLiveEntry): void => {
  if (entry.snapshot.length !== 0 || entry.liveQuery.toArray.length !== 0) return;
  entry.snapshot = [];
  for (const listener of entry.listeners) listener();
};

const entryKey = (modelId: string, scopeKey: string): string => `${modelId}\0${scopeKey}`;

const createEntry = (modelId: string, scopeKey: string, sortMeta: ScopeSortMeta): ScopeLiveEntry => {
  const memberships = ensureMembershipCollection(modelId);
  const entities = ensureModelCollection(modelId);
  const liveQuery = createLiveQueryCollection(query => {
    const joined = query
      .from({ membership: memberships })
      .where(({ membership }) => eq(membership.scopeKey, scopeKey))
      .join({ entity: entities }, ({ membership, entity }) => eq(membership.rowId, entity.id));
    if (sortMeta.kind === `field`) {
      return joined
        .orderBy(({ membership }) => membership.sortValue, sortMeta.dir)
        .orderBy(({ membership }) => membership.rowId)
        .select(({ entity }) => ({ ...entity }));
    }
    return joined.orderBy(({ membership }) => membership.seq).select(({ entity }) => ({ ...entity }));
  });
  const entry = {
    scopeKey,
    liveQuery,
    subscription: null as unknown as { unsubscribe(): void },
    scopeSubscription: null as unknown as { unsubscribe(): void },
    refCount: 0,
    snapshot: EMPTY_ROWS,
    rowCache: new Map<string, StoredRowShape>(),
    sourceCache: new WeakMap<StoredRowShape, StoredRowShape>(),
    listeners: new Set<() => void>()
  } satisfies ScopeLiveEntry;
  entry.subscription = liveQuery.subscribeChanges(() => updateSnapshot(entry));
  entry.scopeSubscription = getCommitBus().subscribeIncremental(
    () => notifyEmptyScope(entry),
    [{ kind: `scope`, model: modelId, scopeKey }],
    () => undefined
  );
  updateSnapshot(entry);
  return entry;
};

const entryFor = (modelId: string, scopeKey: string, sortMeta: ScopeSortMeta): ScopeLiveEntry => {
  const key = entryKey(modelId, scopeKey);
  const current = entries.get(key);
  if (current) return current;
  const entry = createEntry(modelId, scopeKey, sortMeta);
  entries.set(key, entry);
  return entry;
};

const releaseEntry = (modelId: string, scopeKey: string, entry: ScopeLiveEntry): void => {
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.subscription.unsubscribe();
  entry.scopeSubscription.unsubscribe();
  void entry.liveQuery.cleanup();
  if (entries.get(entryKey(modelId, scopeKey)) === entry) entries.delete(entryKey(modelId, scopeKey));
};

const clearEntries = (): void => {
  const staleEntries = [...entries.values()];
  entries.clear();
  for (const entry of staleEntries) {
    entry.snapshot = [];
    entry.rowCache.clear();
    entry.sourceCache = new WeakMap<StoredRowShape, StoredRowShape>();
    for (const listener of entry.listeners) listener();
    entry.subscription.unsubscribe();
    entry.scopeSubscription.unsubscribe();
    void entry.liveQuery.cleanup();
  }
};

registerLiveScopeReadReset(clearEntries);

/**
 * Reads one scope through a shared TanStack live query projection.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @returns Ordered stored rows with stable identities until their content changes.
 */
export function useScopeLiveRows<TOutput extends Record<string, unknown> = StoredRowShape>(
  modelId: string,
  scopeKey: string | null,
  sortMeta: ScopeSortMeta,
  options: ProjectionOptions<StoredRowShape, TOutput> = {}
): TOutput[] {
  validateProjectionOptions(options, `${modelId}.scope.use`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<StoredRowShape, TOutput>());
  optionsRef.current = options;
  const { entry, subscribe } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const getSnapshot = useCallback(
    () => gateRef.current.projectRows(scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot, optionsRef.current),
    [modelId, scopeKey, sortMeta]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Reads a stable local window from one shared TanStack live query projection.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @param windowSize Number of leading rows included in the local window.
 * @returns Stable window rows and the complete shared scope count.
 */
export function useScopeLiveWindowRows(
  modelId: string,
  scopeKey: string | null,
  sortMeta: ScopeSortMeta,
  windowSize: number,
  options: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}
): ScopeLiveWindowSnapshot {
  validateProjectionOptions(options, `${modelId}.scope.useWindow`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<StoredRowShape, Record<string, unknown>>());
  optionsRef.current = options;
  const { subscribe } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const windowRef = useRef<{ source: StoredRowShape[]; size: number; snapshot: ScopeLiveWindowSnapshot }>({
    source: EMPTY_ROWS,
    size: 0,
    snapshot: { rows: EMPTY_ROWS, totalCount: 0 }
  });
  const getSnapshot = useCallback(() => {
    const stored = scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot;
    const source = gateRef.current.projectRows(stored, optionsRef.current) as StoredRowShape[];
    if (windowRef.current.source === source && windowRef.current.size === windowSize) return windowRef.current.snapshot;
    const rows = source.slice(0, windowSize);
    const previous = windowRef.current.snapshot;
    if (previous.totalCount === source.length && arraysShallowEqual(previous.rows, rows)) {
      windowRef.current = { source, size: windowSize, snapshot: previous };
      return previous;
    }
    const snapshot = { rows, totalCount: source.length };
    windowRef.current = { source, size: windowSize, snapshot };
    return snapshot;
  }, [modelId, scopeKey, sortMeta, windowSize]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const useScopeLiveEntry = (modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta) => {
  const entry = scopeKey == null ? null : entryFor(modelId, scopeKey, sortMeta);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!entry || scopeKey == null) return () => undefined;
      entry.refCount += 1;
      entry.listeners.add(onStoreChange);
      return () => {
        entry.listeners.delete(onStoreChange);
        releaseEntry(modelId, scopeKey, entry);
      };
    },
    [entry, modelId, scopeKey]
  );
  return { entry, subscribe };
};

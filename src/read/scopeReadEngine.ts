import { useCallback, useRef, useSyncExternalStore } from 'react';
import { getApplyTarget } from '../core/apply/transaction';
import { noteScopeReadPass } from '../core/diagnostics';
import { getCommitBus, getRuntimeGeneration } from '../dsl/configure';
import { engineScopeCollection } from '../engine/EngineAdapter';
import type { EngineScopeChange, EngineScopeRow , ProjectionOptions } from '../types';
import { createProjectionGate, validateProjectionOptions } from './projectionGate';
import { hasRequiredFields } from './requireFields';
import { useScopeRetention } from './scopeRetention';
import { incrementalSignature } from './incrementalReadEngine';
import { arraysShallowEqual, rowsShallowEqual } from './useLiveRead';

type StoredRowShape = { id: string } & Record<string, unknown>;
type ScopeSortMeta = { kind: 'server-order' } | { kind: 'field'; field: string; dir: 'asc' | 'desc' } | { kind: 'comparator' };
type ScopeProjectionOptions<TOutput extends Record<string, unknown>> = ProjectionOptions<StoredRowShape, TOutput> & { keepPrevious?: boolean; require?: ReadonlyArray<string> };
type ScopeWindowSnapshot = { rows: StoredRowShape[]; totalCount: number; isPreviousData: boolean; resolved: boolean };
type RequireGate = { source: StoredRowShape[] | null; require: ReadonlyArray<string> | undefined; result: StoredRowShape[] };

const EMPTY_ROWS: StoredRowShape[] = [];

type ScopeReadWorkSnapshot = { fullRows: number; incrementalRows: number };

const scopeReadWork: ScopeReadWorkSnapshot = { fullRows: 0, incrementalRows: 0 };

const scopeReadWorkGlobal = {
  snapshot: (): ScopeReadWorkSnapshot => ({ ...scopeReadWork }),
  reset: (): void => {
    scopeReadWork.fullRows = 0;
    scopeReadWork.incrementalRows = 0;
  }
};

(globalThis as Record<string, unknown>).__DBLAYER_SCOPE_READ_WORK__ = scopeReadWorkGlobal;

const noteScopeReadWork = (kind: keyof ScopeReadWorkSnapshot, count: number): void => {
  scopeReadWork[kind] += count;
};

const requireFilteredRows = (rows: StoredRowShape[], require: ReadonlyArray<string> | undefined): StoredRowShape[] => {
  if (!require || require.length === 0) return rows;
  const filtered = rows.filter(row => hasRequiredFields(row, require));
  return filtered.length === rows.length ? rows : filtered;
};

const readRequireGate = (cache: { current: RequireGate }, source: StoredRowShape[], require: ReadonlyArray<string> | undefined): StoredRowShape[] => {
  const current = cache.current;
  if (current.source === source && current.require === require) return current.result;
  const result = requireFilteredRows(source, require);
  cache.current = { source, require, result };
  return result;
};

const createScopeReadEngine = (modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta) => {
  const rowCache = new Map<string, StoredRowShape>();
  const sourceCache = new WeakMap<StoredRowShape, StoredRowShape>();
  const source = scopeKey == null ? null : engineScopeCollection(modelId, scopeKey);
  let entries: EngineScopeRow[] = [];
  let rows = EMPTY_ROWS;
  let revision = scopeKey == null ? 0 : getApplyTarget(modelId).readScopeOrderRevision(scopeKey);
  const resolveRow = (sourceRow: StoredRowShape, kind: keyof ScopeReadWorkSnapshot): StoredRowShape => {
    const cached = sourceCache.get(sourceRow);
    if (cached) return cached;
    const next = Object.fromEntries(Object.entries(sourceRow).filter(([key]) => !key.startsWith('$') && key !== 'orderKey')) as StoredRowShape;
    const current = rowCache.get(next.id);
    const resolved = current && rowsShallowEqual(current, next) ? current : next;
    if (resolved !== current) noteScopeReadWork(kind, 1);
    rowCache.set(next.id, resolved);
    sourceCache.set(sourceRow, resolved);
    return resolved;
  };
  const compareEntries = (left: EngineScopeRow, right: EngineScopeRow): number =>
    left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : (left.id ?? '').localeCompare(right.id ?? '');
  const insertionIndex = (entry: EngineScopeRow): number => {
    let lower = 0;
    let upper = entries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (compareEntries(entries[middle]!, entry) < 0) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  };
  const isScopeRow = (entry: EngineScopeRow): entry is EngineScopeRow & { id: string } => typeof entry.id === 'string' && typeof entry.orderKey === 'string';
  const updateValue = (entry: EngineScopeRow, kind: keyof ScopeReadWorkSnapshot): boolean => {
    if (!isScopeRow(entry)) return false;
    const currentIndex = entries.findIndex(current => current.id === entry.id);
    const previousEntry = currentIndex < 0 ? undefined : entries[currentIndex]!;
    const previousRow = currentIndex < 0 ? undefined : rows[currentIndex]!;
    if (currentIndex >= 0) {
      entries.splice(currentIndex, 1);
      rows = [...rows.slice(0, currentIndex), ...rows.slice(currentIndex + 1)];
    }
    const nextRow = resolveRow(entry as StoredRowShape, kind);
    const nextIndex = insertionIndex(entry);
    entries.splice(nextIndex, 0, entry);
    rows = [...rows.slice(0, nextIndex), nextRow, ...rows.slice(nextIndex)];
    return previousEntry?.orderKey !== entry.orderKey || previousRow !== nextRow || currentIndex !== nextIndex;
  };
  const removeValue = (key: string | number): boolean => {
    const index = entries.findIndex(entry => entry.id === String(key));
    if (index < 0) return false;
    const [entry] = entries.splice(index, 1);
    rows = [...rows.slice(0, index), ...rows.slice(index + 1)];
    rowCache.delete(entry!.id!);
    return true;
  };
  const publishRows = (): void => {
    engine.value = rows;
    engine.version += 1;
  };
  if (source) {
    entries = source.toArray().filter(isScopeRow);
    rows = entries.map(entry => resolveRow(entry as StoredRowShape, 'fullRows'));
  }
  const applyChanges = (changes: EngineScopeChange[]): boolean => {
    let changed = false;
    for (const change of changes) {
      const didChange = change.type === 'delete' ? removeValue(change.key) : updateValue(change.value, 'incrementalRows');
      changed ||= didChange;
    }
    if (changed) publishRows();
    return changed;
  };
  const reset = (): boolean => {
    if (rows.length === 0) return false;
    rowCache.clear();
    entries = [];
    rows = EMPTY_ROWS;
    publishRows();
    return true;
  };
  const engine = {
    signature: incrementalSignature('scope-read', modelId, scopeKey, sortMeta),
    generation: getRuntimeGeneration(),
    value: rows,
    version: 0,
    subscribe: (listener: () => void): (() => void) => {
      let notifiedSinceCommit = false;
      let forceCommitNotification = false;
      const releaseSource = source?.subscribe(changes => {
        const changed = applyChanges(changes);
        if (changed) {
          listener();
          notifiedSinceCommit = true;
        }
      }) ?? (() => {});
      if (scopeKey == null) return releaseSource;
      const subscription = getCommitBus().subscribeIncremental(
        () => {
          if (!notifiedSinceCommit || forceCommitNotification) listener();
          notifiedSinceCommit = false;
          forceCommitNotification = false;
        },
        [{ kind: 'scope', model: modelId, scopeKey }],
        batch => {
          if (batch === null) forceCommitNotification = reset();
          else {
            const nextRevision = getApplyTarget(modelId).readScopeOrderRevision(scopeKey);
            const orderChanged = nextRevision !== revision;
            revision = nextRevision;
            noteScopeReadPass(orderChanged, 0);
          }
        }
      );
      return () => {
        releaseSource();
        subscription.unsubscribe();
      };
    }
  };
  return engine;
};

const useScopeReadSnapshot = <TSnapshot,>(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, snapshot: (rows: StoredRowShape[]) => TSnapshot): TSnapshot => {
  const signature = incrementalSignature('scope-read', modelId, scopeKey, sortMeta);
  const engineRef = useRef<ReturnType<typeof createScopeReadEngine> | null>(null);
  if (!engineRef.current || engineRef.current.signature !== signature || engineRef.current.generation !== getRuntimeGeneration()) {
    engineRef.current = createScopeReadEngine(modelId, scopeKey, sortMeta);
  }
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const engine = engineRef.current;
  const subscribe = useCallback((listener: () => void) => engine.subscribe(listener), [engine]);
  const getSnapshot = useCallback(() => snapshotRef.current(engine.value), [engine]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export function useScopeReadRows<TOutput extends Record<string, unknown> = StoredRowShape>(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, isResolved: () => boolean, options: ScopeProjectionOptions<TOutput> = {}): TOutput[] {
  validateProjectionOptions(options, `${modelId}.scope.use`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<StoredRowShape, TOutput>());
  const storeRef = useRef<{ rows: TOutput[]; resolved: boolean }>({ rows: [], resolved: false });
  const requireGateRef = useRef<RequireGate>({ source: null, require: undefined, result: EMPTY_ROWS });
  optionsRef.current = options;
  const store = useScopeReadSnapshot(modelId, scopeKey, sortMeta, source => {
    const rows = gateRef.current.projectRows(readRequireGate(requireGateRef, source, optionsRef.current.require), optionsRef.current);
    const resolved = isResolved();
    if (storeRef.current.rows === rows && storeRef.current.resolved === resolved) return storeRef.current;
    storeRef.current = { rows, resolved };
    return storeRef.current;
  });
  return useScopeRetention(scopeKey, { rows: store.rows, totalCount: store.rows.length }, store.resolved, options.keepPrevious === true).snapshot.rows;
}

export function useScopeReadWindowRows(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, windowSize: number, isResolved: () => boolean, options: ScopeProjectionOptions<Record<string, unknown>> = {}): ScopeWindowSnapshot {
  validateProjectionOptions(options, `${modelId}.scope.useWindow`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<StoredRowShape, Record<string, unknown>>());
  const requireGateRef = useRef<RequireGate>({ source: null, require: undefined, result: EMPTY_ROWS });
  const windowRef = useRef<{ source: StoredRowShape[]; size: number; resolved: boolean; snapshot: ScopeWindowSnapshot }>({ source: EMPTY_ROWS, size: 0, resolved: false, snapshot: { rows: EMPTY_ROWS, totalCount: 0, isPreviousData: false, resolved: false } });
  optionsRef.current = options;
  const snapshot = useScopeReadSnapshot(modelId, scopeKey, sortMeta, stored => {
    const source = gateRef.current.projectRows(readRequireGate(requireGateRef, stored, optionsRef.current.require), optionsRef.current) as StoredRowShape[];
    const resolved = isResolved();
    if (windowRef.current.source === source && windowRef.current.size === windowSize && windowRef.current.resolved === resolved) return windowRef.current.snapshot;
    const rows = source.slice(0, windowSize);
    const previous = windowRef.current.snapshot;
    const next = previous.resolved === resolved && previous.totalCount === source.length && arraysShallowEqual(previous.rows, rows) ? previous : { rows, totalCount: source.length, isPreviousData: false, resolved };
    windowRef.current = { source, size: windowSize, resolved, snapshot: next };
    return next;
  });
  const retained = useScopeRetention(scopeKey, snapshot, snapshot.resolved, options.keepPrevious === true);
  return retained.snapshot === snapshot ? { rows: snapshot.rows, totalCount: snapshot.totalCount, isPreviousData: false, resolved: snapshot.resolved } : { ...retained.snapshot, isPreviousData: retained.isPreviousData, resolved: snapshot.resolved };
}

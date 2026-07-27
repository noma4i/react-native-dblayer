import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { CommitSubscription, IncrementalCommitBatch } from '../core/apply/commitBus';
import { getApplyTarget } from '../core/apply/transaction';
import { noteScopeReadPass } from '../core/diagnostics';
import { getCommitBus, getRuntimeGeneration } from '../dsl/configure';
import { createProjectionGate, type ProjectionOptions, validateProjectionOptions } from './projectionGate';
import { hasRequiredFields } from './requireFields';
import { useScopeRetention } from './scopeRetention';
import { incrementalSignature } from './incrementalReadEngine';
import { arraysShallowEqual, rowsShallowEqual } from './useLiveRead';

type StoredRowShape = { id: string } & Record<string, unknown>;
type ScopeSortMeta = { kind: 'server-order' } | { kind: 'field'; field: string; dir: 'asc' | 'desc' } | { kind: 'comparator' };
type ScopeProjectionOptions<TOutput extends Record<string, unknown>> = ProjectionOptions<StoredRowShape, TOutput> & {
  keepPrevious?: boolean;
  require?: ReadonlyArray<string>;
};
type ScopeWindowSnapshot = { rows: StoredRowShape[]; totalCount: number; isPreviousData: boolean; resolved: boolean };
type RequireGate = { source: StoredRowShape[] | null; require: ReadonlyArray<string> | undefined; result: StoredRowShape[] };

const EMPTY_ROWS: StoredRowShape[] = [];

const plainRow = (row: StoredRowShape): StoredRowShape => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith(`$`))) as StoredRowShape;

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
  let rows = EMPTY_ROWS;
  let orderRevision = -1;
  let resolved = false;
  const resolveRow = (source: Record<string, unknown>): StoredRowShape => {
    const typedSource = source as StoredRowShape;
    const cached = sourceCache.get(typedSource);
    if (cached) return cached;
    const next = plainRow(typedSource);
    const current = rowCache.get(next.id);
    const resolved = current && rowsShallowEqual(current, next) ? current : next;
    rowCache.set(next.id, resolved);
    sourceCache.set(typedSource, resolved);
    return resolved;
  };
  const rebuild = (): boolean => {
    if (scopeKey == null) return false;
    const target = getApplyTarget(modelId);
    const next = target.readScopeOrder(scopeKey).flatMap(id => {
      const source = target.readRow(id);
      return source ? [resolveRow(source)] : [];
    });
    if (arraysShallowEqual(rows, next)) return false;
    rows = next;
    const liveIds = new Set(next.map(row => row.id));
    for (const id of rowCache.keys()) if (!liveIds.has(id)) rowCache.delete(id);
    return true;
  };
  rebuild();
  if (scopeKey != null) {
    const target = getApplyTarget(modelId);
    orderRevision = target.readScopeOrderRevision(scopeKey);
    resolved = target.readScopeGeneration(scopeKey) > 0;
  }
  const engine = {
    signature: incrementalSignature('scope-read', modelId, scopeKey, sortMeta),
    generation: getRuntimeGeneration(),
    value: rows,
    version: 0,
    apply: (batch: IncrementalCommitBatch | null): boolean => {
      if (scopeKey == null) return false;
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      const target = getApplyTarget(modelId);
      const relevantRows = batch?.rows.filter(change => change.model === modelId) ?? [];
      const scopeChange = batch?.scopeChanges?.find(change => change.model === modelId && change.scopeKey === scopeKey);
      const requiresRebuild =
        batch === null ||
        batch.mode === 'bulk' ||
        batch.mode === 'replace' ||
        batch.mode === 'maintenance' ||
        batch?.maintenanceModels?.includes(modelId) === true ||
        scopeChange?.rebuild === true ||
        (scopeChange?.appendIds?.length ?? 0) > 0 ||
        (scopeChange?.detachIds?.length ?? 0) > 0 ||
        relevantRows.some(change => target.scopeOrderAffected(scopeKey, change.id, change.fields));
      if (!scopeChange && relevantRows.length === 0 && batch !== null) return false;
      const revision = target.readScopeOrderRevision(scopeKey);
      let changed = false;
      if (requiresRebuild) {
        changed = rebuild();
      } else if (relevantRows.length > 0) {
        const changesById = new Map(relevantRows.map(change => [change.id, change]));
        const next = rows.map(row => {
          const change = changesById.get(row.id);
          if (!change) return row;
          const source = target.readRow(change.id);
          return source ? resolveRow(source) : row;
        });
        if (!arraysShallowEqual(rows, next)) {
          rows = next;
          changed = true;
        }
      }
      const resorted = requiresRebuild && revision !== orderRevision;
      orderRevision = revision;
      const becameResolved = !resolved && target.readScopeGeneration(scopeKey) > 0;
      resolved ||= becameResolved;
      noteScopeReadPass(resorted, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
      if (!changed && !becameResolved) return false;
      engine.value = rows;
      engine.version += 1;
      return true;
    }
  };
  return engine;
};

const useScopeReadSnapshot = <TSnapshot,>(modelId: string, scopeKey: string | null, sortMeta: ScopeSortMeta, snapshot: (rows: StoredRowShape[]) => TSnapshot): TSnapshot => {
  const bus = getCommitBus();
  const signature = incrementalSignature('scope-read', modelId, scopeKey, sortMeta);
  const engineRef = useRef<ReturnType<typeof createScopeReadEngine> | null>(null);
  const subscriptionRef = useRef<CommitSubscription | null>(null);
  if (engineRef.current === null || engineRef.current.signature !== signature || engineRef.current.generation !== getRuntimeGeneration()) {
    engineRef.current = createScopeReadEngine(modelId, scopeKey, sortMeta);
  }
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = bus.subscribeIncremental(
        onStoreChange,
        scopeKey == null ? [] : [{ kind: 'scope', model: modelId, scopeKey }],
        batch => {
          engineRef.current?.apply(batch);
        }
      );
      subscriptionRef.current = subscription;
      return () => {
        subscriptionRef.current = null;
        subscription.unsubscribe();
      };
    },
    [bus, modelId, scopeKey]
  );
  useEffect(() => {
    subscriptionRef.current?.setDeps(scopeKey == null ? [] : [{ kind: 'scope', model: modelId, scopeKey }]);
  });
  const getSnapshot = useCallback(() => snapshot(engineRef.current!.value), [snapshot]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export function useScopeReadRows<TOutput extends Record<string, unknown> = StoredRowShape>(
  modelId: string,
  scopeKey: string | null,
  sortMeta: ScopeSortMeta,
  isResolved: () => boolean,
  options: ScopeProjectionOptions<TOutput> = {}
): TOutput[] {
  validateProjectionOptions(options, `${modelId}.scope.use`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<StoredRowShape, TOutput>());
  const storeRef = useRef<{ rows: TOutput[]; resolved: boolean }>({ rows: [], resolved: false });
  const requireGateRef = useRef<RequireGate>({ source: null, require: undefined, result: EMPTY_ROWS });
  optionsRef.current = options;
  const store = useScopeReadSnapshot(modelId, scopeKey, sortMeta, source => {
    const gated = readRequireGate(requireGateRef, source, optionsRef.current.require);
    const rows = gateRef.current.projectRows(gated, optionsRef.current);
    const resolved = isResolved();
    if (storeRef.current.rows === rows && storeRef.current.resolved === resolved) return storeRef.current;
    storeRef.current = { rows, resolved };
    return storeRef.current;
  });
  return useScopeRetention(scopeKey, { rows: store.rows, totalCount: store.rows.length }, store.resolved, options.keepPrevious === true).snapshot.rows;
}

export function useScopeReadWindowRows(
  modelId: string,
  scopeKey: string | null,
  sortMeta: ScopeSortMeta,
  windowSize: number,
  isResolved: () => boolean,
  options: ScopeProjectionOptions<Record<string, unknown>> = {}
): ScopeWindowSnapshot {
  validateProjectionOptions(options, `${modelId}.scope.useWindow`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate<StoredRowShape, Record<string, unknown>>());
  const requireGateRef = useRef<RequireGate>({ source: null, require: undefined, result: EMPTY_ROWS });
  const windowRef = useRef<{ source: StoredRowShape[]; size: number; resolved: boolean; snapshot: ScopeWindowSnapshot }>({
    source: EMPTY_ROWS,
    size: 0,
    resolved: false,
    snapshot: { rows: EMPTY_ROWS, totalCount: 0, isPreviousData: false, resolved: false }
  });
  optionsRef.current = options;
  const snapshot = useScopeReadSnapshot(modelId, scopeKey, sortMeta, stored => {
    const gated = readRequireGate(requireGateRef, stored, optionsRef.current.require);
    const source = gateRef.current.projectRows(gated, optionsRef.current) as StoredRowShape[];
    const resolved = isResolved();
    if (windowRef.current.source === source && windowRef.current.size === windowSize && windowRef.current.resolved === resolved) return windowRef.current.snapshot;
    const rows = source.slice(0, windowSize);
    const previous = windowRef.current.snapshot;
    const next = previous.resolved === resolved && previous.totalCount === source.length && arraysShallowEqual(previous.rows, rows)
      ? previous
      : { rows, totalCount: source.length, isPreviousData: false, resolved };
    windowRef.current = { source, size: windowSize, resolved, snapshot: next };
    return next;
  });
  const retained = useScopeRetention(scopeKey, snapshot, snapshot.resolved, options.keepPrevious === true);
  return retained.snapshot === snapshot
    ? { rows: snapshot.rows, totalCount: snapshot.totalCount, isPreviousData: false, resolved: snapshot.resolved }
    : { ...retained.snapshot, isPreviousData: retained.isPreviousData, resolved: snapshot.resolved };
}

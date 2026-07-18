import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Dependency, IncrementalCommitBatch } from '../core/apply/commitBus';
import { getCommitBus, getRuntimeGeneration } from '../dsl/configure';
import { arraysShallowEqual } from './useLiveRead';
import { isRecord } from '../utils/normalizeHelpers';

type Engine<T> = {
  signature: string;
  generation: number;
  value: T;
  version: number;
  apply(batch: IncrementalCommitBatch | null): boolean;
};

const identityTokens = new WeakMap<object, number>();
let nextIdentityToken = 1;

const semanticValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') {
    const object = value as unknown as object;
    const token = identityTokens.get(object) ?? nextIdentityToken++;
    identityTokens.set(object, token);
    return `function:${token}`;
  }
  if (Array.isArray(value)) return `[${value.map(semanticValue).join(',')}]`;
  if (isRecord(value)) {
    const object = value as object;
    const record = value as Record<string, unknown>;
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${semanticValue(record[key])}`).join(',')}}`;
    }
    const token = identityTokens.get(object) ?? nextIdentityToken++;
    identityTokens.set(object, token);
    return `object:${token}`;
  }
  return String(value);
};

/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
export const incrementalSignature = (kind: string, ...values: unknown[]): string => `${kind}:${values.map(semanticValue).join(':')}`;

type EngineInput<T> = {
  signature: string;
  create(): Engine<T>;
  deps: ReadonlyArray<Dependency>;
};

/** Internal incremental subscription bridge. The public CommitBus contract remains unchanged. */
export const useIncrementalRead = <T>({ signature, create, deps }: EngineInput<T>): T => {
  const bus = getCommitBus();
  const engineRef = useRef<Engine<T> | null>(null);
  const subscriptionRef = useRef<{ setDeps(next: ReadonlyArray<Dependency>): void; unsubscribe(): void } | null>(null);
  const generation = getRuntimeGeneration();
  if (engineRef.current === null || engineRef.current.signature !== signature || engineRef.current.generation !== generation) {
    engineRef.current = create();
  }
  const engine = engineRef.current;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = bus.subscribeIncremental(
        () => onStoreChange(),
        deps,
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
    [bus, deps]
  );

  useEffect(() => {
    subscriptionRef.current?.setDeps(deps);
  });

  useSyncExternalStore(
    subscribe,
    () => engine.version,
    () => engine.version
  );
  return engine.value;
};

type Row = { id: string; [key: string]: unknown };

type RowEngineOptions<T extends Row, TValue> = {
  signature: string;
  model: string;
  where(row: T): boolean;
  options?: { orderBy?: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>; limit?: number };
  initial(): T[];
  read(id: string): T | undefined;
  select(rows: T[], count: number): TValue;
  countOnly?: boolean;
};

const compareField = <T extends Row>(left: T, right: T, field: string, direction: 'asc' | 'desc', ordinals: Map<string, number>): number => {
  const a = left[field];
  const b = right[field];
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (Object.is(a, b)) return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
  const result = a < b ? -1 : 1;
  return direction === 'asc' ? result : -result;
};

/** Sort model read results by declared keys with NULLS LAST and an implicit id tie-breaker. */
export const sortModelReadRows = <T extends Row>(rows: T[], orderBy: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit?: number): T[] => {
  const sorted = [...rows].sort((left, right) => {
    for (const order of orderBy) {
      const a = left[order.field];
      const b = right[order.field];
      const aMissing = a == null;
      const bMissing = b == null;
      if (aMissing && bMissing) continue;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (Object.is(a, b)) continue;
      const result = a < b ? -1 : 1;
      return order.direction === 'asc' ? result : -result;
    }
    return left.id.localeCompare(right.id);
  });
  return limit === undefined ? sorted : sorted.slice(0, Math.max(0, limit));
};

const engineValuesEqual = (left: unknown, right: unknown): boolean =>
  Array.isArray(left) && Array.isArray(right) ? arraysShallowEqual(left, right) : Object.is(left, right);

/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
export const createModelReadEngine = <T extends Row, TValue>(options: RowEngineOptions<T, TValue>): Engine<TValue> => {
  const rows = options.countOnly ? null : new Map<string, T>();
  const ids = new Set<string>();
  const ordinals = new Map<string, number>();
  let ordinal = 0;
  let ordered: T[] = [];
  const engine: Engine<TValue> = {
    signature: options.signature,
    generation: getRuntimeGeneration(),
    value: undefined as TValue,
    version: 0,
    apply: () => false
  };
  const render = (): void => {
    if (rows) {
      const orderBy = options.options?.orderBy ?? [];
      const values = [...rows.values()];
      ordered = orderBy.length > 0
        ? sortModelReadRows(values, orderBy, options.options?.limit)
        : options.options?.limit === undefined
          ? values
          : values.slice(0, Math.max(0, options.options.limit));
      engine.value = options.select(ordered, ids.size);
    } else {
      engine.value = options.select([], ids.size);
    }
  };
  const rebuild = (): void => {
    rows?.clear();
    ids.clear();
    ordinals.clear();
    ordinal = 0;
    for (const row of options.initial()) {
      if (!options.where(row)) continue;
      ids.add(row.id);
      ordinals.set(row.id, ordinal++);
      rows?.set(row.id, row);
    }
    render();
  };
  rebuild();
  engine.apply = batch => {
    const relevant = batch?.rows.filter(change => change.model === options.model) ?? [];
    const requiresRebuild = batch === null || batch.mode === 'bulk' || batch.mode === 'replace' || batch.mode === 'maintenance' || batch?.maintenanceModels?.includes(options.model) === true || relevant.length > 64;
    if (requiresRebuild) {
      const previous = engine.value;
      rebuild();
      if (!engineValuesEqual(previous, engine.value)) engine.version += 1;
      else engine.value = previous;
      return true;
    }
    if (relevant.length === 0) return false;
    let changed = false;
    for (const change of relevant) {
      const row = options.read(change.id);
      const matched = row !== undefined && options.where(row);
      const had = ids.has(change.id);
      if (matched && !had) {
        ids.add(change.id);
        ordinals.set(change.id, ordinal++);
        rows?.set(change.id, row);
        changed = true;
      } else if (!matched && had) {
        ids.delete(change.id);
        rows?.delete(change.id);
        changed = true;
      } else if (matched && had && rows) {
        rows.set(change.id, row);
        changed = true;
      }
    }
    if (!changed) return false;
    const previous = engine.value;
    render();
    if (engineValuesEqual(previous, engine.value)) {
      engine.value = previous;
      return false;
    }
    engine.version += 1;
    return true;
  };
  return engine;
};

type ScopeEngineOptions<T extends Row> = {
  signature: string;
  model: string;
  scopeKey: string;
  initial(): T[];
  read(id: string): T | undefined;
  sort?: { field: string; direction: 'asc' | 'desc' } | 'server-order' | { comparator: (left: T, right: T) => number };
  windowSize?: number;
};

/** P5 state: one scope subscription, ephemeral epochs, and conservative comparator rebuilds. */
export const createScopeReadEngine = <T extends Row>(options: ScopeEngineOptions<T>): Engine<T[]> => {
  const rows = new Map<string, T>();
  const ordinals = new Map<string, number>();
  let ordinal = 0;
  let windowSnapshot: { rows: T[]; totalCount: number; hasMore: boolean } | null = null;
  const engine: Engine<T[]> = {
    signature: options.signature,
    generation: getRuntimeGeneration(),
    value: [],
    version: 0,
    apply: () => false
  };
  const render = (): void => {
    const next = [...rows.values()];
    const sort = options.sort;
    if (sort && sort !== 'server-order') {
      if ('comparator' in sort) next.sort(sort.comparator);
      else next.sort((left, right) => compareField(left, right, sort.field, sort.direction, ordinals));
    }
    engine.value = next;
  };
  const rebuild = (): void => {
    rows.clear();
    ordinals.clear();
    ordinal = 0;
    for (const row of options.initial()) {
      rows.set(row.id, row);
      ordinals.set(row.id, ordinal++);
    }
    render();
  };
  const changedWindow = (): boolean => {
    if (options.windowSize === undefined) return true;
    const next = { rows: (engine.value as T[]).slice(0, options.windowSize), totalCount: (engine.value as T[]).length, hasMore: (engine.value as T[]).length > options.windowSize };
    const changed = windowSnapshot === null || windowSnapshot.totalCount !== next.totalCount || windowSnapshot.hasMore !== next.hasMore || windowSnapshot.rows.length !== next.rows.length || windowSnapshot.rows.some((row, index) => row !== next.rows[index]);
    windowSnapshot = next;
    return changed;
  };
  rebuild();
  changedWindow();
  engine.apply = batch => {
    const scopeChanges = batch?.scopeChanges?.filter(change => change.model === options.model && change.scopeKey === options.scopeKey) ?? [];
    if (batch === null || batch?.mode !== 'delta' || batch.maintenanceModels?.includes(options.model) || scopeChanges.some(change => change.rebuild) || (options.sort && typeof options.sort !== 'string' && 'comparator' in options.sort)) {
      const previous = engine.value;
      rebuild();
      if (previous !== engine.value && changedWindow()) engine.version += 1;
      return true;
    }
    if (scopeChanges.length === 0) return false;
    let changed = false;
    for (const change of scopeChanges) {
      for (const id of change.detachIds ?? []) {
        changed = rows.delete(id) || changed;
      }
      for (const id of [...(change.appendIds ?? []), ...(change.ids ?? [])]) {
        const row = options.read(id);
        if (!row) continue;
        if (!rows.has(id)) ordinals.set(id, ordinal++);
        rows.set(id, row);
        changed = true;
      }
    }
    if (!changed) return false;
    render();
    if (changedWindow()) engine.version += 1;
    return true;
  };
  return engine;
};

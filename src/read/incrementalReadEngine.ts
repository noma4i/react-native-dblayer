import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Dependency, IncrementalCommitBatch } from '../core/apply/commitBus';
import { getCommitBus, getRuntimeGeneration } from '../dsl/configure';
import { compareCodepoints } from '../core/serialize';
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
    const token = identityTokens.get(value) ?? nextIdentityToken++;
    identityTokens.set(value, token);
    return `function:${token}`;
  }
  if (Array.isArray(value)) return `[${value.map(semanticValue).join(',')}]`;
  if (isRecord(value)) {
    const object = value as object;
    const record = value as Record<string, unknown>;
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return `{${Object.keys(record)
        .sort()
        .map(key => `${JSON.stringify(key)}:${semanticValue(record[key])}`)
        .join(',')}}`;
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
  isEqual?: (left: TValue, right: TValue) => boolean;
  countOnly?: boolean;
};

/** Sort model read results by declared keys with NULLS LAST and an implicit locale-independent id tie-breaker. */
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
    return compareCodepoints(left.id, right.id);
  });
  return limitRows(sorted, limit);
};

/** Apply an optional non-negative row limit; undefined means no limit. */
export const limitRows = <T>(rows: T[], limit: number | undefined): T[] => (limit === undefined ? rows : rows.slice(0, Math.max(0, limit)));

const engineValuesEqual = (left: unknown, right: unknown): boolean => (Array.isArray(left) && Array.isArray(right) ? arraysShallowEqual(left, right) : Object.is(left, right));

/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
export const createModelReadEngine = <T extends Row, TValue>(options: RowEngineOptions<T, TValue>): Engine<TValue> => {
  const rows = options.countOnly ? null : new Map<string, T>();
  const ids = new Set<string>();
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
      ordered = orderBy.length > 0 ? sortModelReadRows(values, orderBy, options.options?.limit) : limitRows(values, options.options?.limit);
      engine.value = options.select(ordered, ids.size);
    } else {
      engine.value = options.select([], ids.size);
    }
  };
  const rebuild = (): void => {
    rows?.clear();
    ids.clear();
    for (const row of options.initial()) {
      if (!options.where(row)) continue;
      ids.add(row.id);
      rows?.set(row.id, row);
    }
    render();
  };
  rebuild();
  engine.apply = batch => {
    const relevant = batch?.rows.filter(change => change.model === options.model) ?? [];
    const requiresRebuild =
      batch === null ||
      batch.mode === 'bulk' ||
      batch.mode === 'replace' ||
      batch.mode === 'maintenance' ||
      batch?.maintenanceModels?.includes(options.model) === true ||
      relevant.length > 64;
    if (requiresRebuild) {
      const previous = engine.value;
      rebuild();
      if (!(options.isEqual ?? engineValuesEqual)(previous, engine.value)) engine.version += 1;
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
    if ((options.isEqual ?? engineValuesEqual)(previous, engine.value)) {
      engine.value = previous;
      return false;
    }
    engine.version += 1;
    return true;
  };
  return engine;
};

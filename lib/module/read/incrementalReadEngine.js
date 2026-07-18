'use strict';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getCommitBus, getRuntimeGeneration } from '../dsl/configure.js';
const identityTokens = new WeakMap();
let nextIdentityToken = 1;
const semanticValue = value => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') {
    const object = value;
    const token = identityTokens.get(object) ?? nextIdentityToken++;
    identityTokens.set(object, token);
    return `function:${token}`;
  }
  if (Array.isArray(value)) return `[${value.map(semanticValue).join(',')}]`;
  if (typeof value === 'object') {
    const object = value;
    const record = value;
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
export const incrementalSignature = (kind, ...values) => `${kind}:${values.map(semanticValue).join(':')}`;
/** Internal incremental subscription bridge. The public CommitBus contract remains unchanged. */
export const useIncrementalRead = ({ signature, create, deps }) => {
  const bus = getCommitBus();
  const engineRef = useRef(null);
  const subscriptionRef = useRef(null);
  const generation = getRuntimeGeneration();
  if (engineRef.current === null || engineRef.current.signature !== signature || engineRef.current.generation !== generation) {
    engineRef.current = create();
  }
  const engine = engineRef.current;
  const subscribe = useCallback(
    onStoreChange => {
      const subscription = bus.subscribeIncremental(
        () => onStoreChange(),
        deps,
        batch => {
          engine.apply(batch);
        }
      );
      subscriptionRef.current = subscription;
      return () => {
        subscriptionRef.current = null;
        subscription.unsubscribe();
      };
    },
    [bus, deps, engine]
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
const compareField = (left, right, field, direction, ordinals) => {
  const a = left[field];
  const b = right[field];
  if (a !== b) {
    const result = a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
    return direction === 'asc' ? result : -result;
  }
  return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
};

/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
export const createModelReadEngine = options => {
  const rows = options.countOnly ? null : new Map();
  const ids = new Set();
  const ordinals = new Map();
  let ordinal = 0;
  let ordered = [];
  const engine = {
    signature: options.signature,
    generation: getRuntimeGeneration(),
    value: undefined,
    version: 0,
    apply: () => false
  };
  const render = () => {
    if (rows) {
      const orderBy = options.options?.orderBy;
      ordered = [...rows.values()];
      if (orderBy) ordered.sort((left, right) => compareField(left, right, orderBy.field, orderBy.direction, ordinals));
      if (options.options?.limit !== undefined) ordered = ordered.slice(0, Math.max(0, options.options.limit));
      engine.value = options.select(ordered, ids.size);
    } else {
      engine.value = options.select([], ids.size);
    }
  };
  const rebuild = () => {
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
      if (!Object.is(previous, engine.value)) engine.version += 1;
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
    render();
    engine.version += 1;
    return true;
  };
  return engine;
};
/** P5 state: one scope subscription, ephemeral epochs, and conservative comparator rebuilds. */
export const createScopeReadEngine = options => {
  const rows = new Map();
  const ordinals = new Map();
  let ordinal = 0;
  let windowSnapshot = null;
  const engine = {
    signature: options.signature,
    generation: getRuntimeGeneration(),
    value: [],
    version: 0,
    apply: () => false
  };
  const render = () => {
    const next = [...rows.values()];
    const sort = options.sort;
    if (sort && sort !== 'server-order') {
      if ('comparator' in sort) next.sort(sort.comparator);
      else next.sort((left, right) => compareField(left, right, sort.field, sort.direction, ordinals));
    }
    engine.value = next;
  };
  const rebuild = () => {
    rows.clear();
    ordinals.clear();
    ordinal = 0;
    for (const row of options.initial()) {
      rows.set(row.id, row);
      ordinals.set(row.id, ordinal++);
    }
    render();
  };
  const changedWindow = () => {
    if (options.windowSize === undefined) return true;
    const next = {
      rows: engine.value.slice(0, options.windowSize),
      totalCount: engine.value.length,
      hasMore: engine.value.length > options.windowSize
    };
    const changed =
      windowSnapshot === null ||
      windowSnapshot.totalCount !== next.totalCount ||
      windowSnapshot.hasMore !== next.hasMore ||
      windowSnapshot.rows.length !== next.rows.length ||
      windowSnapshot.rows.some((row, index) => row !== next.rows[index]);
    windowSnapshot = next;
    return changed;
  };
  rebuild();
  changedWindow();
  engine.apply = batch => {
    const scopeChanges = batch?.scopeChanges?.filter(change => change.model === options.model && change.scopeKey === options.scopeKey) ?? [];
    if (
      batch === null ||
      batch?.mode !== 'delta' ||
      batch.maintenanceModels?.includes(options.model) ||
      scopeChanges.some(change => change.rebuild) ||
      (options.sort && typeof options.sort !== 'string' && 'comparator' in options.sort)
    ) {
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
//# sourceMappingURL=incrementalReadEngine.js.map

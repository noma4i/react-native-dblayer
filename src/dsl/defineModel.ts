import { useSyncExternalStore } from 'react';
import type { DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import { matchesDbWhere } from '../core/compileDbWhere';
import { createApplyRuntime, registerApplyTarget } from '../core/apply/transaction';
import { createEntityClock, createEntityState } from '../core/planes/entityState';
import { createScopeIndex, type ScopeIndexValue } from '../core/planes/scopeIndex';
import { registerReset } from '../core/reset';
import { stableSerialize } from '../core/serialize';
import { fieldSpecSparseRead, type FieldSpec } from '../schema/fieldSpec';
import { getStoragePrefix, getCommitBus, getDbRuntimeConfig } from './configure';
import type { Coverage, ScopeSpec } from './scope';

export type ScopeValueOf<TScope> = TScope extends ScopeSpec<infer _TStored> ? Record<string, unknown> : never;

export type ScopeHandle<TStored extends { id: string }, TScope> = {
  use(scopeValue: TScope | null | undefined): TStored[];
  useWindow(scopeValue: TScope | null | undefined, opts?: { pageSize?: number }): {
    rows: TStored[];
    totalCount: number;
    hasMore: boolean;
    loadMore: () => void;
    refresh: () => Promise<void>;
  };
  useCount(scopeValue: TScope | null | undefined): number;
  invalidate(scopeValue?: TScope): void;
  read(scopeValue: TScope): TStored[];
  __apply?(scopeValue: TScope, rows: TStored[], coverage: Coverage): void;
};

type ModelCore<TStored extends { id: string; updatedAt?: string | null }> = {
  get(id: string | null | undefined): TStored | undefined;
  getWhere(where: DbWhere<TStored>, opts?: DbReadOptions<TStored>): TStored[];
  patch(id: string, patch: Partial<TStored>): void;
  destroy(id: string): void;
  destroyMany(ids: string[]): void;
  insertStored(row: TStored): void;
  replaceRaw(oldId: string, next: unknown): void;
  buildStored(input: unknown): TStored;
  normalize(input: unknown): Partial<TStored> & { id: string };
  invalidate(scope?: unknown): void;
  gc(): number;
  use: {
    row(id: string | null | undefined, opts?: { select?: ReadonlyArray<keyof TStored> }): TStored | undefined;
    field<K extends keyof TStored>(id: string | null | undefined, field: K): TStored[K] | undefined;
    first(where?: DbWhere<TStored> | null, opts?: DbReadOptions<TStored>): TStored | undefined;
    where(where: DbWhere<TStored> | null, opts?: DbReadOptions<TStored>): TStored[];
    byIds(ids: string[]): TStored[];
    count(where?: DbWhere<TStored> | null): number;
  };
  scopes: Record<string, ScopeHandle<TStored, Record<string, unknown>>>;
  registerReset(fn: () => void): void;
  __applyRows?(rows: TStored[]): void;
};

type ModelConfig<TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>>, TExt extends Record<string, unknown>> = {
  id: string;
  name: string;
  fields: TFields;
  rowId?: (input: unknown) => string;
  guard?: (input: unknown) => boolean;
  relations?: () => Record<string, unknown>;
  sideload?: unknown[];
  scopes?: TScopes;
  merge?: { shouldOverwrite?: (existing: unknown, incoming: unknown) => boolean; dedupeWindowMs?: number };
  retention?: { orphanGc?: 'manual' | 'eager' | 'off'; keep?: (row: unknown) => boolean };
  statics?: (model: ModelCore<any>) => TExt;
};

const keyForScope = (scopeValue: unknown): string => stableSerialize(scopeValue);

const sortRows = <TStored>(rows: TStored[], options?: DbReadOptions<TStored>): TStored[] => {
  if (!options?.orderBy) return rows;
  const { field, direction } = options.orderBy;
  return [...rows].sort((left, right) => {
    const a = left[field];
    const b = right[field];
    if (a === b) return 0;
    const result = a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
    return direction === 'asc' ? result : -result;
  });
};

const readField = (field: FieldSpec<any, any, any, any>, input: unknown, key: string, complete: boolean): unknown => {
  const value = complete ? field.read(input, key) : (field as FieldSpec<any, any, any, any> & { [fieldSpecSparseRead]: (value: unknown, fieldKey: string) => unknown })[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

/** Define a v6 model backed by EntityState and the journalled apply pipeline. */
export const defineModel = <TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(
  config: ModelConfig<TFields, TScopes, TExt>
): ModelCore<any> & { scopes: { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>> } } & TExt => {
  const runtime = getDbRuntimeConfig();
  let tick = 0;
  const bus = getCommitBus();
  const notify = (): void => { tick += 1; };
  const subscribe = (listener: () => void): (() => void) => {
    const subscription = bus.subscribe(() => {
      tick += 1;
      listener();
    }, [{ kind: 'model', model: config.id }]);
    return subscription.unsubscribe;
  };
  const snapshot = (): number => tick;
  const prefix = getStoragePrefix;
  const entityState = createEntityState<any>({ modelId: config.id, clock: createEntityClock(), now: () => Date.now(), storage: runtime.storage, prefix });
  const scopeIndex = createScopeIndex({ modelId: config.id, storage: runtime.storage, prefix });
  const apply = createApplyRuntime({ storage: runtime.storage, prefix, bus });
  const normalize = (input: unknown, complete = false): any => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = config.rowId?.(input) ?? (typeof input === 'object' && input !== null ? (input as Record<string, unknown>).id : undefined);
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${config.name} requires id`);
    const output: Record<string, unknown> = { id };
    for (const [key, field] of Object.entries(config.fields)) {
      const value = readField(field, input, key, complete);
      if (value !== undefined) output[key] = value;
    }
    return output;
  };
  const writeRows = (rows: unknown[]): Array<{ id: string; changedFields: string[] | null }> => {
    const changes: Array<{ id: string; changedFields: string[] | null }> = [];
    for (const value of rows) {
      const incoming = normalize(value);
      const current = entityState.read(incoming.id);
      if (current && config.merge?.shouldOverwrite && !config.merge.shouldOverwrite(current, incoming)) continue;
      const result = entityState.upsert({ ...current, ...incoming });
      changes.push({ id: incoming.id, changedFields: result.changedFields });
    }
    return changes;
  };
  const writeDestroy = (ids: string[]): string[] => {
    for (const id of ids) entityState.destroy(id);
    return ids;
  };
  const unregisterTarget = registerApplyTarget(config.id, {
    upsert: writeRows,
    destroy: writeDestroy,
    counter: (id, field, delta) => {
      const row = entityState.read(id);
      if (!row) return false;
      entityState.upsert({ ...row, [field]: ((row[field] as number | undefined) ?? 0) + delta });
      return true;
    },
    scope: (hash, next) => {
      scopeIndex.write(hash, next as ScopeIndexValue);
    },
    persistEntries: () => [...entityState.persistEntries(), ...scopeIndex.persistEntries()]
  });
  const applyOps = (ops: Parameters<typeof apply.apply>[0]): void => { apply.apply(ops); };
  const rowsForScope = (scopeValue: unknown): any[] => scopeIndex.read(keyForScope(scopeValue)).entries.map(entry => entityState.read(entry.id)).filter(Boolean);
  const useSnapshot = (): void => {
    useSyncExternalStore(subscribe, snapshot, snapshot);
  };
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, {
    use: (scopeValue: unknown) => {
      useSnapshot();
      return scopeValue == null ? [] : rowsForScope(scopeValue);
    },
    useWindow: (scopeValue: unknown, options?: { pageSize?: number }) => {
      useSnapshot();
      const rows = scopeValue == null ? [] : rowsForScope(scopeValue);
      const pageSize = options?.pageSize ?? runtime.defaults?.pageSize ?? 20;
      return { rows: rows.slice(0, pageSize), totalCount: rows.length, hasMore: rows.length > pageSize, loadMore: () => {}, refresh: async () => {} };
    },
    useCount: (scopeValue: unknown) => {
      useSnapshot();
      return scopeValue == null ? 0 : rowsForScope(scopeValue).length;
    },
    invalidate: (_scopeValue?: unknown) => notify(),
    read: rowsForScope,
    __apply: (scopeValue: unknown, rows: any[], coverage: Coverage) => {
      const hash = keyForScope(scopeValue);
      const { next } = scopeIndex.reconcile(hash, coverage, rows.map(row => ({ id: row.id })));
      applyOps([{ kind: 'upsert', model: config.id, rows }, { kind: 'scope', model: config.id, scopeKey: hash, next }]);
    }
  }])) as { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>> };
  const model: ModelCore<any> & { scopes: typeof scopeHandles } = {
    get: id => id == null ? undefined : entityState.read(id),
    getWhere: (where, options) => sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options),
    patch: (id, patch) => {
      const current = entityState.read(id);
      if (current) applyOps([{ kind: 'upsert', model: config.id, rows: [{ ...current, ...patch, id }] }]);
    },
    destroy: id => applyOps([{ kind: 'destroy', model: config.id, ids: [id] }]),
    destroyMany: ids => applyOps([{ kind: 'destroy', model: config.id, ids }]),
    insertStored: row => applyOps([{ kind: 'upsert', model: config.id, rows: [row] }]),
    replaceRaw: (oldId, next) => applyOps([{ kind: 'destroy', model: config.id, ids: [oldId] }, { kind: 'upsert', model: config.id, rows: [next] }]),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: () => notify(),
    gc: () => 0,
    use: {
      row: id => {
        useSnapshot();
        return id == null ? undefined : entityState.read(id);
      },
      field: (id, field) => {
        useSnapshot();
        return id == null ? undefined : entityState.read(id)?.[field];
      },
      first: (where, options) => {
        useSnapshot();
        return sortRows(entityState.values().filter(row => where == null || matchesDbWhere(row, where)), options)[0];
      },
      where: (where, options) => {
        useSnapshot();
        return where == null ? [] : sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options);
      },
      byIds: ids => {
        useSnapshot();
        return ids.map(id => entityState.read(id)).filter(Boolean);
      },
      count: where => {
        useSnapshot();
        return where == null ? entityState.values().length : entityState.values().filter(row => matchesDbWhere(row, where)).length;
      }
    },
    scopes: scopeHandles,
    registerReset: fn => { registerReset(fn); },
    __applyRows: rows => applyOps([{ kind: 'upsert', model: config.id, rows }])
  };
  registerReset(() => {
    entityState.reset();
    scopeIndex.reset();
    unregisterTarget();
    notify();
  });
  return Object.assign(model, config.statics?.(model));
};

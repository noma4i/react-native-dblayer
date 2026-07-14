import type { DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import { matchesDbWhere } from '../core/compileDbWhere';
import type { Dependency } from '../core/apply/commitBus';
import { registerApplyTarget } from '../core/apply/transaction';
import type { JournalOp } from '../core/apply/journal';
import { createEntityClock, createEntityState } from '../core/planes/entityState';
import { createScopeIndex, type ScopeIndexValue } from '../core/planes/scopeIndex';
import { expandPlan, registerRelationHost, type RelationDecl } from '../core/relations';
import { registerReset } from '../core/reset';
import { stableSerialize } from '../core/serialize';
import { fieldSpecSparseRead, type FieldSpec } from '../schema/fieldSpec';
import { useLiveRead, arraysShallowEqual } from '../read/useLiveRead';
import { getApplyRuntime, getDbRuntimeConfig, getStoragePrefix } from './configure';
import type { Coverage, ScopeSpec } from './scope';
import { useRef, useState } from 'react';

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
  modelId: string;
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
    related(id: string | null | undefined, relation: string): unknown;
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
  relations?: () => Record<string, RelationDecl>;
  sideload?: unknown[];
  scopes?: TScopes;
  merge?: { shouldOverwrite?: (existing: unknown, incoming: unknown) => boolean; dedupeWindowMs?: number };
  retention?: { orphanGc?: 'manual' | 'eager' | 'off'; keep?: (row: unknown) => boolean };
  statics?: (model: ModelCore<any>) => TExt;
};

const keyForScope = (scopeValue: unknown): string => stableSerialize(scopeValue);

const EMPTY_ROWS: any[] = [];

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

/** Define a v6 model backed by EntityState and the shared journalled apply pipeline. */
export const defineModel = <TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(
  config: ModelConfig<TFields, TScopes, TExt>
): ModelCore<any> & { scopes: { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>> } } & TExt => {
  const runtime = getDbRuntimeConfig();
  const prefix = getStoragePrefix;
  const entityState = createEntityState<any>({ modelId: config.id, clock: createEntityClock(), now: () => Date.now(), storage: runtime.storage, prefix });
  const scopeIndex = createScopeIndex({ modelId: config.id, storage: runtime.storage, prefix });

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

  let relationCache: Record<string, RelationDecl> | null = null;
  const resolvedRelations = (): Record<string, RelationDecl> => (relationCache ??= config.relations?.() ?? {});

  registerRelationHost(config.id, {
    relations: resolvedRelations,
    has: id => entityState.read(id) !== undefined,
    read: id => entityState.read(id),
    normalize: input => {
      try {
        return normalize(input);
      } catch {
        return null;
      }
    }
  });

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

  const applyTarget = {
    upsert: writeRows,
    patch: (id: string, patch: Record<string, unknown>): { id: string; changedFields: string[] | null } | null => {
      const current = entityState.read(id);
      if (!current) return null;
      const result = entityState.upsert({ ...current, ...patch, id });
      return { id, changedFields: result.changedFields };
    },
    destroy: (ids: string[]): string[] => {
      for (const id of ids) entityState.destroy(id);
      return ids;
    },
    counter: (id: string, field: string, delta: number): boolean => {
      const row = entityState.read(id);
      if (!row) return false;
      entityState.upsert({ ...row, [field]: ((row[field] as number | undefined) ?? 0) + delta });
      return true;
    },
    scope: (scopeKey: string, next: unknown): void => {
      scopeIndex.write(scopeKey, next as ScopeIndexValue);
    },
    persistEntries: () => [...entityState.persistEntries(), ...scopeIndex.persistEntries()]
  };
  registerApplyTarget(config.id, applyTarget);

  /** Snapshot writes (query pages / entity refreshes) apply verbatim - server state is derived already. */
  const applySnapshot = (ops: JournalOp[]): void => {
    getApplyRuntime().apply(ops);
  };

  /** Imperative/domain writes are events: expand declared relation side effects into the same plan. */
  const applyEvent = (ops: JournalOp[]): void => {
    getApplyRuntime().apply(expandPlan(ops));
  };

  const scopeSortedRows = (scopeName: string, scopeValue: unknown): any[] => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<any>>)[scopeName];
    const value = scopeIndex.read(keyForScope(scopeValue));
    const rows = value.entries.map(entry => entityState.read(entry.id)).filter(Boolean);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    if ('comparator' in spec.sort) return [...rows].sort(spec.sort.comparator);
    const { field, dir } = spec.sort;
    return sortRows(rows, { orderBy: { field, direction: dir } });
  };

  const rowDep = (id: string, fields?: ReadonlyArray<string>): Dependency => ({ kind: 'row', model: config.id, id, ...(fields ? { fields } : {}) });
  const modelDep: Dependency = { kind: 'model', model: config.id };
  const scopeDep = (scopeKey: string): Dependency => ({ kind: 'scope', model: config.id, scopeKey });
  const memberDeps = (scopeKey: string, rows: Array<{ id: string }>): Dependency[] => [scopeDep(scopeKey), ...rows.map(row => rowDep(row.id))];

  const makeScopeHandle = (scopeName: string): ScopeHandle<any, Record<string, unknown>> => ({
    use: (scopeValue: unknown) => {
      const rows = useLiveRead(
        () => (scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue)),
        scopeValue == null ? [modelDep] : memberDeps(keyForScope(scopeValue), scopeIndex.read(keyForScope(scopeValue)).entries),
        arraysShallowEqual
      );
      return rows;
    },
    useWindow: (scopeValue: unknown, options?: { pageSize?: number }) => {
      const pageSize = options?.pageSize ?? runtime.defaults?.pageSize ?? 20;
      const [windowSize, setWindowSize] = useState(pageSize);
      const rows = useLiveRead(
        () => (scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue)),
        scopeValue == null ? [modelDep] : memberDeps(keyForScope(scopeValue), scopeIndex.read(keyForScope(scopeValue)).entries),
        arraysShallowEqual
      );
      const windowRef = useRef<{ source: any[]; size: number; window: any[] }>({ source: EMPTY_ROWS, size: 0, window: EMPTY_ROWS });
      if (windowRef.current.source !== rows || windowRef.current.size !== windowSize) {
        windowRef.current = { source: rows, size: windowSize, window: rows.slice(0, windowSize) };
      }
      return {
        rows: windowRef.current.window,
        totalCount: rows.length,
        hasMore: rows.length > windowSize,
        loadMore: () => setWindowSize(current => current + pageSize),
        refresh: async () => {}
      };
    },
    useCount: (scopeValue: unknown) =>
      useLiveRead(
        () => (scopeValue == null ? 0 : scopeIndex.read(keyForScope(scopeValue)).entries.length),
        scopeValue == null ? [modelDep] : [scopeDep(keyForScope(scopeValue))]
      ),
    invalidate: (_scopeValue?: unknown) => {
      // Network re-fetch wiring arrives with defineQuery; local state stays authoritative here.
    },
    read: (scopeValue: unknown) => scopeSortedRows(scopeName, scopeValue),
    __apply: (scopeValue: unknown, rows: any[], coverage: Coverage) => {
      const scopeKey = keyForScope(scopeValue);
      const { next } = scopeIndex.reconcile(scopeKey, coverage, rows.map(row => ({ id: row.id })));
      applySnapshot([
        { kind: 'upsert', model: config.id, rows },
        { kind: 'scope', model: config.id, scopeKey, next }
      ]);
    }
  });

  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)])) as {
    [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>>;
  };

  const model: ModelCore<any> & { scopes: typeof scopeHandles } = {
    modelId: config.id,
    get: id => (id == null ? undefined : entityState.read(id)),
    getWhere: (where, options) => sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options),
    patch: (id, patch) => applyEvent([{ kind: 'patch', model: config.id, id, patch: patch as Record<string, unknown> }]),
    destroy: id => applyEvent([{ kind: 'destroy', model: config.id, ids: [id] }]),
    destroyMany: ids => applyEvent([{ kind: 'destroy', model: config.id, ids }]),
    insertStored: row => applyEvent([{ kind: 'upsert', model: config.id, rows: [row] }]),
    replaceRaw: (oldId, next) =>
      applyEvent([
        { kind: 'destroy', model: config.id, ids: [oldId] },
        { kind: 'upsert', model: config.id, rows: [next] }
      ]),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: () => {
      // Network invalidation wiring arrives with defineQuery.
    },
    gc: () => 0,
    use: {
      row: (id, options) => {
        const select = options?.select as ReadonlyArray<string> | undefined;
        return useLiveRead(
          () => (id == null ? undefined : entityState.read(id)),
          id == null ? [] : [rowDep(id, select)]
        );
      },
      field: (id, field) =>
        useLiveRead(
          () => (id == null ? undefined : entityState.read(id)?.[field]),
          id == null ? [] : [rowDep(id, [String(field)])]
        ),
      first: (where, options) =>
        useLiveRead(
          () => sortRows(entityState.values().filter(row => where == null || matchesDbWhere(row, where)), options)[0],
          [modelDep]
        ),
      where: (where, options) =>
        useLiveRead(
          () => (where == null ? EMPTY_ROWS : sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options)),
          where == null ? [] : [modelDep],
          arraysShallowEqual
        ),
      byIds: ids =>
        useLiveRead(
          () => ids.map(id => entityState.read(id)).filter(Boolean),
          ids.map(id => rowDep(id)),
          arraysShallowEqual
        ),
      count: where =>
        useLiveRead(
          () => (where == null ? entityState.values().length : entityState.values().filter(row => matchesDbWhere(row, where)).length),
          [modelDep]
        ),
      related: (id, relationName) => {
        const relation = resolvedRelations()[relationName];
        if (!relation) throw new Error(`${config.name} has no relation ${relationName}`);
        let compute: () => unknown;
        let deps: Dependency[];
        let isEqual: (a: unknown, b: unknown) => boolean = Object.is;
        if (relation.kind === 'belongsTo') {
          const parentIdOf = (): string | null => {
            const child = id == null ? undefined : entityState.read(id);
            const value = child?.[relation.foreignKey];
            return typeof value === 'string' && value.length > 0 ? value : null;
          };
          compute = () => {
            const parentId = parentIdOf();
            return parentId ? relation.model.get(parentId) : undefined;
          };
          const parentId = parentIdOf();
          deps = id == null ? [] : [rowDep(id, [relation.foreignKey]), ...(parentId ? [{ kind: 'row' as const, model: relation.model.modelId, id: parentId }] : [])];
        } else if (relation.kind === 'hasMany') {
          compute = () => (id == null ? EMPTY_ROWS : relation.model.getWhere({ [relation.foreignKey]: id }));
          deps = id == null ? [] : [{ kind: 'model', model: relation.model.modelId }];
          isEqual = (a, b) => arraysShallowEqual(a as unknown[], b as unknown[]);
        } else {
          const comparator = relation.comparator;
          compute = () => {
            if (id == null) return undefined;
            const rows = relation.model.getWhere({ [relation.foreignKey]: id });
            if (rows.length === 0) return undefined;
            return comparator ? rows.reduce((best, row) => (comparator(row, best) < 0 ? row : best)) : rows[0];
          };
          deps = id == null ? [] : [{ kind: 'model', model: relation.model.modelId }];
        }
        return useLiveRead(compute, deps, isEqual);
      }
    },
    scopes: scopeHandles,
    registerReset: fn => {
      registerReset(fn);
    },
    __applyRows: rows => applySnapshot([{ kind: 'upsert', model: config.id, rows }])
  };

  entityState.hydrate();
  scopeIndex.hydrate();

  registerReset(() => {
    entityState.reset();
    scopeIndex.reset();
    // The apply target stays registered: a model must keep working after the kill-switch.
  });

  return Object.assign(model, config.statics?.(model));
};

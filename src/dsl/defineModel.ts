import type { DbReadOptions, DbWhere, ModelFieldSpecs, ModelRelationsConfig } from '../types';
import { createPersistentCollection, defineModel as defineLegacyModel } from '../core/createPersistentCollection';
import { createApplyRuntime, registerApplyTarget } from '../core/apply/transaction';
import { createScopeIndex, type ScopeIndexValue } from '../core/planes/scopeIndex';
import { getAccountPartitionPrefix, getDbRuntimeConfig } from './configure';
import type { ScopeSpec } from './scope';
import { stableSerialize } from '../core/serialize';

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
  normalize(input: unknown): unknown;
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
  registerReset(fn: () => void): void;
};

type ModelConfig<TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>>, TExt extends Record<string, unknown>> = {
  id: string;
  name: string;
  fields: TFields;
  relations?: () => ModelRelationsConfig;
  sideload?: unknown[];
  scopes?: TScopes;
  merge?: { shouldOverwrite?: (existing: unknown, incoming: unknown) => boolean; dedupeWindowMs?: number };
  retention?: { orphanGc?: 'manual' | 'eager' | 'off'; keep?: (row: unknown) => boolean };
  statics?: (model: ModelCore<any>) => TExt;
};

const scopeKey = (scopeValue: unknown): string => stableSerialize(scopeValue);

/** Define a v6 model whose local writes compile to journalled apply plans. */
export const defineModel = <TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(
  config: ModelConfig<TFields, TScopes, TExt>
): ModelCore<any> & { scopes: { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>> } } & TExt => {
  const runtime = getDbRuntimeConfig();
  const legacy = defineLegacyModel({
    id: config.id,
    name: config.name,
    fields: config.fields,
    relations: config.relations,
    sideload: config.sideload as never,
    merge: config.merge
  } as never) as any;
  const scopes = createScopeIndex();
  const apply = createApplyRuntime(runtime.storage, getAccountPartitionPrefix());
  const rawInsert = legacy.insertStored.bind(legacy);
  const rawDestroy = legacy.destroy.bind(legacy);
  const rawPatch = legacy.patch.bind(legacy);

  registerApplyTarget(config.id, {
    upsert: rows => rows.forEach(row => rawInsert(row)),
    destroy: ids => ids.forEach(id => rawDestroy(id)),
    counter: (id, field, delta) => rawPatch(id, { [field]: ((legacy.get(id)?.[field] as number | undefined) ?? 0) + delta }),
    scope: (hash, next) => scopes.write(hash, next as ScopeIndexValue)
  });

  const applyOps = (ops: Parameters<typeof apply.apply>[0]): void => apply.apply(ops);
  const readScope = (value: unknown): any[] => {
    const entries = scopes.read(scopeKey(value)).entries;
    return entries.map(entry => legacy.get(entry.id)).filter(Boolean);
  };
  const handles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, {
    use: (value: unknown) => legacy.byIds(value == null ? [] : scopes.read(scopeKey(value)).entries.map(entry => entry.id)),
    useWindow: (value: unknown, opts?: { pageSize?: number }) => {
      const rows = legacy.byIds(value == null ? [] : scopes.read(scopeKey(value)).entries.map(entry => entry.id));
      const pageSize = opts?.pageSize ?? runtime.defaults?.pageSize ?? 20;
      return { rows: rows.slice(0, pageSize), totalCount: rows.length, hasMore: rows.length > pageSize, loadMore: () => {}, refresh: async () => {} };
    },
    useCount: (value: unknown) => legacy.byIds(value == null ? [] : scopes.read(scopeKey(value)).entries.map(entry => entry.id)).length,
    invalidate: (value?: unknown) => legacy.invalidate(value),
    read: readScope
  }])) as { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>> };

  const model: ModelCore<any> & { scopes: typeof handles } = {
    get: legacy.get,
    getWhere: legacy.getWhere,
    patch: (id, patch) => applyOps([{ kind: 'upsert', model: config.id, rows: [{ ...legacy.get(id), ...patch, id }] }]),
    destroy: id => applyOps([{ kind: 'destroy', model: config.id, ids: [id] }]),
    destroyMany: ids => applyOps([{ kind: 'destroy', model: config.id, ids }]),
    insertStored: row => applyOps([{ kind: 'upsert', model: config.id, rows: [row] }]),
    replaceRaw: (oldId, next) => {
      const normalized = legacy.normalize(next);
      if (normalized) applyOps([{ kind: 'destroy', model: config.id, ids: [oldId] }, { kind: 'upsert', model: config.id, rows: [normalized] }]);
    },
    buildStored: legacy.buildStored,
    normalize: legacy.normalize,
    invalidate: legacy.invalidate,
    gc: () => 0,
    use: {
      row: legacy.find,
      field: (id, field) => legacy.find(id)?.[field],
      first: legacy.first,
      where: legacy.where,
      byIds: legacy.byIds,
      count: legacy.count
    },
    scopes: handles,
    registerReset: () => {}
  };
  return Object.assign(model, config.statics?.(model));
};

import type { DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import { buildScopeKey, matchesDbWhere } from '../core/compileDbWhere';
import type { Dependency } from '../core/apply/commitBus';
import { registerApplyTarget } from '../core/apply/transaction';
import type { JournalOp } from '../core/apply/journal';
import { registerGcHost } from '../core/gc';
import { createEntityClock, createEntityState, type EntityState } from '../core/planes/entityState';
import { createScopeIndex, type ScopeIndex, type ScopeIndexValue } from '../core/planes/scopeIndex';
import { invalidateModel } from '../core/invalidationRegistry';
import { getDbLogger } from '../core/logger';
import { expandPlan, registerRelationHost, type MembershipDelta, type RelationDecl } from '../core/relations';
import { registerReset } from '../core/reset';
import { fieldSpecSparseRead, type FieldSpec } from '../schema/fieldSpec';
import { useLiveRead, arraysShallowEqual } from '../read/useLiveRead';
import { createModelReadEngine, createScopeReadEngine, incrementalSignature, useIncrementalRead } from '../read/incrementalReadEngine';
import { getApplyRuntime, getDbRuntimeConfig, getStoragePrefix } from './configure';
import type { Coverage, ScopeSpec } from './scope';
import { useMemo, useRef, useState } from 'react';

export type ScopeValueOf<TScope> = TScope extends ScopeSpec<infer _TStored> ? Record<string, unknown> : never;

export type ScopeHandle<TStored extends { id: string }, TScope> = {
  modelId: string;
  use(scopeValue: TScope | null | undefined): TStored[];
  useWindow(
    scopeValue: TScope | null | undefined,
    opts?: { pageSize?: number }
  ): {
    rows: TStored[];
    totalCount: number;
    hasMore: boolean;
    loadMore: () => void;
  };
  useCount(scopeValue: TScope | null | undefined): number;
  invalidate(scopeValue?: TScope): void;
  read(scopeValue: TScope): TStored[];
  __apply?(scopeValue: TScope, rows: TStored[], coverage: Coverage, opts?: { resetOrder?: boolean }): void;
  __planApply?(scopeValue: TScope, rows: Array<{ row: TStored; edge?: Record<string, unknown> }>, coverage: Coverage, opts?: { resetOrder?: boolean }): JournalOp[];
};

type ModelCore<TStored extends { id: string; updatedAt?: string | null }> = {
  modelId: string;
  get(id: string | null | undefined): TStored | undefined;
  getWhere(where: DbWhere<TStored>, opts?: DbReadOptions<TStored>): TStored[];
  /** Full snapshot - library/maintenance channel; app code stays on scoped reads. */
  getAll(): TStored[];
  patch(id: string, patch: Partial<TStored>): void;
  destroy(id: string): void;
  destroyMany(ids: string[]): void;
  insertStored(row: TStored): void;
  replaceRaw(oldId: string, next: unknown): void;
  buildStored(input: unknown): TStored;
  normalize(input: unknown): Partial<TStored> & { id: string };
  invalidate(scope?: unknown): void;
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
  __planRows?(rows: TStored[]): JournalOp[];
  __planReplace?(oldId: string, next: unknown): JournalOp[];
  __captureMembership?(id: string): Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>;
  __planRestore?(next: unknown, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[];
};

type ModelConfig<TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>>, TExt extends Record<string, unknown>> = {
  id: string;
  name: string;
  fields: TFields;
  rowId?: (input: unknown) => string;
  guard?: (input: unknown) => boolean;
  relations?: () => Record<string, RelationDecl>;
  scopes?: TScopes;
  gc?: 'exempt';
  merge?: { shouldOverwrite?: (existing: unknown, incoming: unknown) => boolean };
  statics?: (model: ModelCore<any>) => TExt;
};

const keyForScope = (scopeName: string, scopeValue: unknown): string => `${scopeName}:${buildScopeKey(scopeValue)}`;

const EMPTY_ROWS: any[] = [];

const sortRows = <TStored>(rows: TStored[], options?: DbReadOptions<TStored>): TStored[] => {
  const ordered = options?.orderBy
    ? [...rows].sort((left, right) => {
        const { field, direction } = options.orderBy!;
        const a = left[field];
        const b = right[field];
        if (a === b) return 0;
        const result = a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
        return direction === 'asc' ? result : -result;
      })
    : rows;
  return options?.limit === undefined ? ordered : ordered.slice(0, Math.max(0, options.limit));
};

const readField = (field: FieldSpec<any, any, any, any>, input: unknown, key: string, complete: boolean): unknown => {
  const value = complete
    ? field.read(input, key)
    : (field as FieldSpec<any, any, any, any> & { [fieldSpecSparseRead]: (value: unknown, fieldKey: string) => unknown })[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

/** Define a v6 model backed by EntityState and the shared journalled apply pipeline. */
export const defineModel = <TFields extends ModelFieldSpecs, TScopes extends Record<string, ScopeSpec<any>> = {}, TExt extends Record<string, unknown> = {}>(
  config: ModelConfig<TFields, TScopes, TExt>
): ModelCore<any> & { scopes: { [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>> } } & TExt => {
  type ModelPlanes = { entityState: EntityState<any>; scopeIndex: ScopeIndex };
  let planesRef: ModelPlanes | null = null;
  /** Planes are created and hydrated on first touch, so models can be defined before configureDb. */
  const planes = (): ModelPlanes => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const entityState = createEntityState<any>({ modelId: config.id, clock: createEntityClock(), now: () => Date.now(), storage: runtime.storage, prefix: getStoragePrefix });
    const scopeIndex = createScopeIndex({ modelId: config.id, scopeNames: Object.keys(config.scopes ?? {}), storage: runtime.storage, prefix: getStoragePrefix });
    entityState.hydrate();
    scopeIndex.hydrate();
    planesRef = { entityState, scopeIndex };
    return planesRef;
  };

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

  /** Plan-build validation: raw rows stay in the op (normalize is shape-sensitive); invalid rows drop here. */
  const isPlanRow = (value: unknown): boolean => {
    try {
      normalize(value);
      return true;
    } catch (error) {
      getDbLogger().error(`[${config.name}] plan row rejected`, { error });
      return false;
    }
  };

  let relationCache: Record<string, RelationDecl> | null = null;
  const resolvedRelations = (): Record<string, RelationDecl> => (relationCache ??= config.relations?.() ?? {});

  const membershipScopes = Object.entries(config.scopes ?? {}).filter((entry): entry is [string, ScopeSpec<any> & { by: Record<string, string> }] =>
    Boolean((entry[1] as ScopeSpec<any>).by)
  );

  const scopeValueFromRow = (by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null => {
    const value: Record<string, unknown> = {};
    for (const [scopeField, rowField] of Object.entries(by)) {
      const fieldValue = row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };

  const isScopeMember = (scopeKey: string, id: string): boolean => planes().scopeIndex.has(scopeKey, id);

  /** Declarative membership: an event row joins/leaves its `by` scopes inside the SAME plan. */
  const membershipForUpsert = (row: Record<string, unknown>): MembershipDelta[] => {
    const id = String(row.id);
    const before = planes().entityState.read(id);
    const merged = { ...before, ...row, id };
    const deltas: MembershipDelta[] = [];
    for (const [scopeName, spec] of membershipScopes) {
      const beforeValue = before ? scopeValueFromRow(spec.by, before) : null;
      const afterValue = scopeValueFromRow(spec.by, merged);
      const beforeKey = beforeValue ? keyForScope(scopeName, beforeValue) : null;
      const afterKey = afterValue ? keyForScope(scopeName, afterValue) : null;
      if (beforeKey && beforeKey !== afterKey && isScopeMember(beforeKey, id)) deltas.push({ scopeKey: beforeKey, detach: [id] });
      if (afterKey && !isScopeMember(afterKey, id)) deltas.push({ scopeKey: afterKey, append: [id] });
    }
    return deltas;
  };

  const membershipForPatch = (id: string, patch: Record<string, unknown>): MembershipDelta[] => {
    const current = planes().entityState.read(id);
    if (!current) return [];
    return membershipForUpsert({ ...patch, id });
  };

  const detachForDestroy = (id: string): MembershipDelta[] =>
    planes()
      .scopeIndex.keysOf(id)
      .map(scopeKey => ({ scopeKey, detach: [id] }));

  registerRelationHost(config.id, {
    relations: resolvedRelations,
    has: id => planes().entityState.read(id) !== undefined,
    read: id => planes().entityState.read(id),
    normalize: input => {
      try {
        return normalize(input);
      } catch {
        return null;
      }
    },
    membershipForUpsert,
    membershipForPatch,
    detachForDestroy
  });

  const writeRows = (rows: unknown[], origin?: 'event' | 'replace'): Array<{ id: string; changedFields: string[] | null }> => {
    const changes: Array<{ id: string; changedFields: string[] | null }> = [];
    for (const value of rows) {
      let incoming: any;
      try {
        incoming = normalize(value);
      } catch (error) {
        getDbLogger().error(`[${config.name}] apply row rejected`, { error });
        continue;
      }
      if (origin === undefined && planes().entityState.isTombstoned(incoming.id)) continue;
      const current = planes().entityState.read(incoming.id);
      if (current && config.merge?.shouldOverwrite && !config.merge.shouldOverwrite(current, incoming)) continue;
      const result = planes().entityState.upsert({ ...current, ...incoming });
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({ id: incoming.id, changedFields: result.changedFields });
    }
    return changes;
  };

  const applyTarget = {
    upsert: writeRows,
    patch: (id: string, patch: Record<string, unknown>): { id: string; changedFields: string[] | null } | null => {
      const current = planes().entityState.read(id);
      if (!current) return null;
      const result = planes().entityState.upsert({ ...current, ...patch, id });
      if (result.changedFields !== null && result.changedFields.length === 0) return null;
      return { id, changedFields: result.changedFields };
    },
    destroy: (ids: string[], tombstone?: boolean): string[] => {
      const removed: string[] = [];
      for (const id of ids) {
        const existed = planes().entityState.read(id) !== undefined;
        planes().entityState.destroy(id, { tombstone });
        if (existed) removed.push(id);
      }
      return removed;
    },
    counter: (id: string, field: string, delta: number, next?: number): boolean => {
      const row = planes().entityState.read(id);
      if (!row) return false;
      planes().entityState.upsert({ ...row, [field]: next ?? ((row[field] as number | undefined) ?? 0) + delta });
      return true;
    },
    counterValue: (id: string, field: string): number | null => {
      const value = planes().entityState.read(id)?.[field];
      return typeof value === 'number' ? value : value == null ? null : Number(value);
    },
    scope: (scopeKey: string, next: unknown): void => {
      planes().scopeIndex.write(scopeKey, next as ScopeIndexValue);
    },
    scopeDelta: (scopeKey: string, delta: { append: Array<{ id: string; edge?: Record<string, unknown>; order?: number }>; detach: string[] }): void => {
      if (delta.detach.length > 0) planes().scopeIndex.detach(scopeKey, delta.detach);
      if (delta.append.length > 0) planes().scopeIndex.reconcile(scopeKey, 'delta', delta.append);
    },
    reactiveScopes: (ids: string[]) => planes().scopeIndex.touchMembers(ids),
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()]
  };
  registerApplyTarget(config.id, applyTarget);
  registerGcHost(config.id, {
    modelId: config.id,
    exempt: config.gc === 'exempt',
    rowIds: () =>
      planes()
        .entityState.values()
        .map(row => String(row.id)),
    hasRow: id => planes().entityState.read(id) !== undefined,
    scopeKeys: () => planes().scopeIndex.keys(),
    scopeEntryIds: key =>
      planes()
        .scopeIndex.read(key)
        .entries.map(entry => entry.id),
    detachScopeEntries: (key, ids) => {
      planes().scopeIndex.detach(key, ids);
    },
    scopeEntryCount: key => planes().scopeIndex.read(key).entries.length,
    removeScope: key => {
      planes().scopeIndex.remove(key);
    },
    evict: id => planes().entityState.evict(id),
    referencesOf: id => {
      const row = planes().entityState.read(id);
      if (!row) return [];
      const out: Array<{ model: string; id: string }> = [];
      for (const relation of Object.values(resolvedRelations())) {
        if (relation.kind === 'belongsTo') {
          const value = row[relation.foreignKey];
          if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
        }
        if (relation.kind === 'references') {
          const raw = relation.ids(row);
          const list = Array.isArray(raw) ? raw : [raw];
          for (const value of list) {
            if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
          }
        }
      }
      return out;
    }
  });

  /** Snapshot writes (query pages / entity refreshes) apply verbatim - server state is derived already. */
  const applySnapshot = (ops: JournalOp[]): void => {
    getApplyRuntime().apply(ops);
  };

  /** Imperative/domain writes are events: expand declared relation side effects into the same plan. */
  const applyEvent = (ops: JournalOp[]): void => {
    getApplyRuntime().apply(expandPlan(ops.map(op => (op.kind === 'upsert' && op.origin === undefined ? { ...op, origin: 'event' as const } : op))));
  };

  const scopeSortedRows = (scopeName: string, scopeValue: unknown): any[] => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<any>>)[scopeName];
    const value = planes().scopeIndex.read(keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter(Boolean);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    if ('comparator' in spec.sort) return [...rows].sort(spec.sort.comparator);
    const { field, dir } = spec.sort;
    return sortRows(rows, { orderBy: { field, direction: dir } });
  };

  const rowDep = (id: string, fields?: ReadonlyArray<string>): Dependency => ({ kind: 'row', model: config.id, id, ...(fields ? { fields } : {}) });
  const modelDep: Dependency = { kind: 'model', model: config.id };
  const scopeDep = (scopeKey: string): Dependency => ({ kind: 'scope', model: config.id, scopeKey });
  const memberDeps = (scopeKey: string): Dependency[] => [scopeDep(scopeKey)];

  const makeScopeHandle = (scopeName: string): ScopeHandle<any, Record<string, unknown>> => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<any>>)[scopeName];
    const planApply = (scopeValue: unknown, rows: Array<{ row: any; edge?: Record<string, unknown> }>, coverage: Coverage, opts?: { resetOrder?: boolean }): JournalOp[] => {
      const liveRows = rows.filter(({ row }) => isPlanRow(row)).filter(({ row }) => !planes().entityState.isTombstoned(String(row.id)));
      const scopeKey = keyForScope(scopeName, scopeValue);
      let { next } = planes().scopeIndex.reconcileNext(
        scopeKey,
        coverage,
        liveRows.map(({ row, edge }) => ({ id: row.id, edge })),
        opts
      );
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (opts?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        next = planes().scopeIndex.trimValue(next, maxRows).next;
      }
      return [
        { kind: 'upsert', model: config.id, rows: liveRows.map(({ row }) => row) },
        { kind: 'scope', model: config.id, scopeKey, next }
      ];
    };
    return {
      modelId: config.id,
      use: (scopeValue: unknown) => {
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        const signature = incrementalSignature('scope', config.id, scopeName, scopeValue);
        return useIncrementalRead({
          signature,
          deps: scopeKey == null ? [] : memberDeps(scopeKey),
          create: () =>
            createScopeReadEngine({
              signature,
              model: config.id,
              scopeKey: scopeKey ?? '',
              initial: () => (scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue)),
              read: id => planes().entityState.read(id),
              sort:
                spec?.sort === 'server-order' || spec?.sort == null
                  ? 'server-order'
                  : 'comparator' in spec.sort
                    ? spec.sort
                    : { field: String(spec.sort.field), direction: spec.sort.dir }
            })
        });
      },
      useWindow: (scopeValue: unknown, options?: { pageSize?: number }) => {
        const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        const [windowState, setWindowState] = useState({ scopeKey, size: pageSize });
        const windowSize = windowState.scopeKey === scopeKey ? windowState.size : pageSize;
        if (windowState.scopeKey !== scopeKey) setWindowState({ scopeKey, size: pageSize });
        const signature = incrementalSignature('scope-window', config.id, scopeName, scopeValue, windowSize);
        const deps = useMemo(() => (scopeKey == null ? [] : memberDeps(scopeKey)), [scopeKey]);
        const rows = useIncrementalRead({
          signature,
          deps,
          create: () =>
            createScopeReadEngine({
              signature,
              model: config.id,
              scopeKey: scopeKey ?? '',
              initial: () => (scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue)),
              read: id => planes().entityState.read(id),
              windowSize,
              sort:
                spec?.sort === 'server-order' || spec?.sort == null
                  ? 'server-order'
                  : 'comparator' in spec.sort
                    ? spec.sort
                    : { field: String(spec.sort.field), direction: spec.sort.dir }
            })
        });
        const windowRef = useRef<{ source: any[]; size: number; window: any[] }>({ source: EMPTY_ROWS, size: 0, window: EMPTY_ROWS });
        if (windowRef.current.source !== rows || windowRef.current.size !== windowSize) {
          windowRef.current = { source: rows, size: windowSize, window: rows.slice(0, windowSize) };
        }
        return {
          rows: windowRef.current.window,
          totalCount: rows.length,
          hasMore: rows.length > windowSize,
          loadMore: () => setWindowState(current => (current.scopeKey === scopeKey ? { ...current, size: current.size + pageSize } : { scopeKey, size: pageSize + pageSize }))
        };
      },
      useCount: (scopeValue: unknown) =>
        useLiveRead(
          () => (scopeValue == null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length),
          scopeValue == null ? [] : [scopeDep(keyForScope(scopeName, scopeValue))]
        ),
      invalidate: (scopeValue?: unknown) => {
        invalidateModel(config.id, scopeValue);
      },
      read: (scopeValue: unknown) => scopeSortedRows(scopeName, scopeValue),
      __apply: (scopeValue: unknown, rows: any[], coverage: Coverage, opts?: { resetOrder?: boolean }) => {
        applySnapshot(
          planApply(
            scopeValue,
            rows.map(row => ({ row })),
            coverage,
            opts
          )
        );
      },
      __planApply: planApply
    };
  };

  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)])) as {
    [K in keyof TScopes]: ScopeHandle<any, ScopeValueOf<TScopes[K]>>;
  };

  const planRows = (rows: any[]): JournalOp[] => [{ kind: 'upsert', model: config.id, rows: rows.filter(isPlanRow) }];

  const captureMembership = (id: string): Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }> =>
    planes()
      .scopeIndex.keysOf(id)
      .flatMap(scopeKey => {
        const entry = planes()
          .scopeIndex.read(scopeKey)
          .entries.find(candidate => candidate.id === id);
        return entry ? [{ id, scopeKey, order: entry.order, edge: entry.edge }] : [];
      });

  const restoreMembership = (nextId: string, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[] =>
    memberships.map(membership => ({
      kind: 'scope-delta' as const,
      model: config.id,
      scopeKey: membership.scopeKey,
      append: [{ id: nextId, order: membership.order, edge: membership.edge }],
      detach: [membership.id]
    }));

  const replacementId = (next: unknown): string | null => {
    try {
      return normalize(next).id;
    } catch {
      return null;
    }
  };

  const planReplace = (oldId: string, next: unknown): JournalOp[] => {
    const memberships = captureMembership(oldId);
    const nextId = replacementId(next);
    return [
      { kind: 'destroy', model: config.id, ids: [oldId] },
      { kind: 'upsert', model: config.id, rows: [next], origin: 'replace' },
      ...(nextId == null ? [] : restoreMembership(nextId, memberships))
    ];
  };

  const planRestore = (next: unknown, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[] => {
    const nextId = replacementId(next);
    return [{ kind: 'upsert', model: config.id, rows: [next], origin: 'replace' }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
  };

  const model: ModelCore<any> & { scopes: typeof scopeHandles } = {
    modelId: config.id,
    get: id => (id == null ? undefined : planes().entityState.read(id)),
    getWhere: (where, options) =>
      sortRows(
        planes()
          .entityState.values()
          .filter(row => matchesDbWhere(row, where)),
        options
      ),
    getAll: () => planes().entityState.values(),
    patch: (id, patch) => applyEvent([{ kind: 'patch', model: config.id, id, patch: patch as Record<string, unknown> }]),
    destroy: id => applyEvent([{ kind: 'destroy', model: config.id, ids: [id] }]),
    destroyMany: ids => applyEvent([{ kind: 'destroy', model: config.id, ids }]),
    insertStored: row => applyEvent([{ kind: 'upsert', model: config.id, rows: [row] }]),
    replaceRaw: (oldId, next) => applyEvent(planReplace(oldId, next)),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      invalidateModel(config.id, scope);
    },
    use: {
      row: (id, options) => {
        const select = options?.select as ReadonlyArray<string> | undefined;
        return useLiveRead(() => (id == null ? undefined : planes().entityState.read(id)), id == null ? [] : [rowDep(id, select)]);
      },
      field: (id, field) => useLiveRead(() => (id == null ? undefined : planes().entityState.read(id)?.[field]), id == null ? [] : [rowDep(id, [String(field)])]),
      first: (where, options) =>
        useIncrementalRead({
          signature: incrementalSignature('first', config.id, where, options),
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature: incrementalSignature('first', config.id, where, options),
              model: config.id,
              where: row => where == null || matchesDbWhere(row, where),
              options: options
                ? { orderBy: options.orderBy ? { field: String(options.orderBy.field), direction: options.orderBy.direction } : undefined, limit: options.limit }
                : undefined,
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => rows[0]
            })
        }),
      where: (where, options) =>
        useIncrementalRead({
          signature: incrementalSignature('where', config.id, where, options),
          deps: where == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine({
              signature: incrementalSignature('where', config.id, where, options),
              model: config.id,
              where: row => where != null && matchesDbWhere(row, where),
              options: options
                ? { orderBy: options.orderBy ? { field: String(options.orderBy.field), direction: options.orderBy.direction } : undefined, limit: options.limit }
                : undefined,
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => rows
            })
        }),
      byIds: ids =>
        useLiveRead(
          () => ids.map(id => planes().entityState.read(id)).filter(Boolean),
          ids.map(id => rowDep(id)),
          arraysShallowEqual
        ),
      count: where =>
        useIncrementalRead({
          signature: incrementalSignature('count', config.id, where),
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature: incrementalSignature('count', config.id, where),
              model: config.id,
              where: row => where == null || matchesDbWhere(row, where),
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: (_rows, count) => count,
              countOnly: true
            })
        }),
      related: (id, relationName) => {
        const relation = resolvedRelations()[relationName];
        if (!relation) throw new Error(`${config.name} has no relation ${relationName}`);
        let compute: () => unknown;
        let deps: Dependency[];
        let isEqual: (a: unknown, b: unknown) => boolean = Object.is;
        if (relation.kind === 'belongsTo') {
          const parentIdOf = (): string | null => {
            const child = id == null ? undefined : planes().entityState.read(id);
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
        } else if (relation.kind === 'hasOne') {
          const comparator = relation.comparator;
          compute = () => {
            if (id == null) return undefined;
            const rows = relation.model.getWhere({ [relation.foreignKey]: id });
            if (rows.length === 0) return undefined;
            return comparator ? rows.reduce((best, row) => (comparator(row, best) < 0 ? row : best)) : rows[0];
          };
          deps = id == null ? [] : [{ kind: 'model', model: relation.model.modelId }];
        } else {
          compute = () => undefined;
          deps = [];
        }
        return useLiveRead(compute, deps, isEqual);
      }
    },
    scopes: scopeHandles,
    registerReset: fn => {
      registerReset(fn);
    },
    __applyRows: rows => applySnapshot(planRows(rows)),
    __planRows: planRows,
    __planReplace: planReplace,
    __captureMembership: captureMembership,
    __planRestore: planRestore
  };

  registerReset(() => {
    planesRef?.entityState.reset();
    planesRef?.scopeIndex.reset();
    // The apply target stays registered: a model must keep working after the kill-switch.
  });

  const statics = config.statics?.(model);
  if (statics) {
    for (const key of Object.keys(statics)) {
      if (key in model) throw new Error(`${config.name} statics collide with base model key ${key}`);
    }
  }
  return Object.assign(model, statics);
};

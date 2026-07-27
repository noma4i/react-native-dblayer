import { sortBy } from 'es-toolkit';
import type { DbGraphQLDocument, DbReadOptions, DbWhere, ModelFieldSpecs } from '../types';
import { buildScopeKey } from '../core/compileDbWhere';
import { compositeKey } from '../core/serialize';
import type { Dependency } from '../core/apply/commitBus';
import { registerApplyTarget } from '../core/apply/transaction';
import { registerSchemaDeclaration } from '../core/schemaManifest';
import { useScopeReadRows, useScopeReadWindowRows } from '../read/scopeReadEngine';
import type { JournalOp } from '../core/apply/journal';
import { createCommitEnvelope } from '../core/apply/transaction';
import { registerGcHost } from '../core/gc';
import { type ScopeIndexValue } from '../core/planes/scopeIndex';
import { invalidateModel } from '../core/invalidationRegistry';
import { getDbLogger } from '../core/logger';
import { noteDataLoss, noteReplaceRejected } from '../core/diagnostics';
import { registerRelationHost, type RelationDecl } from '../core/relations';
import { registerReset } from '../core/reset';
import { createModelNormalization } from './modelNormalization';
import { createModelScopeKeys } from './modelScopeKeys';
import { createModelCriteria } from './modelCriteria';
import { createModelContext } from './modelContext';
import { createModelMembership } from './modelMembership';
import { useLiveRead, arraysShallowEqual, rowsShallowEqual } from '../read/useLiveRead';
import { createProjectionGate, useProjectedLiveRow, useProjectedLiveRows, validateProjectionOptions, type ProjectionOptions } from '../read/projectionGate';
import type { KeepPreviousOption } from '../read/scopeRetention';
import { createModelReadEngine, incrementalSignature, limitRows, sortModelReadRows, useIncrementalRead } from '../read/incrementalReadEngine';
import { getApplyRuntime, getCommitBus, getDbRuntimeConfig, getOperationState } from './configure';
import { defineFetch } from './defineFetch';
import { clearFailedOptimisticMutation, defineMutation, type MutationConfig } from './defineMutation';
import { defineDetachedOperation, type DetachedOperationConfig, type DetachedOperationHandle } from './defineDetachedOperation';
import { defineQuery, type EnsuredRowQueryHandle, type QueryHandle } from './defineQuery';
import { defineView, type ViewConfig, type ViewHandle } from './defineView';
import { defineModelIngest, registerIngestModel, type ModelIngestEntry } from './defineIngest';
import type { DbSubscriptionEntry } from '../core/subscriptionRuntime';
import { createReadBuilder, type ModelReadBuilder, type ReadOrder } from './readBuilder';
import { hasRequiredFields } from '../read/requireFields';
import type { RequiredFields } from './readBuilder';
import type { ScopeCoverage, ScopeSpec } from './scope';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { InferBuildInput, InferStoredFields } from '../schema/infer';
import { getDbTransport } from '../core/transport';
import { createModelStatusPoller, type ModelStatusPoller } from '../utils/modelStatusPoller';
import { resolveStaleTempRows, trimRowsPerScope } from '../utils/modelMaintenance';
import { registerModelMaintenance, type MaintenanceReport } from './maintenanceRegistry';
import { createDbSubscriptionRuntime } from '../core/subscriptionRuntime';
import { registerInternalModelHandle, registerInternalScopeHandle } from '../core/internalHandles';
import type { WriteOrigin, WritePolicy } from '../core/writePolicies';

export type { GuardedOrigin, MonotonicSpec, NestedKeyPolicy, WriteCtx, WriteGroup, WriteOrigin, WritePolicy } from '../core/writePolicies';

import type {
  LiveQueryHandle,
  ModelConfig,
  ModelCore,
  ModelFetchConfig,
  ModelMutationConfig,
  ModelQueryConfig,
  QueryScopeReads,
  QueryScopeSpec,
  RequiredReadUse,
  ScopeHandle,
  ScopeSortSpec,
  ScopeValueOf,
  ScopeWindowResult,
  StoredRowShape
} from '../types/dsl.model.types';

export type { LiveQueryHandle, ModelConfig, ModelCore, ScopeHandle, ScopeValueOf, ScopeWindowResult } from '../types/dsl.model.types';

const issuedScopeSequenceByKey = new Map<string, number>();

registerReset(() => {
  issuedScopeSequenceByKey.clear();
});

const EMPTY_ROWS: never[] = [];


const sortRowsBySpec = <TRow extends { id: string }>(rows: TRow[], sort: ScopeSortSpec<TRow>): TRow[] =>
  'comparator' in sort ? [...rows].sort(sort.comparator) : sortModelReadRows(rows, [{ field: String(sort.field), direction: sort.dir }]);

const matchesMemberPredicate = <TRow,>(spec: { member?: (row: TRow) => boolean } | undefined, row: TRow): boolean => spec?.member?.(row) ?? true;

/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export const defineModel = <
  const TFields extends ModelFieldSpecs,
  TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>> = {},
  TExt extends Record<string, unknown> = {},
  TQueryScopes extends Record<string, QueryScopeSpec<InferStoredFields<TFields>>> = {}
>(
  config: ModelConfig<TFields, TScopes, TExt, TQueryScopes>
): Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, 'use' | 'scopes'> & {
  use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
  scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>> };
} & TExt => {
  type Stored = InferStoredFields<TFields> & Record<string, unknown>;
  type Input = InferBuildInput<TFields>;
  const { applyWriteGate, isPlanRow, normalize } = createModelNormalization(config);
  const context = createModelContext<Stored>({
    modelId: config.id,
    scopeNames: Object.keys(config.scopes ?? {}),
    relations: () => config.relations?.() ?? {},
    applyWriteGate
  });
  const { planes, resolvedRelations } = context;

  const membershipScopes = Object.entries(config.scopes ?? {}).flatMap(([name, spec]) => (spec.by ? [[name, { ...spec, by: spec.by }] as const] : []));

  const scopeByFieldMap = new Map(membershipScopes.map(([name, spec]) => [name, spec.by] as const));
  const { keyForScope, scopeValueFromRow } = createModelScopeKeys(config, scopeByFieldMap);
  const { matches: matchesCriteria } = createModelCriteria<Stored>(config.fields);

  const { membershipForUpsert, detachForDestroy } = createModelMembership<Stored>({
    membershipScopes,
    keyForScope,
    scopeValueFromRow,
    isScopeMember: (scopeKey, id) => planes().scopeIndex.has(scopeKey, id),
    scopeKeysOf: id => planes().scopeIndex.keysOf(id)
  });

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
    detachForDestroy
  });

  const writeRows = (rows: unknown[], origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: Stored, operationId?: string): Array<{ id: string; changedFields: string[] | null }> => {
    const changes: Array<{ id: string; changedFields: string[] | null }> = [];
    for (const value of rows) {
      let incoming: Stored;
      try {
        incoming = normalize(value);
      } catch (error) {
        getDbLogger().error(`[${config.name}] apply row rejected`, { error });
        continue;
      }
      if (origin === undefined && planes().entityState.isTombstoned(incoming.id)) continue;
      const result = planes().entityState.upsert(incoming, { mergeBase: origin === 'replace' ? mergeBase : undefined, ctx: { origin: origin ?? 'snapshot', operationId } });
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({ id: incoming.id, changedFields: result.changedFields });
    }
    if (changes.length > 0) context.bumpRevision();
    return changes;
  };

  const patchRow = (id: string, patch: Record<string, unknown>, operationId?: string): { id: string; changedFields: string[] | null } | null => {
    const key = String(id);
    const current = planes().entityState.read(key);
    if (!current) return null;
    const row = { ...patch, id: key } as Stored;
    const result = planes().entityState.upsert(row, { ctx: { origin: 'patch', operationId } });
    if (result.changedFields !== null && result.changedFields.length === 0) return null;
    context.bumpRevision();
    return { id: key, changedFields: result.changedFields };
  };

  const applyTarget = {
    readRow: (id: string): Record<string, unknown> | undefined => planes().entityState.read(id),
    readAllRows: (): Array<Record<string, unknown>> => planes().entityState.values(),
    readScopeOrder: (scopeKey: string): string[] => {
      const separator = scopeKey.indexOf(`\0`);
      const scopeName = separator < 0 ? scopeKey : scopeKey.slice(0, separator);
      const rawValue = separator < 0 ? `{}` : scopeKey.slice(separator + 1);
      try {
        return scopeSortedRows(scopeName, JSON.parse(rawValue)).map(row => String(row.id));
      } catch {
        return planes()
          .scopeIndex.read(scopeKey)
          .entries.map(entry => entry.id);
      }
    },
    readScopeOrderRevision: (scopeKey: string): number => planes().scopeIndex.orderRevision(scopeKey),
    readScopeGeneration: (scopeKey: string): number => planes().scopeIndex.read(scopeKey).generation,
    scopeOrderAffected: (scopeKey: string, id: string, fields: string[] | null): boolean => {
      if (fields === null || !planes().scopeIndex.has(scopeKey, id)) return true;
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`\0`));
      const spec = (config.scopes as Record<string, ScopeSpec<Stored>> | undefined)?.[scopeName];
      if (!spec) return false;
      const relevant = new Set<string>(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== 'server-order' && 'field' in spec.sort) relevant.add(String(spec.sort.field));
      if (spec.sort && spec.sort !== 'server-order' && 'comparator' in spec.sort) {
        if (spec.sort.orderFields === undefined) return true;
        for (const field of spec.sort.orderFields) relevant.add(field);
      }
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: (scopeKey: string) => {
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`\0`));
      const sort = (config.scopes as Record<string, ScopeSpec<Stored>> | undefined)?.[scopeName]?.sort;
      if (!sort || sort === 'server-order') return { kind: 'server-order' as const };
      if ('comparator' in sort) return { kind: 'comparator' as const };
      return { kind: 'field' as const, field: String(sort.field), dir: sort.dir };
    },
    readAllScopeKeys: (): string[] => planes().scopeIndex.keys(),
    upsert: writeRows,
    patch: patchRow,
    destroy: (ids: string[], tombstone?: boolean): string[] => {
      const removed: string[] = [];
      for (const id of ids) {
        const key = String(id);
        const existed = planes().entityState.read(key) !== undefined;
        planes().entityState.destroy(key, { tombstone });
        if (existed) removed.push(key);
      }
      if (removed.length > 0) context.bumpRevision();
      return removed;
    },
    counter: (id: string, field: string, delta: number, next?: number): boolean => {
      const key = String(id);
      const current = planes().entityState.read(key)?.[field];
      return patchRow(key, { [field]: next ?? ((current as number | undefined) ?? 0) + delta }) !== null;
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
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()],
    ackPersist: () => {
      planes().entityState.ackPersist();
      planes().scopeIndex.ackPersist();
    }
  };
  registerApplyTarget(config.id, applyTarget);
  registerSchemaDeclaration({
    id: config.id,
    name: config.name,
    fields: Object.fromEntries(Object.entries(config.fields).map(([name, field]) => [name, { kind: field.kind, mode: field.mode, hasDefault: field.hasDefault }])),
    scopes: Object.fromEntries(
      Object.entries(config.scopes ?? {}).map(([name, spec]) => {
        const by = spec.by ? Object.fromEntries(Object.entries(spec.by).map(([scopeField, rowField]) => [scopeField, String(rowField)])) : null;
        const sort = spec.member ? 'member' : !spec.sort || spec.sort === 'server-order' ? 'server-order' : 'field' in spec.sort ? `field:${String(spec.sort.field)}:${spec.sort.dir}` : 'comparator';
        return [name, { by, sort }];
      })
    )
  });
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
    idleScopeAfterMs: () => config.maintenance?.dropIdleScopesAfterMs,
    scopeLastAccess: key => planes().scopeIndex.lastAccess(key),
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
    getApplyRuntime().commit(createCommitEnvelope(ops));
  };

  /** Imperative/domain writes are events; relation effects derive from rows accepted by apply. */
  const applyEvent = (ops: JournalOp[]): void => {
    getApplyRuntime().commit(createCommitEnvelope(ops.map(op => (op.kind === 'upsert' && op.origin === undefined ? { kind: 'upsert' as const, model: op.model, rows: op.rows, origin: 'event' as const } : op))));
  };

  const scopeSortedRows = (scopeName: string, scopeValue: unknown): Stored[] => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<Stored>>)[scopeName];
    const value = planes().scopeIndex.read(keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter((row): row is Stored => row !== undefined);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    return sortRowsBySpec(rows, spec.sort);
  };

  const rowDep = (id: string, fields?: ReadonlyArray<string>): Dependency => ({ kind: 'row', model: config.id, id, ...(fields ? { fields } : {}) });
  const modelDep: Dependency = { kind: 'model', model: config.id };
  const scopeDep = (scopeKey: string): Dependency => ({ kind: 'scope', model: config.id, scopeKey });
  const memberDeps = (scopeKey: string): Dependency[] => [scopeDep(scopeKey)];
  const useScopeAccess = (scopeKey: string | null): void => {
    useEffect(() => {
      if (scopeKey != null) planes().scopeIndex.noteAccess(scopeKey);
    }, [scopeKey]);
  };

  function whereRead(where: DbWhere<Stored> | null): ModelReadBuilder<Stored> {
    const defaultOrders: ReadonlyArray<ReadOrder<Stored>> = config.defaultOrder ? [config.defaultOrder] : [];
    return createReadBuilder(where, {
      rows: <TOutput extends Record<string, unknown>>(
        criteria: DbWhere<Stored> | null,
        orders: readonly ReadOrder<Stored>[],
        limit: number | undefined,
        required: readonly string[],
        projection: ProjectionOptions<Stored, TOutput>
      ): TOutput[] => {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        validateProjectionOptions(projection, `${config.id}.use.where`);
        const projectionRef = useRef(projection);
        const gateRef = useRef(createProjectionGate<Stored, TOutput>());
        projectionRef.current = projection;
        const signature = incrementalSignature('where-builder', config.id, buildScopeKey({ criteria, orders: effectiveOrders, limit, required }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine({
              signature,
              model: config.id,
              where: row => criteria != null && matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              options: { orderBy: effectiveOrders as ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => gateRef.current.projectRows(rows, projectionRef.current),
              isEqual: arraysShallowEqual
            })
        });
      },
      pluck: (criteria, orders, limit, required, projection, field) => {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        const projectionRef = useRef(projection);
        projectionRef.current = projection;
        const signature = incrementalSignature('where-pluck', config.id, buildScopeKey({ criteria, orders: effectiveOrders, limit, required, field }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine<Stored, unknown[]>({
              signature,
              model: config.id,
              where: row => criteria != null && matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              options: { orderBy: effectiveOrders as ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => {
                const selector = projectionRef.current.select;
                const projected: readonly object[] = selector ? rows.map(row => selector(row)) : rows;
                return projected.map(row => Reflect.get(row, field));
              },
              isEqual: arraysShallowEqual
            })
        });
      },
      exists: (criteria, required) => {
        const signature = incrementalSignature('where-exists', config.id, buildScopeKey({ criteria, required }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () =>
            createModelReadEngine<Stored, boolean>({
              signature,
              model: config.id,
              where: row => criteria != null && matchesCriteria(row, criteria) && hasRequiredFields(row, required),
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: (_rows, count) => count > 0,
              countOnly: true
            })
        });
      }
    });
  }

  const makeScopeHandle = (scopeName: string): ScopeHandle<Stored, Record<string, unknown>, Input> => {
    const spec = ((config.scopes ?? {}) as Record<string, ScopeSpec<Stored>>)[scopeName];
    const planScope = (
      scopeKey: string,
      liveRows: Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      opts?: { resetOrder?: boolean }
    ): JournalOp => {
      let { next, detachedIds } = planes().scopeIndex.reconcileNext(
        scopeKey,
        coverage,
        liveRows.map(({ row, edge }) => ({ id: String(row.id), edge })),
        opts
      );
      if (detachedIds.length > 0) noteDataLoss('scope-complete-detach', config.id, detachedIds.length);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (opts?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        if (spec.sort && spec.sort !== 'server-order') {
          const scopeSort = spec.sort;
          const incomingById = new Map(
            liveRows.flatMap(({ row }) => {
              try {
                const stored = normalize(row);
                return [[String(stored.id), stored] as const];
              } catch {
                return [];
              }
            })
          );
          const rowsById = new Map(
            next.entries.flatMap(entry => {
              const row = incomingById.get(entry.id) ?? planes().entityState.read(entry.id);
              return row ? [[entry.id, row] as const] : [];
            })
          );
          const ordered = sortRowsBySpec([...rowsById.values()], scopeSort);
          const positions = new Map(ordered.map((row, index) => [String(row.id), index]));
          next = {
            ...next,
            entries: sortBy(next.entries, [entry => positions.get(entry.id) ?? Number.MAX_SAFE_INTEGER])
          };
        }
        const trimmed = planes().scopeIndex.trimValue(next, maxRows);
        if (trimmed.trimmedIds.length > 0) noteDataLoss('scope-retention-trim', config.id, trimmed.trimmedIds.length);
        next = trimmed.next;
      }
      return { kind: 'scope', model: config.id, scopeKey, next };
    };
    const planApply = (
      scopeValue: unknown,
      rows: Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>,
      coverage: ScopeCoverage,
      opts?: { resetOrder?: boolean }
    ): JournalOp[] => {
      const liveRows = rows.filter(({ row }) => isPlanRow(row)).filter(({ row }) => !planes().entityState.isTombstoned(String(row.id)));
      const requestedScopeKey = keyForScope(scopeName, scopeValue);
      const upsert: JournalOp = { kind: 'upsert', model: config.id, rows: liveRows.map(({ row }) => row) };
      if (!spec?.by) return [upsert, planScope(requestedScopeKey, liveRows, coverage, opts)];

      const rowsByScope = new Map<string, Array<{ row: Record<string, unknown>; edge?: Record<string, unknown> }>>();
      for (const entry of liveRows) {
        if (!matchesMemberPredicate<Stored>(spec, entry.row as Stored)) continue;
        const derivedValue = scopeValueFromRow(spec.by, entry.row);
        if (!derivedValue) continue;
        const derivedKey = keyForScope(scopeName, derivedValue);
        const group = rowsByScope.get(derivedKey) ?? [];
        group.push(entry);
        rowsByScope.set(derivedKey, group);
      }
      const requestedRows = rowsByScope.get(requestedScopeKey) ?? [];
      rowsByScope.delete(requestedScopeKey);
      return [upsert, planScope(requestedScopeKey, requestedRows, coverage, opts), ...[...rowsByScope].map(([scopeKey, scopeRows]) => planScope(scopeKey, scopeRows, 'delta'))];
    };
    const readScopeRows = (scopeValue: unknown, options: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
      const scopeKey = scopeValue === null ? null : keyForScope(scopeName, scopeValue);
      useScopeAccess(scopeKey);
      return useScopeReadRows(
        config.id,
        scopeKey,
        applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')),
        () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0,
        options
      );
    };
    const scopeHandle = {
      modelId: config.id,
      use: readScopeRows,
      useFirst: (scopeValue: unknown, options: { renderKeys?: readonly string[] } & KeepPreviousOption = {}) =>
        readScopeRows(scopeValue, options as ProjectionOptions<StoredRowShape, Record<string, unknown>>)[0],
      useWindow: (scopeValue: unknown, options: { pageSize?: number; keepPrevious?: boolean } & ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}) => {
        const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue === null ? null : keyForScope(scopeName, scopeValue);
        const windowStateRef = useRef({ scopeKey, size: pageSize });
        const [, setWindowRevision] = useState(0);
        if (windowStateRef.current.scopeKey !== scopeKey) windowStateRef.current = { scopeKey, size: pageSize };
        const windowSize = windowStateRef.current.size;
        useScopeAccess(scopeKey);
        const window = useScopeReadWindowRows(
          config.id,
          scopeKey,
          applyTarget.scopeSortMeta(scopeKey ?? compositeKey(scopeName, '')),
          windowSize,
          () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0,
          options
        );
        return {
          rows: window.rows,
          totalCount: window.totalCount,
          hasMore: window.totalCount > windowSize,
          isPreviousData: window.isPreviousData,
          resolved: window.resolved,
          fetchNextPage: () => {
            windowStateRef.current =
              windowStateRef.current.scopeKey === scopeKey ? { ...windowStateRef.current, size: windowStateRef.current.size + pageSize } : { scopeKey, size: pageSize + pageSize };
            setWindowRevision(current => current + 1);
          }
        };
      },
      useCount: (scopeValue: unknown) => {
        const scopeKey = scopeValue === null ? null : keyForScope(scopeName, scopeValue);
        useScopeAccess(scopeKey);
        return useLiveRead(
          () => (scopeValue === null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length),
          scopeKey == null ? [] : [scopeDep(scopeKey)]
        );
      },
      invalidate: (scopeValue?: unknown) => {
        invalidateModel(config.id, scopeValue);
      },
      read: (scopeValue: unknown) => {
        const scopeKey = keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        return scopeSortedRows(scopeName, scopeValue);
      },
      issueSequence: (scopeValue: unknown, field: keyof Stored & string) => {
        if (scopeValue === null) throw new Error(`${config.name}.${scopeName}.issueSequence requires a scope value`);
        const scopeKey = keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        const maxFieldValue = scopeSortedRows(scopeName, scopeValue).reduce((maximum, row) => {
          const value = row[field];
          return typeof value === 'number' && value > maximum ? value : maximum;
        }, 0);
        const issuedKey = compositeKey(config.id, scopeKey, field);
        const maxIssuedThisSession = issuedScopeSequenceByKey.get(issuedKey) ?? 0;
        const next = Math.max(maxFieldValue, maxIssuedThisSession) + 1;
        issuedScopeSequenceByKey.set(issuedKey, next);
        return next;
      },
      seed: (scopeValue: unknown, rows: Input[]) => {
        const liveRows = rows
          .filter(isPlanRow)
          .filter(row => !planes().entityState.isTombstoned(String(row.id)))
          .map(row => ({ row: row as Record<string, unknown> }));
        applyEvent([
          { kind: 'upsert', model: config.id, rows: liveRows.map(entry => entry.row) },
          planScope(keyForScope(scopeName, scopeValue), liveRows, 'complete', { resetOrder: true })
        ]);
      }
    } as ScopeHandle<Stored, Record<string, unknown>, Input>;
    registerInternalScopeHandle(scopeHandle, {
      apply: (scopeValue, rows, coverage, options) => {
        applySnapshot(
          planApply(
            scopeValue,
            rows.map(row => ({ row: row as Record<string, unknown> })),
            coverage,
            options
          )
        );
      },
      planApply,
      key: scopeValue => keyForScope(scopeName, scopeValue),
      isServerOrder: () => !spec?.sort || spec.sort === 'server-order',
      planPlacement: (scopeValue, id, position) => {
        const scopeKey = keyForScope(scopeName, scopeValue);
        const entries = planes().scopeIndex.read(scopeKey).entries;
        const order = position === 'prepend' ? Math.min(0, ...entries.map(entry => entry.order)) - 1 : Math.max(-1, ...entries.map(entry => entry.order)) + 1;
        return [{ kind: 'scope-delta', model: config.id, scopeKey, append: [{ id, order }], detach: [] }];
      },
      readRows: scopeValue => scopeSortedRows(scopeName, scopeValue),
      isResolved: scopeValue => planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).generation > 0,
      noteAccess: scopeValue => {
        planes().scopeIndex.noteAccess(keyForScope(scopeName, scopeValue));
      }
    });
    return scopeHandle;
  };

  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)])) as {
    [K in keyof TScopes]: ScopeHandle<Stored, ScopeValueOf<TScopes[K]>, Input>;
  };

  const planRows = (rows: unknown[], options?: { origin?: 'event' }): JournalOp[] => {
    const accepted = rows.filter(isPlanRow);
    return [{ kind: 'upsert', model: config.id, rows: accepted, ...(options?.origin ? { origin: options.origin } : {}) }];
  };

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
    let normalized: Stored;
    try {
      normalized = normalize(next);
    } catch (error) {
      getDbLogger().error('replace rejected', { model: config.id, oldId, error });
      noteReplaceRejected();
      noteDataLoss('replacement-rejected', config.id, 1);
      throw new Error(`replace rejected for ${config.id}:${oldId}`);
    }
    // Reconciliation and mutation commit share this replacement seam, so both clear retained failure state.
    clearFailedOptimisticMutation(config.id, oldId);
    const mergeBase = planes().entityState.read(oldId);
    const memberships = captureMembership(oldId);
    const nextId = normalized.id;
    return [
      { kind: 'destroy', model: config.id, ids: [oldId], origin: 'replace' },
      { kind: 'upsert', model: config.id, rows: [next], origin: 'replace', mergeBase },
      ...(nextId == null ? [] : restoreMembership(nextId, memberships))
    ];
  };

  const planRestore = (next: unknown, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[] => {
    const nextId = replacementId(next);
    return [{ kind: 'upsert', model: config.id, rows: [next], origin: 'replace' }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
  };

  const model: ModelCore<Stored, Input> & { scopes: typeof scopeHandles } = {
    modelId: config.id,
    // The runtime branch adds `live` exactly when the overload's live config is present.
    query: ((name, queryConfig) => {
      const { live, ...queryOptions } = queryConfig;
      const handle = defineQuery({
        ...queryOptions,
        key: queryConfig.key ?? compositeKey(config.id, name),
        into: queryConfig.into ?? (model as NonNullable<typeof queryConfig.into>)
      });
      if (!live) return handle;
      const compiled = defineModelIngest(model, live);
      let runtime: ReturnType<typeof createDbSubscriptionRuntime> | null = null;
      let readers = 0;
      const sync = () => {
        if (readers === 0) return;
        runtime ??= createDbSubscriptionRuntime(compiled.entries);
        runtime.setActive(true);
      };
      model.registerReset(() => {
        runtime?.setActive(false);
        runtime = null;
        sync();
      });
      return {
        ...handle,
        use: (scope: unknown, options?: { enabled?: boolean }) => {
          const result = handle.use(scope as never, options);
          useEffect(() => {
            readers += 1;
            sync();
            return () => {
              readers -= 1;
              if (readers === 0) runtime?.setActive(false);
            };
          }, []);
          return result;
        },
        live: { apply: compiled.apply }
      };
    }) as ModelCore<Stored, Input>['query'],
    mutation: (name, mutationConfig) => {
      /** Mutation dedupe keys are idempotency identities, not scope bucket keys; scope validation belongs to scope handles and queries. */
      const dedupe = mutationConfig.dedupe === false ? false : (mutationConfig.dedupe ?? { key: input => compositeKey(config.id, name, buildScopeKey(input)) });
      return defineMutation({ ...mutationConfig, dedupe });
    },
    detached: (kind, detachedConfig) => defineDetachedOperation(model, kind, detachedConfig),
    fetch: <TData, TFetchInput, TSelected>(name: string, fetchConfig: ModelFetchConfig<TData, TFetchInput, TSelected>) =>
      defineFetch<TData, TFetchInput, TSelected>({ ...fetchConfig, key: fetchConfig.key ?? compositeKey(config.id, name) } as Parameters<
        typeof defineFetch<TData, TFetchInput, TSelected>
      >[0]),
    view: (name, viewConfig) => defineView(model, name, viewConfig),
    poller: (name, pollerConfig) =>
      createModelStatusPoller({
        ...pollerConfig,
        fetch: async id => {
          try {
            return (await getDbTransport().query({ query: pollerConfig.document, variables: pollerConfig.vars?.(id) ?? { id } })).data;
          } catch (error) {
            getDbLogger().error('Model.poller', 'fetch failed', { key: compositeKey(config.id, name), id, error });
            throw error;
          }
        }
      }),
    ingest: entries => defineModelIngest(model, entries),
    find: id => (id == null ? undefined : planes().entityState.read(String(id))),
    where: (where, options) => {
      const rows = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where));
      const order = options?.orderBy ?? config.defaultOrder;
      if (!order) return limitRows(rows, options?.limit);
      return sortModelReadRows(rows, [{ field: String(order.field), direction: order.direction }], options?.limit);
    },
    all: () => planes().entityState.values(),
    update: (id, patch) => applyEvent([{ kind: 'patch', model: config.id, id: String(id), patch: patch as Record<string, unknown> }]),
    destroy: id => applyEvent([{ kind: 'destroy', model: config.id, ids: [String(id)] }]),
    destroyMany: ids => applyEvent([{ kind: 'destroy', model: config.id, ids: ids.map(id => String(id)) }]),
    updateAll: (where, patch) => {
      const rows = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where));
      if (rows.length === 0) return 0;
      applyEvent(rows.map(row => ({ kind: 'patch', model: config.id, id: String(row.id), patch: patch as Record<string, unknown> })));
      return rows.length;
    },
    destroyAll: where => {
      const ids = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where))
        .map(row => String(row.id));
      if (ids.length === 0) return 0;
      applyEvent([{ kind: 'destroy', model: config.id, ids }]);
      return ids.length;
    },
    insert: row => applyEvent([{ kind: 'upsert', model: config.id, rows: [row] }]),
    insertMany: rows => applyEvent([{ kind: 'upsert', model: config.id, rows }]),
    seed: rows => applyEvent(planRows(rows)),
    replace: (oldId, next) => applyEvent(planReplace(String(oldId), next)),
    build: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      invalidateModel(config.id, scope);
    },
    use: {
      pending: id => {
        const key = id == null ? null : String(id);
        const readPending = useCallback(() => key != null && getOperationState().pendingForRow(config.id, key).length > 0, [key]);
        const subscribePending = useCallback(
          (listener: () => void) => {
            if (key == null) return () => {};
            const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model: config.id, id: key }]);
            return () => subscription.unsubscribe();
          },
          [key]
        );
        return useSyncExternalStore(subscribePending, readPending, readPending);
      },
      failed: id => {
        const key = id == null ? null : String(id);
        const readFailed = useCallback(() => key != null && getOperationState().failedFor(config.id, key) !== undefined, [key]);
        const subscribeFailed = useCallback(
          (listener: () => void) => {
            if (key == null) return () => {};
            const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model: config.id, id: key }]);
            return () => subscription.unsubscribe();
          },
          [key]
        );
        return useSyncExternalStore(subscribeFailed, readFailed, readFailed);
      },
      unsyncedChanges: (id: string | null | undefined) => {
        const key = id == null ? null : String(id);
        const cacheRef = useRef<Partial<Stored> | undefined>(undefined);
        const readChanges = useCallback(() => {
          if (key == null) return undefined;
          let merged: Record<string, unknown> | undefined;
          for (const operation of getOperationState().pendingForRow(config.id, key)) {
            if (operation.intent !== 'patch') continue;
            if (!operation.patchedValues) continue;
            merged = { ...(merged ?? {}), ...operation.patchedValues };
          }
          const next = merged as Partial<Stored> | undefined;
          const previous = cacheRef.current;
          if (previous && next && rowsShallowEqual(previous, next)) return previous;
          cacheRef.current = next;
          return next;
        }, [key]);
        const subscribeChanges = useCallback(
          (listener: () => void) => {
            if (key == null) return () => {};
            const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model: config.id, id: key }]);
            return () => subscription.unsubscribe();
          },
          [key]
        );
        return useSyncExternalStore(subscribeChanges, readChanges, readChanges);
      },
      find: ((id: string | null | undefined, options: { require?: readonly string[] } & ProjectionOptions<Stored, Record<string, unknown>> = {}) => {
        const required = options?.require ?? [];
        const key = id == null ? undefined : String(id);
        return useProjectedLiveRow(
          () => {
            const row = key == null ? undefined : planes().entityState.read(key);
            return hasRequiredFields(row, required) ? row : undefined;
          },
          key == null ? [] : [rowDep(key, required.length > 0 ? required : undefined)],
          options,
          `${config.id}.use.find`
        );
      }) as ModelCore<Stored, Input>['use']['find'],
      field: (id, field) => {
        const key = id == null ? undefined : String(id);
        return useLiveRead(() => (key == null ? undefined : planes().entityState.read(key)?.[field]), key == null ? [] : [rowDep(key, [String(field)])]);
      },
      first: ((
        where: DbWhere<Stored> | null | undefined,
        options: DbReadOptions<Stored> & { require?: readonly string[] } & ProjectionOptions<Stored, Record<string, unknown>> = {}
      ) => {
        validateProjectionOptions(options, `${config.id}.use.first`);
        const optionsRef = useRef(options);
        const gateRef = useRef(createProjectionGate<Stored, Record<string, unknown>>());
        optionsRef.current = options;
        const order = options.orderBy ?? config.defaultOrder;
        const signature = incrementalSignature('first', config.id, where, order, options.limit, options.require);
        return useIncrementalRead({
          signature,
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature,
              model: config.id,
              where: row => (where == null || matchesCriteria(row, where)) && hasRequiredFields(row, optionsRef.current.require ?? []),
              options: order ? { orderBy: [{ field: String(order.field), direction: order.direction }], limit: options.limit } : { limit: options.limit },
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: rows => (rows[0] ? gateRef.current.project(rows[0], optionsRef.current) : undefined),
              isEqual: Object.is
            })
        });
      }) as ModelCore<Stored, Input>['use']['first'],
      where: whereRead,
      byIds: ((ids: readonly string[] | null | undefined, options: ProjectionOptions<Stored, Record<string, unknown>> = {}) => {
        const resolvedIds = (ids ?? []).map(id => String(id));
        validateProjectionOptions(options, `${config.id}.use.byIds`);
        const optionsRef = useRef(options);
        const gateRef = useRef(createProjectionGate<Stored, Record<string, unknown>>());
        const resultRef = useRef<{ rows: Record<string, unknown>[]; byId: ReadonlyMap<string, Record<string, unknown>> } | null>(null);
        optionsRef.current = options;
        return useLiveRead(
          () => {
            const sources: Stored[] = [];
            for (const id of resolvedIds) {
              const source = planes().entityState.read(id);
              if (source !== undefined) sources.push(source);
            }
            const rows = gateRef.current.projectRows(sources, optionsRef.current);
            if (resultRef.current?.rows === rows) return resultRef.current;
            resultRef.current = {
              rows,
              byId: new Map(sources.map(source => [source.id, gateRef.current.project(source, optionsRef.current)]))
            };
            return resultRef.current;
          },
          resolvedIds.map(id => rowDep(id)),
          Object.is
        );
      }) as ModelCore<Stored, Input>['use']['byIds'],
      count: where =>
        useIncrementalRead({
          signature: incrementalSignature('count', config.id, where),
          deps: [modelDep],
          create: () =>
            createModelReadEngine({
              signature: incrementalSignature('count', config.id, where),
              model: config.id,
              where: row => where == null || matchesCriteria(row, where),
              initial: () => planes().entityState.values(),
              read: id => planes().entityState.read(id),
              select: (_rows, count) => count,
              countOnly: true
            })
        }),
      related: ((id: string | null | undefined, relationName: string, options: ProjectionOptions<StoredRowShape, Record<string, unknown>> = {}): unknown => {
        const relation = resolvedRelations()[relationName];
        if (!relation) throw new Error(`${config.name} has no relation ${relationName}`);
        if (relation.kind === 'hasMany') {
          return useProjectedLiveRows(
            () => (id == null ? EMPTY_ROWS : (relation.model.where({ [relation.foreignKey]: id }) as StoredRowShape[])),
            id == null ? [] : [rowDep(id), { kind: 'model', model: relation.model.modelId }],
            options,
            `${config.id}.use.related`
          );
        }
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
            return parentId ? relation.model.find(parentId) : undefined;
          };
          const parentId = parentIdOf();
          deps = id == null ? [] : [rowDep(id, [relation.foreignKey]), ...(parentId ? [{ kind: 'row' as const, model: relation.model.modelId, id: parentId }] : [])];
        } else if (relation.kind === 'hasOne') {
          const comparator = relation.comparator;
          compute = () => {
            if (id == null) return undefined;
            const rows = relation.model.where({ [relation.foreignKey]: id });
            if (rows.length === 0) return undefined;
            return comparator ? rows.reduce((best, row) => (comparator(row, best) < 0 ? row : best)) : rows[0];
          };
          deps = id == null ? [] : [rowDep(id), { kind: 'model', model: relation.model.modelId }];
        } else {
          compute = () => undefined;
          deps = [];
        }
        return useLiveRead(compute, deps, isEqual);
      }) as ModelCore<Stored, Input>['use']['related']
    },
    scopes: scopeHandles,
    registerReset: fn => {
      registerReset(fn);
    }
  };
  registerInternalModelHandle(model, {
    readRow: id => planes().entityState.read(id),
    applyRows: rows => applySnapshot(planRows(rows)),
    applyPatch: (id, patch, operationId) => getApplyRuntime().commit(createCommitEnvelope([{ kind: 'patch', model: config.id, id: String(id), patch, operationId }])),
    planRows,
    planReplace,
    captureMembership,
    planRestore,
    relations: resolvedRelations,
    revision: context.revision,
    dropTempRowsAfterMs: () => config.maintenance?.dropTempRowsAfterMs
  });
  registerIngestModel(config.name, model);
  if (config.maintenance) {
    const pendingTempRows = (): MaintenanceReport[] => {
      const maxAgeMs = config.maintenance?.dropTempRowsAfterMs;
      if (maxAgeMs === undefined) return [];
      const protectedIds = new Set([
        ...getOperationState().pending().filter(operation => operation.model === config.id).flatMap(operation => operation.tempIds),
        ...modelProtectedTempIds()
      ]);
      const ids: string[] = [];
      resolveStaleTempRows(model, { maxAgeMs, protectedIds, onStale: row => ids.push(row.id) });
      if (ids.length === 0) return [];
      getApplyRuntime().commit(createCommitEnvelope([{ kind: 'destroy', model: config.id, ids, tombstone: false }]));
      for (const id of ids) clearFailedOptimisticMutation(config.id, id);
      noteDataLoss('stale-temp-row-expiry', config.id, ids.length);
      return [{ model: config.id, task: 'dropTempRows', affected: ids.length }];
    };
    const modelProtectedTempIds = (): ReadonlySet<string> => new Set(config.maintenance?.protectTempRows?.() ?? []);
    registerModelMaintenance(config.id, {
      boot: () => {
        const reports: MaintenanceReport[] = [];
        for (const task of config.maintenance?.maxRowsPerScope ?? []) {
          reports.push({ model: config.id, task: 'maxRowsPerScope', affected: trimRowsPerScope(model, task.scopeField, task.limit, task.compare, task.protect?.()) });
        }
        return [...reports, ...pendingTempRows()];
      },
      pendingTempRows,
      protectedTempIds: modelProtectedTempIds
    });
  }

  registerReset(() => {
    context.reset();
    // The apply target stays registered: a model must keep working after the kill-switch.
  });

  for (const [scopeName, spec] of Object.entries(config.queryScopes ?? {})) {
    if (scopeName in model.use) throw new Error(`${config.name} queryScope '${scopeName}' collides with a built-in use key`);
    (model.use as Record<string, unknown>)[scopeName] = (extra?: DbWhere<Stored>) => {
      const criteria = extra ? ({ and: [spec.where, extra] } as DbWhere<Stored>) : spec.where;
      let builder = whereRead(criteria);
      if (spec.orderBy) builder = builder.orderBy(spec.orderBy.field, spec.orderBy.direction);
      if (spec.limit !== undefined) builder = builder.limit(spec.limit);
      return builder;
    };
  }

  const statics = config.statics?.(model);
  if (statics) {
    for (const key of Object.keys(statics)) {
      if (key in model) throw new Error(`${config.name} statics collide with base model key ${key}`);
    }
  }
  return Object.assign(model, statics) as Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, 'use' | 'scopes'> & {
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
    scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>> };
  } & TExt;
};

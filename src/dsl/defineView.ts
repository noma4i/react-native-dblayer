import { useEffect, useRef, useState } from 'react';
import type {
  Dependency,
  EvaluatedView,
  InternalIdInclude,
  InternalViewConfig,
  ModelCore,
  RelationDecl,
  RowRecord,
  ScopeHandle,
  ViewCacheEntry,
  ViewConfig,
  ViewForeignKeyIndex,
  ViewHandle,
  ViewIncluded,
  ViewIncludeModel,
  ViewItemSnapshot,
  ViewWindowCache
} from '../types';
import { noteFkIndex } from '../core/diagnostics';
import { registerReset } from '../core/reset';
import { compositeKey } from '../core/serialize';
import { arraysShallowEqual, rowsShallowEqual, useLiveRead } from '../read/useLiveRead';
import { createProjectionGate, validateProjectionOptions } from '../read/projectionGate';
import { useScopeRetention } from '../read/scopeRetention';
import { hasRequiredFields } from '../read/requireFields';
import { getCommitBus, getDbRuntimeConfig } from './configure';
import { getInternalModelHandle, getInternalScopeHandle } from '../core/internalHandles';


const foreignKeyIndexes = new Map<string, ViewForeignKeyIndex>();

const foreignKeyIndexKey = (targetModelId: string, foreignKey: string): string => compositeKey(targetModelId, foreignKey);

const removeIndexedRow = (index: ViewForeignKeyIndex, foreignKey: string, id: string): void => {
  const bucket = index.rowsByForeignKey.get(foreignKey);
  if (!bucket) return;
  const position = bucket.findIndex(row => row.id === id);
  if (position >= 0) bucket.splice(position, 1);
  if (bucket.length === 0) index.rowsByForeignKey.delete(foreignKey);
};

const foreignKeyIndexFor = (target: ViewIncludeModel, foreignKey: string): ViewForeignKeyIndex => {
  const key = foreignKeyIndexKey(target.modelId, foreignKey);
  const existing = foreignKeyIndexes.get(key);
  if (existing) return existing;
  const rowsByForeignKey = new Map<string, RowRecord[]>();
  const fkById = new Map<string, string>();
  for (const row of target.all() as RowRecord[]) {
    const value = row[foreignKey];
    if (typeof value !== 'string') continue;
    const bucket = rowsByForeignKey.get(value) ?? [];
    bucket.push(row);
    rowsByForeignKey.set(value, bucket);
    fkById.set(row.id, value);
  }
  const index: ViewForeignKeyIndex = { rowsByForeignKey, fkById, unsubscribe: () => undefined };
  index.unsubscribe = getCommitBus().subscribeAll(batch => {
    let updates = 0;
    for (const change of batch.rows) {
      if (change.model !== target.modelId) continue;
      const previousForeignKey = index.fkById.get(change.id);
      const next = target.find(change.id) as RowRecord | null | undefined;
      const nextForeignKey = typeof next?.[foreignKey] === 'string' ? (next[foreignKey] as string) : undefined;
      if (previousForeignKey && previousForeignKey !== nextForeignKey) removeIndexedRow(index, previousForeignKey, change.id);
      if (!nextForeignKey || !next) {
        index.fkById.delete(change.id);
        updates += 1;
        continue;
      }
      const bucket = index.rowsByForeignKey.get(nextForeignKey) ?? [];
      const position = bucket.findIndex(row => row.id === change.id);
      if (position >= 0) bucket[position] = next;
      else bucket.push(next);
      index.rowsByForeignKey.set(nextForeignKey, bucket);
      index.fkById.set(change.id, nextForeignKey);
      updates += 1;
    }
    if (updates > 0) noteFkIndex('incremental', updates);
  });
  foreignKeyIndexes.set(key, index);
  noteFkIndex('full', rowsByForeignKey.size);
  return index;
};

registerReset(() => {
  for (const index of foreignKeyIndexes.values()) index.unsubscribe();
  foreignKeyIndexes.clear();
});

const idsOf = (value: string | string[] | null): string[] =>
  (Array.isArray(value) ? value : value == null ? [] : [value]).filter((id): id is string => typeof id === 'string' && id.length > 0);

const resolveRelation = (row: RowRecord, relation: RelationDecl, rowsFor: (foreignKey: string, id: string) => RowRecord[]): unknown => {
  if (relation.kind === 'belongsTo') {
    const id = row[relation.foreignKey];
    return typeof id === 'string' ? (relation.model.find(id) ?? null) : null;
  }
  if (relation.kind === 'references') throw new Error(`Model.view does not support ${relation.kind} includes`);
  const rows = rowsFor(relation.foreignKey, row.id);
  if (relation.kind === 'hasMany') return rows;
  if (relation.kind === 'hasOne') {
    if (rows.length === 0) return null;
    return relation.comparator ? rows.reduce((best, candidate) => (relation.comparator!(candidate, best) < 0 ? candidate : best)) : rows[0];
  }
  return null;
};

/** Normalize the public generic contract once; runtime view evaluation intentionally remains row-shape agnostic. */
const normalizeViewConfig = <TRow extends { id: string }, TIncluded extends Record<string, unknown>, TItem>(
  config: ViewConfig<TRow, TIncluded, TItem>
): InternalViewConfig<TItem> => config as unknown as InternalViewConfig<TItem>;

/**
 * Compose a model scope with declared relations or computed target ids into one pinpoint-reactive view.
 *
 * @param model Source model that owns the named scope and declared relation includes.
 * @param name Stable view name used in validation errors.
 * @param config Source scope, include declarations, projection, and optional render identity keys.
 * @returns A hook handle with full-scope and local-window reads.
 */
export const defineView = <TRow extends RowRecord, TIncluded extends Record<string, unknown>, TItem, TScope>(
  model: ModelCore<TRow>,
  name: string,
  publicConfig: ViewConfig<TRow, TIncluded, TItem>
): ViewHandle<TItem, TScope> => {
  const config = normalizeViewConfig(publicConfig);
  const source = (typeof config.source === 'string' ? model.scopes[config.source] : config.source) as ScopeHandle<RowRecord, TScope> | undefined;
  if (!source || source.modelId !== model.modelId) throw new Error(`${model.modelId} has no scope ${typeof config.source === 'string' ? config.source : name} for view ${name}`);
  validateProjectionOptions(config, `${model.modelId}.view.${name}`, { allowCombined: true });
  const relations = getInternalModelHandle(model).relations();
  const sourceInternal = getInternalScopeHandle(source);
  for (const [alias, include] of Object.entries(config.include)) {
    const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
    if (relationName && !relations[relationName]) throw new Error(`${model.modelId} has no relation ${relationName} for view ${name}.${alias}`);
    if (relationName && relations[relationName]!.kind === 'references') throw new Error(`Model.view does not support references includes`);
  }

  const useItems = (scopeValue: TScope | null | undefined, limit: number | null): ViewItemSnapshot<TItem> => {
    const cacheRef = useRef(new Map<string, ViewCacheEntry<TItem>>());
    const projectionGateRef = useRef(createProjectionGate<RowRecord, RowRecord>());
    const includeProjectionGatesRef = useRef(new Map<string, ReturnType<typeof createProjectionGate<RowRecord, RowRecord>>>());
    const evaluatedRef = useRef<EvaluatedView<TItem> | null>(null);
    const projectIncludedRow = (alias: string, row: RowRecord, renderKeys: readonly string[] | undefined): RowRecord => {
      if (!renderKeys) return row;
      let gate = includeProjectionGatesRef.current.get(alias);
      if (!gate) {
        gate = createProjectionGate<RowRecord, RowRecord>();
        includeProjectionGatesRef.current.set(alias, gate);
      }
      return gate.projectValue(row.id, row, row, renderKeys);
    };
    const rowsFor = (relation: RelationDecl, foreignKey: string, id: string): RowRecord[] => {
      const index = foreignKeyIndexFor(relation.model as unknown as ViewIncludeModel, foreignKey);
      // Callers transform results immediately and must not retain these mutable bucket arrays.
      return index.rowsByForeignKey.get(id) ?? [];
    };
    const scopeKey = scopeValue == null ? null : sourceInternal.key(scopeValue);
    useEffect(() => {
      if (scopeKey != null) sourceInternal.noteAccess(scopeValue as TScope);
    }, [scopeKey, scopeValue]);
    const evaluate = (): { items: TItem[]; totalCount: number; resolved: boolean; deps: Dependency[] } => {
      const rows = scopeValue == null ? [] : sourceInternal.readRows(scopeValue);
      const visibleRows = limit === null ? rows : rows.slice(0, limit);
      const relationModelIds = new Set<string>();
      for (const [alias, include] of Object.entries(config.include)) {
        const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
        if (!relationName) continue;
        const relation = relations[relationName]!;
        if (relation.kind === 'hasMany' || relation.kind === 'hasOne') relationModelIds.add(relation.model.modelId);
      }
      const deps: Dependency[] = [
        ...[...relationModelIds].map(model => ({ kind: 'model' as const, model })),
        ...(scopeValue == null ? [] : [{ kind: 'scope' as const, model: source.modelId, scopeKey: sourceInternal.key(scopeValue) }])
      ];
      const liveIds = new Set(rows.map(row => row.id));
      const items = visibleRows.map((row, index) => {
        deps.push({ kind: 'row', model: model.modelId, id: row.id });
        const included: ViewIncluded = {};
        for (const [alias, include] of Object.entries(config.include)) {
          const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
          const includeRenderKeys = typeof include === 'object' && !Array.isArray(include) ? include.renderKeys : undefined;
          if (relationName) {
            const relation = relations[relationName]!;
            const required = typeof include === 'object' && !Array.isArray(include) ? include.require : undefined;
            const resolved = resolveRelation(row, relation, (foreignKey, id) => rowsFor(relation, foreignKey, id));
            included[alias] = Array.isArray(resolved)
              ? resolved.filter(candidate => hasRequiredFields(candidate as RowRecord | null, required ?? [])).map(candidate => projectIncludedRow(alias, candidate as RowRecord, includeRenderKeys))
              : hasRequiredFields(resolved as RowRecord | null, required ?? [])
                ? projectIncludedRow(alias, resolved as RowRecord, includeRenderKeys)
                : null;
            if (relation.kind === 'belongsTo') {
              const id = row[relation.foreignKey];
              if (typeof id === 'string') deps.push({ kind: 'row', model: relation.model.modelId, id });
            } else {
              const relatedRows = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
              for (const relatedRow of relatedRows) deps.push({ kind: 'row', model: relation.model.modelId, id: (relatedRow as RowRecord).id });
            }
          } else {
            const idInclude = include as InternalIdInclude;
            const [target, resolveIds, required] = Array.isArray(include)
              ? ([include[0], include[1], undefined] as const)
              : ([idInclude.model, idInclude.ids, idInclude.require] as const);
            const rawIds = resolveIds(row);
            const ids = idsOf(rawIds);
            const resolved = ids
              .map(id => target.find(id))
              .filter(candidate => hasRequiredFields(candidate, required ?? []))
              .map(candidate => projectIncludedRow(alias, candidate as RowRecord, includeRenderKeys));
            included[alias] = Array.isArray(rawIds) ? resolved : (resolved[0] ?? null);
            for (const id of ids) deps.push({ kind: 'row', model: target.modelId, id });
          }
        }
        const current = cacheRef.current.get(row.id);
        if (current && current.row === row && rowsShallowEqual(current.included, included)) return current.item;
        const candidate = (config.select ? config.select(row, included, { index }) : { ...row, ...included }) as RowRecord;
        const item = projectionGateRef.current.projectValue(row.id, candidate, candidate, config.renderKeys) as TItem;
        cacheRef.current.set(row.id, { row, included, item });
        return item;
      });
      for (const id of cacheRef.current.keys()) if (!liveIds.has(id)) cacheRef.current.delete(id);
      return { items, totalCount: rows.length, resolved: scopeValue == null || sourceInternal.isResolved(scopeValue), deps };
    };
    if (evaluatedRef.current === null || evaluatedRef.current.scopeKey !== scopeKey || evaluatedRef.current.limit !== limit) {
      const result = evaluate();
      evaluatedRef.current = {
        scopeKey,
        limit,
        snapshot: { items: result.items, totalCount: result.totalCount, resolved: result.resolved },
        deps: result.deps
      };
    }
    return useLiveRead(
      () => {
        const result = evaluate();
        const snapshot = { items: result.items, totalCount: result.totalCount, resolved: result.resolved };
        evaluatedRef.current = { scopeKey, limit, snapshot, deps: result.deps };
        return snapshot;
      },
      evaluatedRef.current.deps,
      (left, right) => left.resolved === right.resolved && left.totalCount === right.totalCount && arraysShallowEqual(left.items, right.items)
    );
  };

  return {
    use: (scopeValue, options) => {
      const snapshot = useItems(scopeValue, null);
      const scopeKey = scopeValue == null ? null : sourceInternal.key(scopeValue);
      return useScopeRetention(scopeKey, { rows: snapshot.items, totalCount: snapshot.totalCount }, snapshot.resolved, options?.keepPrevious === true).snapshot.rows;
    },
    useWindow: (scopeValue, options) => {
      const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
      const scopeKey = scopeValue == null ? null : sourceInternal.key(scopeValue);
      const [state, setState] = useState({ scopeKey, size: pageSize });
      const size = state.scopeKey === scopeKey ? state.size : pageSize;
      if (state.scopeKey !== scopeKey) setState({ scopeKey, size: pageSize });
      const windowRef = useRef<ViewWindowCache<TItem> | null>(null);
      const snapshot = useItems(scopeValue, size);
      const items = snapshot.items;
      const cached = windowRef.current;
      const rows = cached && cached.items === items && cached.size === size ? cached.rows : items.slice(0, size);
      windowRef.current = { items, size, rows };
      const retained = useScopeRetention(scopeKey, { rows, totalCount: snapshot.totalCount }, snapshot.resolved, options?.keepPrevious === true);
      return {
        rows: retained.snapshot.rows,
        totalCount: retained.snapshot.totalCount,
        hasMore: retained.snapshot.totalCount > size,
        isPreviousData: retained.isPreviousData,
        fetchNextPage: () => setState(current => (current.scopeKey === scopeKey ? { ...current, size: current.size + pageSize } : { scopeKey, size: pageSize + pageSize }))
      };
    }
  };
};

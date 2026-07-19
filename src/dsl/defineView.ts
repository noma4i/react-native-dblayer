import { useEffect, useRef, useState } from 'react';
import type { Dependency } from '../core/apply/commitBus';
import type { RelationDecl } from '../core/relations';
import { arraysShallowEqual, useLiveRead } from '../read/useLiveRead';
import { createProjectionGate, validateProjectionOptions } from '../read/projectionGate';
import { useScopeRetention, type KeepPreviousOption } from '../read/scopeRetention';
import { hasRequiredFields } from '../read/requireFields';
import { getDbRuntimeConfig } from './configure';
import type { ModelCore, ScopeHandle } from './defineModel';
import { getInternalModelHandle, getInternalScopeHandle } from '../core/internalHandles';

type Row = { id: string; [key: string]: unknown };
type Included = Record<string, unknown>;
type ComputedInclude = [ModelCore<Row>, (row: Row) => string | string[] | null];
type RelationInclude = { require: readonly string[] };
type IdInclude = { model: ModelCore<Row>; ids: (row: Row) => string | string[] | null; require?: readonly string[] };
type IncludeConfig = string | ComputedInclude | RelationInclude | IdInclude;

export type ViewConfig<TItem> = {
  /** Declared scope name or scope handle on the model that owns the view. */
  source: string | ScopeHandle<Row, Record<string, unknown>>;
  /** Declared relation names or explicit target-model id resolvers keyed by the projection alias. An include may require stored fields: `undefined` is missing and `null` is present; incomplete related rows are delivered as absent. */
  include: Record<string, IncludeConfig>;
  /** Build one view item from a source row, resolved includes, and its source index. With `renderKeys`, identity is gated by those keys on this selected output. */
  select?: (row: Row, included: Included, ctx: { index: number }) => TItem;
  /** Preserve an item reference while all listed keys of the selected output, or the whole row when `select` is absent, are unchanged. */
  renderKeys?: string[];
};

export type ViewHandle<TItem, TScope> = {
  /** Reactively read every projected item; `keepPrevious` is opt-in for unresolved key handoffs. */
  use(scopeValue: TScope | null | undefined, opts?: KeepPreviousOption): TItem[];
  /** Reactively read a local window over the projected source scope. */
  useWindow(scopeValue: TScope | null | undefined, opts?: { pageSize?: number } & KeepPreviousOption): ViewWindowResult<TItem>;
};

type ViewWindowResult<TItem> = {
  /** Current-key items, or retained previous-key items while `isPreviousData` is true. */
  rows: TItem[];
  /** Total count for the snapshot represented by `rows`. */
  totalCount: number;
  /** Whether more locally-synced items exist beyond the current window. */
  hasMore: boolean;
  /** Grow the local view window by one page without fetching from the network. */
  fetchNextPage: () => void;
  /** True only while rows belong to the previous scope key and the current key is unresolved. */
  isPreviousData: boolean;
};

type CacheEntry<TItem> = { row: Row; included: Included; item: TItem };
type RelationIndex = { revision: number; rowsByForeignKey: Map<string, Row[]> };
type WindowCache<TItem> = { items: TItem[]; size: number; rows: TItem[] };
type ItemSnapshot<TItem> = { items: TItem[]; totalCount: number; resolved: boolean };

const includesEqual = (left: Included, right: Included): boolean => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key =>
      Array.isArray(left[key]) && Array.isArray(right[key]) ? arraysShallowEqual(left[key] as unknown[], right[key] as unknown[]) : Object.is(left[key], right[key])
    )
  );
};

const idsOf = (value: string | string[] | null): string[] =>
  (Array.isArray(value) ? value : value == null ? [] : [value]).filter((id): id is string => typeof id === 'string' && id.length > 0);

const resolveRelation = (row: Row, relation: RelationDecl, rowsFor: (foreignKey: string, id: string) => Row[]): unknown => {
  if (relation.kind === 'belongsTo') {
    const id = row[relation.foreignKey];
    return typeof id === 'string' ? (relation.model.get(id) ?? null) : null;
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

/**
 * Compose a model scope with declared relations or computed target ids into one pinpoint-reactive view.
 *
 * @param model Source model that owns the named scope and declared relation includes.
 * @param name Stable view name used in validation errors.
 * @param config Source scope, include declarations, projection, and optional render identity keys.
 * @returns A hook handle with full-scope and local-window reads.
 */
export const defineView = <TItem, TScope>(model: ModelCore<Row>, name: string, config: ViewConfig<TItem>): ViewHandle<TItem, TScope> => {
  const source = (typeof config.source === 'string' ? model.scopes[config.source] : config.source) as ScopeHandle<Row, TScope> | undefined;
  if (!source || source.modelId !== model.modelId) throw new Error(`${model.modelId} has no scope ${typeof config.source === 'string' ? config.source : name} for view ${name}`);
  validateProjectionOptions(config, `${model.modelId}.view.${name}`, { allowCombined: true });
  const relations = getInternalModelHandle(model).relations();
  const sourceInternal = getInternalScopeHandle(source);
  for (const [alias, include] of Object.entries(config.include)) {
    const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
    if (relationName && !relations[relationName]) throw new Error(`${model.modelId} has no relation ${relationName} for view ${name}.${alias}`);
    if (relationName && relations[relationName]!.kind === 'references') throw new Error(`Model.view does not support references includes`);
  }

  const useItems = (scopeValue: TScope | null | undefined, limit: number | null): ItemSnapshot<TItem> => {
    const cacheRef = useRef(new Map<string, CacheEntry<TItem>>());
    const projectionGateRef = useRef(createProjectionGate<Row, Row>());
    const relationIndexesRef = useRef(new Map<RelationDecl, RelationIndex>());
    const rowsFor = (relation: RelationDecl, foreignKey: string, id: string): Row[] => {
      const target = relation.model as ModelCore<Row>;
      const revision = getInternalModelHandle(target).revision();
      let index = relationIndexesRef.current.get(relation);
      if (!index || index.revision !== revision) {
        const rowsByForeignKey = new Map<string, Row[]>();
        for (const row of target.getAll()) {
          const value = row[foreignKey];
          if (typeof value !== 'string') continue;
          const rows = rowsByForeignKey.get(value) ?? [];
          rows.push(row);
          rowsByForeignKey.set(value, rows);
        }
        index = { revision, rowsByForeignKey };
        relationIndexesRef.current.set(relation, index);
      }
      return index.rowsByForeignKey.get(id) ?? [];
    };
    const scopeKey = scopeValue == null ? null : sourceInternal.key(scopeValue);
    useEffect(() => {
      if (scopeKey != null) sourceInternal.noteAccess(scopeValue as TScope);
    }, [scopeKey]);
    const evaluate = (): { items: TItem[]; totalCount: number; resolved: boolean; deps: Dependency[] } => {
      const rows = scopeValue == null ? [] : sourceInternal.readRows(scopeValue);
      const visibleRows = limit === null ? rows : rows.slice(0, limit);
      const deps: Dependency[] = scopeValue == null ? [] : [{ kind: 'scope', model: source.modelId, scopeKey: sourceInternal.key(scopeValue) }];
      const liveIds = new Set(rows.map(row => row.id));
      const items = visibleRows.map((row, index) => {
        deps.push({ kind: 'row', model: model.modelId, id: row.id });
        const included: Included = {};
        for (const [alias, include] of Object.entries(config.include)) {
          const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
          if (relationName) {
            const relation = relations[relationName]!;
            const required = typeof include === 'object' && !Array.isArray(include) ? include.require : undefined;
            const resolved = resolveRelation(row, relation, (foreignKey, id) => rowsFor(relation, foreignKey, id));
            included[alias] = Array.isArray(resolved)
              ? resolved.filter(candidate => hasRequiredFields(candidate as Row | null, required ?? []))
              : hasRequiredFields(resolved as Row | null, required ?? [])
                ? resolved
                : null;
            if (relation.kind === 'belongsTo') {
              const id = row[relation.foreignKey];
              if (typeof id === 'string') deps.push({ kind: 'row', model: relation.model.modelId, id });
            } else {
              const relatedRows = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
              for (const relatedRow of relatedRows) deps.push({ kind: 'row', model: relation.model.modelId, id: (relatedRow as Row).id });
            }
          } else {
            const idInclude = include as IdInclude;
            const [target, resolveIds, required] = Array.isArray(include)
              ? ([include[0], include[1], undefined] as const)
              : ([idInclude.model, idInclude.ids, idInclude.require] as const);
            const rawIds = resolveIds(row);
            const ids = idsOf(rawIds);
            const resolved = ids.map(id => target.get(id)).filter(candidate => hasRequiredFields(candidate, required ?? []));
            included[alias] = Array.isArray(rawIds) ? resolved : (resolved[0] ?? null);
            for (const id of ids) deps.push({ kind: 'row', model: target.modelId, id });
          }
        }
        const current = cacheRef.current.get(row.id);
        if (current && current.row === row && includesEqual(current.included, included)) return current.item;
        const candidate = (config.select ? config.select(row, included, { index }) : { ...row, ...included }) as Row;
        const item = projectionGateRef.current.projectValue(row.id, candidate, candidate, config.renderKeys) as TItem;
        cacheRef.current.set(row.id, { row, included, item });
        return item;
      });
      for (const id of cacheRef.current.keys()) if (!liveIds.has(id)) cacheRef.current.delete(id);
      return { items, totalCount: rows.length, resolved: scopeValue == null || sourceInternal.isResolved(scopeValue), deps };
    };
    const initial = evaluate();
    return useLiveRead(
      () => {
        const next = evaluate();
        return { items: next.items, totalCount: next.totalCount, resolved: next.resolved };
      },
      initial.deps,
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
      const windowRef = useRef<WindowCache<TItem> | null>(null);
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

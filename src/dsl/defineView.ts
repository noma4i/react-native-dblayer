import { useEffect, useRef, useState } from 'react';
import type { Dependency } from '../core/apply/commitBus';
import type { RelationDecl } from '../core/relations';
import { arraysShallowEqual, useLiveRead } from '../read/useLiveRead';
import { hasRequiredFields } from '../read/requireFields';
import { isRecord } from '../utils/normalizeHelpers';
import { getDbRuntimeConfig } from './configure';
import type { ModelCore, ScopeHandle } from './defineModel';

type Row = { id: string; [key: string]: unknown };
type Included = Record<string, unknown>;
type ComputedInclude = [ModelCore<Row>, (row: Row) => string | string[] | null];
type RelationInclude = { require: readonly string[] };
type IdInclude = { model: ModelCore<Row>; ids: (row: Row) => string | string[] | null; require?: readonly string[] };
type IncludeConfig = string | ComputedInclude | RelationInclude | IdInclude;

export type ViewConfig<TItem> = {
  /** Declared scope name or scope handle on the model that owns the view. */
  source: string | ScopeHandle<Row, Record<string, unknown>>;
  /** Declared relation names or explicit target-model id resolvers keyed by the projection alias. An include may require stored fields: `undefined` is missing and `null` is present; incomplete related rows are delivered as absent. `hasMany` and `hasOne` use a model-wide discovery dependency so newly matching rows are found; unrelated target writes recompute but preserve item identities and do not re-render readers. */
  include: Record<string, IncludeConfig>;
  /** Build one view item from a source row, resolved includes, and its source index. */
  select?: (row: Row, included: Included, ctx: { index: number }) => TItem;
  /** Preserve an item reference while all listed projected keys are unchanged. */
  renderKeys?: string[];
};

export type ViewHandle<TItem, TScope> = {
  /** Reactively read every projected item in the source scope. */
  use(scopeValue: TScope | null | undefined): TItem[];
  /** Reactively read a local window over the projected source scope. */
  useWindow(scopeValue: TScope | null | undefined, opts?: { pageSize?: number }): { rows: TItem[]; totalCount: number; hasMore: boolean; fetchNextPage: () => void };
};

type CacheEntry<TItem> = { row: Row; included: Included; item: TItem };
type RelationIndex = { revision: number; rowsByForeignKey: Map<string, Row[]> };
type WindowCache<TItem> = { items: TItem[]; size: number; rows: TItem[] };
type ItemSnapshot<TItem> = { items: TItem[]; totalCount: number };

const valuesEqual = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]));
  }
  return Object.is(left, right);
};

const includesEqual = (left: Included, right: Included): boolean => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => valuesEqual(left[key], right[key]));
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
  const relations = model.__relations!();
  const relationIndexes = new Map<RelationDecl, RelationIndex>();
  for (const [alias, include] of Object.entries(config.include)) {
    const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
    if (relationName && !relations[relationName]) throw new Error(`${model.modelId} has no relation ${relationName} for view ${name}.${alias}`);
    if (relationName && relations[relationName]!.kind === 'references') throw new Error(`Model.view does not support references includes`);
  }

  const rowsFor = (relation: RelationDecl, foreignKey: string, id: string): Row[] => {
    const target = relation.model as ModelCore<Row>;
    const revision = target.__revision?.() ?? 0;
    let index = relationIndexes.get(relation);
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
      relationIndexes.set(relation, index);
    }
    return index.rowsByForeignKey.get(id) ?? [];
  };

  const useItems = (scopeValue: TScope | null | undefined, limit: number | null): ItemSnapshot<TItem> => {
    const cacheRef = useRef(new Map<string, CacheEntry<TItem>>());
    const scopeKey = scopeValue == null ? null : source.__key!(scopeValue);
    useEffect(() => {
      if (scopeKey != null) source.__noteAccess!(scopeValue as TScope);
    }, [scopeKey]);
    const evaluate = (): { items: TItem[]; totalCount: number; deps: Dependency[] } => {
      const rows = scopeValue == null ? [] : source.__readRows!(scopeValue);
      const visibleRows = limit === null ? rows : rows.slice(0, limit);
      const deps: Dependency[] = scopeValue == null ? [] : [{ kind: 'scope', model: source.modelId, scopeKey: source.__key!(scopeValue) }];
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
              deps.push({ kind: 'model', model: relation.model.modelId });
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
        const item = config.select ? config.select(row, included, { index }) : ({ ...row, ...included } as TItem);
        if (current && config.renderKeys?.every(key => valuesEqual((current.item as Record<string, unknown>)[key], (item as Record<string, unknown>)[key]))) {
          cacheRef.current.set(row.id, { row, included, item: current.item });
          return current.item;
        }
        cacheRef.current.set(row.id, { row, included, item });
        return item;
      });
      for (const id of cacheRef.current.keys()) if (!liveIds.has(id)) cacheRef.current.delete(id);
      return { items, totalCount: rows.length, deps };
    };
    const initial = evaluate();
    return useLiveRead(
      () => {
        const next = evaluate();
        return { items: next.items, totalCount: next.totalCount };
      },
      initial.deps,
      (left, right) => left.totalCount === right.totalCount && arraysShallowEqual(left.items, right.items)
    );
  };

  return {
    use: scopeValue => useItems(scopeValue, null).items,
    useWindow: (scopeValue, options) => {
      const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
      const scopeKey = scopeValue == null ? null : source.__key!(scopeValue);
      const [state, setState] = useState({ scopeKey, size: pageSize });
      const size = state.scopeKey === scopeKey ? state.size : pageSize;
      if (state.scopeKey !== scopeKey) setState({ scopeKey, size: pageSize });
      const windowRef = useRef<WindowCache<TItem> | null>(null);
      const snapshot = useItems(scopeValue, size);
      const items = snapshot.items;
      const cached = windowRef.current;
      const rows = cached && cached.items === items && cached.size === size ? cached.rows : items.slice(0, size);
      windowRef.current = { items, size, rows };
      return {
        rows,
        totalCount: snapshot.totalCount,
        hasMore: snapshot.totalCount > size,
        fetchNextPage: () => setState(current => (current.scopeKey === scopeKey ? { ...current, size: current.size + pageSize } : { scopeKey, size: pageSize + pageSize }))
      };
    }
  };
};

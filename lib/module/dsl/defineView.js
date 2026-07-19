"use strict";

import { useEffect, useRef, useState } from 'react';
import { arraysShallowEqual, useLiveRead } from "../read/useLiveRead.js";
import { createProjectionGate, validateProjectionOptions } from "../read/projectionGate.js";
import { useScopeRetention } from "../read/scopeRetention.js";
import { hasRequiredFields } from "../read/requireFields.js";
import { getDbRuntimeConfig } from "./configure.js";
import { getInternalModelHandle, getInternalScopeHandle } from "../core/internalHandles.js";

/** Minimal snapshot reader accepted by computed view includes. Method syntax keeps concrete model readers assignable under strict function variance. */

/** One declared-relation or computed-id include specification for a typed view source row. */

/**
 * Typed configuration for a model-owned joined projection.
 *
 * Declare both output and include shapes when includes are consumed, for example
 * `ChatModel.view<ChatListItem, { lastMessage: StoredMessage | null; users: UserData[] }>(...)`.
 * TypeScript cannot partially infer the second type argument after an explicit output type.
 */

const includesEqual = (left, right) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Array.isArray(left[key]) && Array.isArray(right[key]) ? arraysShallowEqual(left[key], right[key]) : Object.is(left[key], right[key]));
};
const idsOf = value => (Array.isArray(value) ? value : value == null ? [] : [value]).filter(id => typeof id === 'string' && id.length > 0);
const resolveRelation = (row, relation, rowsFor) => {
  if (relation.kind === 'belongsTo') {
    const id = row[relation.foreignKey];
    return typeof id === 'string' ? relation.model.get(id) ?? null : null;
  }
  if (relation.kind === 'references') throw new Error(`Model.view does not support ${relation.kind} includes`);
  const rows = rowsFor(relation.foreignKey, row.id);
  if (relation.kind === 'hasMany') return rows;
  if (relation.kind === 'hasOne') {
    if (rows.length === 0) return null;
    return relation.comparator ? rows.reduce((best, candidate) => relation.comparator(candidate, best) < 0 ? candidate : best) : rows[0];
  }
  return null;
};

/** Normalize the public generic contract once; runtime view evaluation intentionally remains row-shape agnostic. */
const normalizeViewConfig = config => config;

/**
 * Compose a model scope with declared relations or computed target ids into one pinpoint-reactive view.
 *
 * @param model Source model that owns the named scope and declared relation includes.
 * @param name Stable view name used in validation errors.
 * @param config Source scope, include declarations, projection, and optional render identity keys.
 * @returns A hook handle with full-scope and local-window reads.
 */
export const defineView = (model, name, publicConfig) => {
  const config = normalizeViewConfig(publicConfig);
  const source = typeof config.source === 'string' ? model.scopes[config.source] : config.source;
  if (!source || source.modelId !== model.modelId) throw new Error(`${model.modelId} has no scope ${typeof config.source === 'string' ? config.source : name} for view ${name}`);
  validateProjectionOptions(config, `${model.modelId}.view.${name}`, {
    allowCombined: true
  });
  const relations = getInternalModelHandle(model).relations();
  const sourceInternal = getInternalScopeHandle(source);
  for (const [alias, include] of Object.entries(config.include)) {
    const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
    if (relationName && !relations[relationName]) throw new Error(`${model.modelId} has no relation ${relationName} for view ${name}.${alias}`);
    if (relationName && relations[relationName].kind === 'references') throw new Error(`Model.view does not support references includes`);
  }
  const useItems = (scopeValue, limit) => {
    const cacheRef = useRef(new Map());
    const projectionGateRef = useRef(createProjectionGate());
    const relationIndexesRef = useRef(new Map());
    const rowsFor = (relation, foreignKey, id) => {
      const target = relation.model;
      const revision = getInternalModelHandle(target).revision();
      let index = relationIndexesRef.current.get(relation);
      if (!index || index.revision !== revision) {
        const rowsByForeignKey = new Map();
        for (const row of target.getAll()) {
          const value = row[foreignKey];
          if (typeof value !== 'string') continue;
          const rows = rowsByForeignKey.get(value) ?? [];
          rows.push(row);
          rowsByForeignKey.set(value, rows);
        }
        index = {
          revision,
          rowsByForeignKey
        };
        relationIndexesRef.current.set(relation, index);
      }
      return index.rowsByForeignKey.get(id) ?? [];
    };
    const scopeKey = scopeValue == null ? null : sourceInternal.key(scopeValue);
    useEffect(() => {
      if (scopeKey != null) sourceInternal.noteAccess(scopeValue);
    }, [scopeKey]);
    const evaluate = () => {
      const rows = scopeValue == null ? [] : sourceInternal.readRows(scopeValue);
      const visibleRows = limit === null ? rows : rows.slice(0, limit);
      const deps = scopeValue == null ? [] : [{
        kind: 'scope',
        model: source.modelId,
        scopeKey: sourceInternal.key(scopeValue)
      }];
      const liveIds = new Set(rows.map(row => row.id));
      const items = visibleRows.map((row, index) => {
        deps.push({
          kind: 'row',
          model: model.modelId,
          id: row.id
        });
        const included = {};
        for (const [alias, include] of Object.entries(config.include)) {
          const relationName = typeof include === 'string' ? include : Array.isArray(include) ? null : 'model' in include ? null : alias;
          if (relationName) {
            const relation = relations[relationName];
            const required = typeof include === 'object' && !Array.isArray(include) ? include.require : undefined;
            const resolved = resolveRelation(row, relation, (foreignKey, id) => rowsFor(relation, foreignKey, id));
            included[alias] = Array.isArray(resolved) ? resolved.filter(candidate => hasRequiredFields(candidate, required ?? [])) : hasRequiredFields(resolved, required ?? []) ? resolved : null;
            if (relation.kind === 'belongsTo') {
              const id = row[relation.foreignKey];
              if (typeof id === 'string') deps.push({
                kind: 'row',
                model: relation.model.modelId,
                id
              });
            } else {
              const relatedRows = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
              for (const relatedRow of relatedRows) deps.push({
                kind: 'row',
                model: relation.model.modelId,
                id: relatedRow.id
              });
            }
          } else {
            const idInclude = include;
            const [target, resolveIds, required] = Array.isArray(include) ? [include[0], include[1], undefined] : [idInclude.model, idInclude.ids, idInclude.require];
            const rawIds = resolveIds(row);
            const ids = idsOf(rawIds);
            const resolved = ids.map(id => target.get(id)).filter(candidate => hasRequiredFields(candidate, required ?? []));
            included[alias] = Array.isArray(rawIds) ? resolved : resolved[0] ?? null;
            for (const id of ids) deps.push({
              kind: 'row',
              model: target.modelId,
              id
            });
          }
        }
        const current = cacheRef.current.get(row.id);
        if (current && current.row === row && includesEqual(current.included, included)) return current.item;
        const candidate = config.select ? config.select(row, included, {
          index
        }) : {
          ...row,
          ...included
        };
        const item = projectionGateRef.current.projectValue(row.id, candidate, candidate, config.renderKeys);
        cacheRef.current.set(row.id, {
          row,
          included,
          item
        });
        return item;
      });
      for (const id of cacheRef.current.keys()) if (!liveIds.has(id)) cacheRef.current.delete(id);
      return {
        items,
        totalCount: rows.length,
        resolved: scopeValue == null || sourceInternal.isResolved(scopeValue),
        deps
      };
    };
    const initial = evaluate();
    return useLiveRead(() => {
      const next = evaluate();
      return {
        items: next.items,
        totalCount: next.totalCount,
        resolved: next.resolved
      };
    }, initial.deps, (left, right) => left.resolved === right.resolved && left.totalCount === right.totalCount && arraysShallowEqual(left.items, right.items));
  };
  return {
    use: (scopeValue, options) => {
      const snapshot = useItems(scopeValue, null);
      const scopeKey = scopeValue == null ? null : sourceInternal.key(scopeValue);
      return useScopeRetention(scopeKey, {
        rows: snapshot.items,
        totalCount: snapshot.totalCount
      }, snapshot.resolved, options?.keepPrevious === true).snapshot.rows;
    },
    useWindow: (scopeValue, options) => {
      const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
      const scopeKey = scopeValue == null ? null : sourceInternal.key(scopeValue);
      const [state, setState] = useState({
        scopeKey,
        size: pageSize
      });
      const size = state.scopeKey === scopeKey ? state.size : pageSize;
      if (state.scopeKey !== scopeKey) setState({
        scopeKey,
        size: pageSize
      });
      const windowRef = useRef(null);
      const snapshot = useItems(scopeValue, size);
      const items = snapshot.items;
      const cached = windowRef.current;
      const rows = cached && cached.items === items && cached.size === size ? cached.rows : items.slice(0, size);
      windowRef.current = {
        items,
        size,
        rows
      };
      const retained = useScopeRetention(scopeKey, {
        rows,
        totalCount: snapshot.totalCount
      }, snapshot.resolved, options?.keepPrevious === true);
      return {
        rows: retained.snapshot.rows,
        totalCount: retained.snapshot.totalCount,
        hasMore: retained.snapshot.totalCount > size,
        isPreviousData: retained.isPreviousData,
        fetchNextPage: () => setState(current => current.scopeKey === scopeKey ? {
          ...current,
          size: current.size + pageSize
        } : {
          scopeKey,
          size: pageSize + pageSize
        })
      };
    }
  };
};
//# sourceMappingURL=defineView.js.map
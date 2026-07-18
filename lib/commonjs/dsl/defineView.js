"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineView = void 0;
var _react = require("react");
var _useLiveRead = require("../read/useLiveRead.js");
var _configure = require("./configure.js");
const valuesEqual = (left, right) => {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]));
  }
  return Object.is(left, right);
};
const includesEqual = (left, right) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => valuesEqual(left[key], right[key]));
};
const idsOf = value => (Array.isArray(value) ? value : value == null ? [] : [value]).filter(id => typeof id === 'string' && id.length > 0);
const resolveRelation = (row, relation) => {
  if (relation.kind === 'belongsTo') {
    const id = row[relation.foreignKey];
    return typeof id === 'string' ? relation.model.get(id) ?? null : null;
  }
  if (relation.kind === 'references') throw new Error(`Model.view does not support ${relation.kind} includes`);
  const rows = relation.model.getWhere({
    [relation.foreignKey]: row.id
  });
  if (relation.kind === 'hasMany') return rows;
  if (relation.kind === 'hasOne') {
    if (rows.length === 0) return null;
    return relation.comparator ? rows.reduce((best, candidate) => relation.comparator(candidate, best) < 0 ? candidate : best) : rows[0];
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
const defineView = (model, name, config) => {
  const source = typeof config.source === 'string' ? model.scopes[config.source] : config.source;
  if (!source || source.modelId !== model.modelId) throw new Error(`${model.modelId} has no scope ${typeof config.source === 'string' ? config.source : name} for view ${name}`);
  const relations = model.__relations();
  for (const [alias, include] of Object.entries(config.include)) {
    if (typeof include === 'string' && !relations[include]) throw new Error(`${model.modelId} has no relation ${include} for view ${name}.${alias}`);
  }
  const use = scopeValue => {
    const cacheRef = (0, _react.useRef)(new Map());
    const evaluate = () => {
      const rows = scopeValue == null ? [] : source.read(scopeValue);
      const deps = scopeValue == null ? [] : [{
        kind: 'scope',
        model: source.modelId,
        scopeKey: source.__key(scopeValue)
      }];
      const liveIds = new Set();
      const items = rows.map((row, index) => {
        liveIds.add(row.id);
        deps.push({
          kind: 'row',
          model: model.modelId,
          id: row.id
        });
        const included = {};
        for (const [alias, include] of Object.entries(config.include)) {
          if (typeof include === 'string') {
            const relation = relations[include];
            included[alias] = resolveRelation(row, relation);
            if (relation.kind === 'belongsTo') {
              const id = row[relation.foreignKey];
              if (typeof id === 'string') deps.push({
                kind: 'row',
                model: relation.model.modelId,
                id
              });
            } else {
              deps.push({
                kind: 'model',
                model: relation.model.modelId
              });
            }
          } else {
            const [target, resolveIds] = include;
            const rawIds = resolveIds(row);
            const ids = idsOf(rawIds);
            const resolved = ids.map(id => target.get(id)).filter(Boolean);
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
        const item = config.select ? config.select(row, included, {
          index
        }) : {
          ...row,
          ...included
        };
        if (current && config.renderKeys?.every(key => valuesEqual(current.item[key], item[key]))) {
          cacheRef.current.set(row.id, {
            row,
            included,
            item: current.item
          });
          return current.item;
        }
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
        deps
      };
    };
    const initial = evaluate();
    return (0, _useLiveRead.useLiveRead)(() => evaluate().items, initial.deps, _useLiveRead.arraysShallowEqual);
  };
  return {
    use,
    useWindow: (scopeValue, options) => {
      const pageSize = options?.pageSize ?? (0, _configure.getDbRuntimeConfig)().defaults?.pageSize ?? 20;
      const scopeKey = scopeValue == null ? null : source.__key(scopeValue);
      const [state, setState] = (0, _react.useState)({
        scopeKey,
        size: pageSize
      });
      const size = state.scopeKey === scopeKey ? state.size : pageSize;
      if (state.scopeKey !== scopeKey) setState({
        scopeKey,
        size: pageSize
      });
      const items = use(scopeValue);
      return {
        rows: items.slice(0, size),
        totalCount: items.length,
        hasMore: items.length > size,
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
exports.defineView = defineView;
//# sourceMappingURL=defineView.js.map
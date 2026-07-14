"use strict";

import { matchesDbWhere } from "../core/compileDbWhere.js";
import { registerApplyTarget } from "../core/apply/transaction.js";
import { createEntityClock, createEntityState } from "../core/planes/entityState.js";
import { createScopeIndex } from "../core/planes/scopeIndex.js";
import { expandPlan, registerRelationHost } from "../core/relations.js";
import { registerReset } from "../core/reset.js";
import { stableSerialize } from "../core/serialize.js";
import { fieldSpecSparseRead } from "../schema/fieldSpec.js";
import { useLiveRead, arraysShallowEqual } from "../read/useLiveRead.js";
import { getApplyRuntime, getDbRuntimeConfig, getStoragePrefix } from "./configure.js";
import { useRef, useState } from 'react';
const keyForScope = scopeValue => stableSerialize(scopeValue);
const EMPTY_ROWS = [];
const sortRows = (rows, options) => {
  if (!options?.orderBy) return rows;
  const {
    field,
    direction
  } = options.orderBy;
  return [...rows].sort((left, right) => {
    const a = left[field];
    const b = right[field];
    if (a === b) return 0;
    const result = a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
    return direction === 'asc' ? result : -result;
  });
};
const readField = (field, input, key, complete) => {
  const value = complete ? field.read(input, key) : field[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

/** Define a v6 model backed by EntityState and the shared journalled apply pipeline. */
export const defineModel = config => {
  const runtime = getDbRuntimeConfig();
  const prefix = getStoragePrefix;
  const entityState = createEntityState({
    modelId: config.id,
    clock: createEntityClock(),
    now: () => Date.now(),
    storage: runtime.storage,
    prefix
  });
  const scopeIndex = createScopeIndex({
    modelId: config.id,
    storage: runtime.storage,
    prefix
  });
  const normalize = (input, complete = false) => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = config.rowId?.(input) ?? (typeof input === 'object' && input !== null ? input.id : undefined);
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${config.name} requires id`);
    const output = {
      id
    };
    for (const [key, field] of Object.entries(config.fields)) {
      const value = readField(field, input, key, complete);
      if (value !== undefined) output[key] = value;
    }
    return output;
  };
  let relationCache = null;
  const resolvedRelations = () => relationCache ??= config.relations?.() ?? {};
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
  const writeRows = rows => {
    const changes = [];
    for (const value of rows) {
      const incoming = normalize(value);
      const current = entityState.read(incoming.id);
      if (current && config.merge?.shouldOverwrite && !config.merge.shouldOverwrite(current, incoming)) continue;
      const result = entityState.upsert({
        ...current,
        ...incoming
      });
      changes.push({
        id: incoming.id,
        changedFields: result.changedFields
      });
    }
    return changes;
  };
  const applyTarget = {
    upsert: writeRows,
    patch: (id, patch) => {
      const current = entityState.read(id);
      if (!current) return null;
      const result = entityState.upsert({
        ...current,
        ...patch,
        id
      });
      return {
        id,
        changedFields: result.changedFields
      };
    },
    destroy: ids => {
      for (const id of ids) entityState.destroy(id);
      return ids;
    },
    counter: (id, field, delta) => {
      const row = entityState.read(id);
      if (!row) return false;
      entityState.upsert({
        ...row,
        [field]: (row[field] ?? 0) + delta
      });
      return true;
    },
    scope: (scopeKey, next) => {
      scopeIndex.write(scopeKey, next);
    },
    persistEntries: () => [...entityState.persistEntries(), ...scopeIndex.persistEntries()]
  };
  registerApplyTarget(config.id, applyTarget);

  /** Snapshot writes (query pages / entity refreshes) apply verbatim - server state is derived already. */
  const applySnapshot = ops => {
    getApplyRuntime().apply(ops);
  };

  /** Imperative/domain writes are events: expand declared relation side effects into the same plan. */
  const applyEvent = ops => {
    getApplyRuntime().apply(expandPlan(ops));
  };
  const scopeSortedRows = (scopeName, scopeValue) => {
    const spec = (config.scopes ?? {})[scopeName];
    const value = scopeIndex.read(keyForScope(scopeValue));
    const rows = value.entries.map(entry => entityState.read(entry.id)).filter(Boolean);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    if ('comparator' in spec.sort) return [...rows].sort(spec.sort.comparator);
    const {
      field,
      dir
    } = spec.sort;
    return sortRows(rows, {
      orderBy: {
        field,
        direction: dir
      }
    });
  };
  const rowDep = (id, fields) => ({
    kind: 'row',
    model: config.id,
    id,
    ...(fields ? {
      fields
    } : {})
  });
  const modelDep = {
    kind: 'model',
    model: config.id
  };
  const scopeDep = scopeKey => ({
    kind: 'scope',
    model: config.id,
    scopeKey
  });
  const memberDeps = (scopeKey, rows) => [scopeDep(scopeKey), ...rows.map(row => rowDep(row.id))];
  const makeScopeHandle = scopeName => {
    const planApply = (scopeValue, rows, coverage) => {
      const scopeKey = keyForScope(scopeValue);
      const {
        next
      } = scopeIndex.reconcile(scopeKey, coverage, rows.map(({
        row,
        edge
      }) => ({
        id: row.id,
        edge
      })));
      return [{
        kind: 'upsert',
        model: config.id,
        rows: rows.map(({
          row
        }) => row)
      }, {
        kind: 'scope',
        model: config.id,
        scopeKey,
        next
      }];
    };
    return {
      use: scopeValue => {
        const rows = useLiveRead(() => scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue), scopeValue == null ? [modelDep] : memberDeps(keyForScope(scopeValue), scopeIndex.read(keyForScope(scopeValue)).entries), arraysShallowEqual);
        return rows;
      },
      useWindow: (scopeValue, options) => {
        const pageSize = options?.pageSize ?? runtime.defaults?.pageSize ?? 20;
        const [windowSize, setWindowSize] = useState(pageSize);
        const rows = useLiveRead(() => scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue), scopeValue == null ? [modelDep] : memberDeps(keyForScope(scopeValue), scopeIndex.read(keyForScope(scopeValue)).entries), arraysShallowEqual);
        const windowRef = useRef({
          source: EMPTY_ROWS,
          size: 0,
          window: EMPTY_ROWS
        });
        if (windowRef.current.source !== rows || windowRef.current.size !== windowSize) {
          windowRef.current = {
            source: rows,
            size: windowSize,
            window: rows.slice(0, windowSize)
          };
        }
        return {
          rows: windowRef.current.window,
          totalCount: rows.length,
          hasMore: rows.length > windowSize,
          loadMore: () => setWindowSize(current => current + pageSize),
          refresh: async () => {}
        };
      },
      useCount: scopeValue => useLiveRead(() => scopeValue == null ? 0 : scopeIndex.read(keyForScope(scopeValue)).entries.length, scopeValue == null ? [modelDep] : [scopeDep(keyForScope(scopeValue))]),
      invalidate: _scopeValue => {
        // Network re-fetch wiring arrives with defineQuery; local state stays authoritative here.
      },
      read: scopeValue => scopeSortedRows(scopeName, scopeValue),
      __apply: (scopeValue, rows, coverage) => {
        applySnapshot(planApply(scopeValue, rows.map(row => ({
          row
        })), coverage));
      },
      __planApply: planApply
    };
  };
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)]));
  const planRows = rows => [{
    kind: 'upsert',
    model: config.id,
    rows
  }];
  const model = {
    modelId: config.id,
    get: id => id == null ? undefined : entityState.read(id),
    getWhere: (where, options) => sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options),
    patch: (id, patch) => applyEvent([{
      kind: 'patch',
      model: config.id,
      id,
      patch: patch
    }]),
    destroy: id => applyEvent([{
      kind: 'destroy',
      model: config.id,
      ids: [id]
    }]),
    destroyMany: ids => applyEvent([{
      kind: 'destroy',
      model: config.id,
      ids
    }]),
    insertStored: row => applyEvent([{
      kind: 'upsert',
      model: config.id,
      rows: [row]
    }]),
    replaceRaw: (oldId, next) => applyEvent([{
      kind: 'destroy',
      model: config.id,
      ids: [oldId]
    }, {
      kind: 'upsert',
      model: config.id,
      rows: [next]
    }]),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: () => {
      // Network invalidation wiring arrives with defineQuery.
    },
    gc: () => 0,
    use: {
      row: (id, options) => {
        const select = options?.select;
        return useLiveRead(() => id == null ? undefined : entityState.read(id), id == null ? [] : [rowDep(id, select)]);
      },
      field: (id, field) => useLiveRead(() => id == null ? undefined : entityState.read(id)?.[field], id == null ? [] : [rowDep(id, [String(field)])]),
      first: (where, options) => useLiveRead(() => sortRows(entityState.values().filter(row => where == null || matchesDbWhere(row, where)), options)[0], [modelDep]),
      where: (where, options) => useLiveRead(() => where == null ? EMPTY_ROWS : sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options), where == null ? [] : [modelDep], arraysShallowEqual),
      byIds: ids => useLiveRead(() => ids.map(id => entityState.read(id)).filter(Boolean), ids.map(id => rowDep(id)), arraysShallowEqual),
      count: where => useLiveRead(() => where == null ? entityState.values().length : entityState.values().filter(row => matchesDbWhere(row, where)).length, [modelDep]),
      related: (id, relationName) => {
        const relation = resolvedRelations()[relationName];
        if (!relation) throw new Error(`${config.name} has no relation ${relationName}`);
        let compute;
        let deps;
        let isEqual = Object.is;
        if (relation.kind === 'belongsTo') {
          const parentIdOf = () => {
            const child = id == null ? undefined : entityState.read(id);
            const value = child?.[relation.foreignKey];
            return typeof value === 'string' && value.length > 0 ? value : null;
          };
          compute = () => {
            const parentId = parentIdOf();
            return parentId ? relation.model.get(parentId) : undefined;
          };
          const parentId = parentIdOf();
          deps = id == null ? [] : [rowDep(id, [relation.foreignKey]), ...(parentId ? [{
            kind: 'row',
            model: relation.model.modelId,
            id: parentId
          }] : [])];
        } else if (relation.kind === 'hasMany') {
          compute = () => id == null ? EMPTY_ROWS : relation.model.getWhere({
            [relation.foreignKey]: id
          });
          deps = id == null ? [] : [{
            kind: 'model',
            model: relation.model.modelId
          }];
          isEqual = (a, b) => arraysShallowEqual(a, b);
        } else {
          const comparator = relation.comparator;
          compute = () => {
            if (id == null) return undefined;
            const rows = relation.model.getWhere({
              [relation.foreignKey]: id
            });
            if (rows.length === 0) return undefined;
            return comparator ? rows.reduce((best, row) => comparator(row, best) < 0 ? row : best) : rows[0];
          };
          deps = id == null ? [] : [{
            kind: 'model',
            model: relation.model.modelId
          }];
        }
        return useLiveRead(compute, deps, isEqual);
      }
    },
    scopes: scopeHandles,
    registerReset: fn => {
      registerReset(fn);
    },
    __applyRows: rows => applySnapshot(planRows(rows)),
    __planRows: planRows
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
//# sourceMappingURL=defineModel.js.map
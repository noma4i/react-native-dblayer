"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModel = void 0;
var _react = require("react");
var _compileDbWhere = require("../core/compileDbWhere.js");
var _transaction = require("../core/apply/transaction.js");
var _entityState = require("../core/planes/entityState.js");
var _scopeIndex = require("../core/planes/scopeIndex.js");
var _reset = require("../core/reset.js");
var _serialize = require("../core/serialize.js");
var _fieldSpec = require("../schema/fieldSpec.js");
var _configure = require("./configure.js");
const keyForScope = scopeValue => (0, _serialize.stableSerialize)(scopeValue);
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
  const value = complete ? field.read(input, key) : field[_fieldSpec.fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

/** Define a v6 model backed by EntityState and the journalled apply pipeline. */
const defineModel = config => {
  const runtime = (0, _configure.getDbRuntimeConfig)();
  let tick = 0;
  const listeners = new Set();
  const notify = () => {
    tick += 1;
    for (const listener of listeners) listener();
  };
  const subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const snapshot = () => tick;
  const entityState = (0, _entityState.createEntityState)((0, _entityState.createEntityClock)(), () => 0);
  const scopeIndex = (0, _scopeIndex.createScopeIndex)();
  const apply = (0, _transaction.createApplyRuntime)(runtime.storage, (0, _configure.getAccountPartitionPrefix)());
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
  const writeRows = rows => {
    for (const value of rows) {
      const incoming = normalize(value);
      const current = entityState.read(incoming.id);
      if (current && config.merge?.shouldOverwrite && !config.merge.shouldOverwrite(current, incoming)) continue;
      entityState.upsert({
        ...current,
        ...incoming
      });
    }
    notify();
  };
  const writeDestroy = ids => {
    for (const id of ids) entityState.destroy(id);
    notify();
  };
  const unregisterTarget = (0, _transaction.registerApplyTarget)(config.id, {
    upsert: writeRows,
    destroy: writeDestroy,
    counter: (id, field, delta) => {
      const row = entityState.read(id);
      if (row) entityState.upsert({
        ...row,
        [field]: (row[field] ?? 0) + delta
      });
      notify();
    },
    scope: (hash, next) => {
      scopeIndex.write(hash, next);
      notify();
    }
  });
  const applyOps = ops => apply.apply(ops);
  const rowsForScope = scopeValue => scopeIndex.read(keyForScope(scopeValue)).entries.map(entry => entityState.read(entry.id)).filter(Boolean);
  const useSnapshot = () => {
    (0, _react.useSyncExternalStore)(subscribe, snapshot, snapshot);
  };
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, {
    use: scopeValue => {
      useSnapshot();
      return scopeValue == null ? [] : rowsForScope(scopeValue);
    },
    useWindow: (scopeValue, options) => {
      useSnapshot();
      const rows = scopeValue == null ? [] : rowsForScope(scopeValue);
      const pageSize = options?.pageSize ?? runtime.defaults?.pageSize ?? 20;
      return {
        rows: rows.slice(0, pageSize),
        totalCount: rows.length,
        hasMore: rows.length > pageSize,
        loadMore: () => {},
        refresh: async () => {}
      };
    },
    useCount: scopeValue => {
      useSnapshot();
      return scopeValue == null ? 0 : rowsForScope(scopeValue).length;
    },
    invalidate: _scopeValue => notify(),
    read: rowsForScope,
    __apply: (scopeValue, rows, coverage) => {
      const hash = keyForScope(scopeValue);
      const previous = scopeIndex.read(hash);
      const existing = new Set(previous.entries.map(entry => entry.id));
      const entries = coverage === 'complete' ? rows.map((row, order) => ({
        id: row.id,
        order,
        seq: previous.generation + 1
      })) : [...previous.entries, ...rows.filter(row => !existing.has(row.id)).map((row, order) => ({
        id: row.id,
        order: previous.entries.length + order,
        seq: previous.generation + 1
      }))];
      applyOps([{
        kind: 'upsert',
        model: config.id,
        rows
      }, {
        kind: 'scope',
        model: config.id,
        scopeHash: hash,
        next: {
          generation: previous.generation + 1,
          coverage,
          entries
        }
      }]);
    }
  }]));
  const model = {
    get: id => id == null ? undefined : entityState.read(id),
    getWhere: (where, options) => sortRows(entityState.values().filter(row => (0, _compileDbWhere.matchesDbWhere)(row, where)), options),
    patch: (id, patch) => {
      const current = entityState.read(id);
      if (current) applyOps([{
        kind: 'upsert',
        model: config.id,
        rows: [{
          ...current,
          ...patch,
          id
        }]
      }]);
    },
    destroy: id => applyOps([{
      kind: 'destroy',
      model: config.id,
      ids: [id]
    }]),
    destroyMany: ids => applyOps([{
      kind: 'destroy',
      model: config.id,
      ids
    }]),
    insertStored: row => applyOps([{
      kind: 'upsert',
      model: config.id,
      rows: [row]
    }]),
    replaceRaw: (oldId, next) => applyOps([{
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
    invalidate: () => notify(),
    gc: () => 0,
    use: {
      row: id => {
        useSnapshot();
        return id == null ? undefined : entityState.read(id);
      },
      field: (id, field) => {
        useSnapshot();
        return id == null ? undefined : entityState.read(id)?.[field];
      },
      first: (where, options) => {
        useSnapshot();
        return sortRows(entityState.values().filter(row => where == null || (0, _compileDbWhere.matchesDbWhere)(row, where)), options)[0];
      },
      where: (where, options) => {
        useSnapshot();
        return where == null ? [] : sortRows(entityState.values().filter(row => (0, _compileDbWhere.matchesDbWhere)(row, where)), options);
      },
      byIds: ids => {
        useSnapshot();
        return ids.map(id => entityState.read(id)).filter(Boolean);
      },
      count: where => {
        useSnapshot();
        return where == null ? entityState.values().length : entityState.values().filter(row => (0, _compileDbWhere.matchesDbWhere)(row, where)).length;
      }
    },
    scopes: scopeHandles,
    registerReset: fn => {
      (0, _reset.registerReset)(fn);
    },
    __applyRows: rows => applyOps([{
      kind: 'upsert',
      model: config.id,
      rows
    }])
  };
  (0, _reset.registerReset)(() => {
    entityState.reset();
    scopeIndex.reset();
    unregisterTarget();
    notify();
  });
  return Object.assign(model, config.statics?.(model));
};
exports.defineModel = defineModel;
//# sourceMappingURL=defineModel.js.map
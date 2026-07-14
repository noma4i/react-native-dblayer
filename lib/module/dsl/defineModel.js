"use strict";

import { useSyncExternalStore } from 'react';
import { matchesDbWhere } from "../core/compileDbWhere.js";
import { createApplyRuntime, registerApplyTarget } from "../core/apply/transaction.js";
import { createEntityClock, createEntityState } from "../core/planes/entityState.js";
import { createScopeIndex } from "../core/planes/scopeIndex.js";
import { registerReset } from "../core/reset.js";
import { stableSerialize } from "../core/serialize.js";
import { fieldSpecSparseRead } from "../schema/fieldSpec.js";
import { getAccountPartitionPrefix, getCommitBus, getDbRuntimeConfig } from "./configure.js";
const keyForScope = scopeValue => stableSerialize(scopeValue);
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

/** Define a v6 model backed by EntityState and the journalled apply pipeline. */
export const defineModel = config => {
  const runtime = getDbRuntimeConfig();
  let tick = 0;
  const bus = getCommitBus();
  const notify = () => {
    tick += 1;
  };
  const subscribe = listener => {
    const subscription = bus.subscribe(() => {
      tick += 1;
      listener();
    }, [{
      kind: 'model',
      model: config.id
    }]);
    return subscription.unsubscribe;
  };
  const snapshot = () => tick;
  const prefix = getAccountPartitionPrefix;
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
  const apply = createApplyRuntime({
    storage: runtime.storage,
    prefix,
    bus
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
  const writeDestroy = ids => {
    for (const id of ids) entityState.destroy(id);
    return ids;
  };
  const unregisterTarget = registerApplyTarget(config.id, {
    upsert: writeRows,
    destroy: writeDestroy,
    counter: (id, field, delta) => {
      const row = entityState.read(id);
      if (!row) return false;
      entityState.upsert({
        ...row,
        [field]: (row[field] ?? 0) + delta
      });
      return true;
    },
    scope: (hash, next) => {
      scopeIndex.write(hash, next);
    },
    persistEntries: () => [...entityState.persistEntries(), ...scopeIndex.persistEntries()]
  });
  const applyOps = ops => {
    apply.apply(ops);
  };
  const rowsForScope = scopeValue => scopeIndex.read(keyForScope(scopeValue)).entries.map(entry => entityState.read(entry.id)).filter(Boolean);
  const useSnapshot = () => {
    useSyncExternalStore(subscribe, snapshot, snapshot);
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
      const {
        next
      } = scopeIndex.reconcile(hash, coverage, rows.map(row => ({
        id: row.id
      })));
      applyOps([{
        kind: 'upsert',
        model: config.id,
        rows
      }, {
        kind: 'scope',
        model: config.id,
        scopeKey: hash,
        next
      }]);
    }
  }]));
  const model = {
    get: id => id == null ? undefined : entityState.read(id),
    getWhere: (where, options) => sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options),
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
        return sortRows(entityState.values().filter(row => where == null || matchesDbWhere(row, where)), options)[0];
      },
      where: (where, options) => {
        useSnapshot();
        return where == null ? [] : sortRows(entityState.values().filter(row => matchesDbWhere(row, where)), options);
      },
      byIds: ids => {
        useSnapshot();
        return ids.map(id => entityState.read(id)).filter(Boolean);
      },
      count: where => {
        useSnapshot();
        return where == null ? entityState.values().length : entityState.values().filter(row => matchesDbWhere(row, where)).length;
      }
    },
    scopes: scopeHandles,
    registerReset: fn => {
      registerReset(fn);
    },
    __applyRows: rows => applyOps([{
      kind: 'upsert',
      model: config.id,
      rows
    }])
  };
  registerReset(() => {
    entityState.reset();
    scopeIndex.reset();
    unregisterTarget();
    notify();
  });
  return Object.assign(model, config.statics?.(model));
};
//# sourceMappingURL=defineModel.js.map
"use strict";

import { buildScopeKey, matchesDbWhere } from "../core/compileDbWhere.js";
import { registerApplyTarget } from "../core/apply/transaction.js";
import { registerGcHost } from "../core/gc.js";
import { createEntityClock, createEntityState } from "../core/planes/entityState.js";
import { createScopeIndex } from "../core/planes/scopeIndex.js";
import { invalidateModel } from "../core/invalidationRegistry.js";
import { getDbLogger } from "../core/logger.js";
import { expandPlan, registerRelationHost } from "../core/relations.js";
import { registerReset } from "../core/reset.js";
import { fieldSpecSparseRead } from "../schema/fieldSpec.js";
import { useLiveRead, arraysShallowEqual } from "../read/useLiveRead.js";
import { getApplyRuntime, getDbRuntimeConfig, getStoragePrefix } from "./configure.js";
import { useRef, useState } from 'react';
const keyForScope = (scopeName, scopeValue) => `${scopeName}:${buildScopeKey(scopeValue)}`;
const EMPTY_ROWS = [];
const sortRows = (rows, options) => {
  const ordered = options?.orderBy ? [...rows].sort((left, right) => {
    const {
      field,
      direction
    } = options.orderBy;
    const a = left[field];
    const b = right[field];
    if (a === b) return 0;
    const result = a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
    return direction === 'asc' ? result : -result;
  }) : rows;
  return options?.limit === undefined ? ordered : ordered.slice(0, Math.max(0, options.limit));
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
  let planesRef = null;
  /** Planes are created and hydrated on first touch, so models can be defined before configureDb. */
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const entityState = createEntityState({
      modelId: config.id,
      clock: createEntityClock(),
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: getStoragePrefix
    });
    const scopeIndex = createScopeIndex({
      modelId: config.id,
      scopeNames: Object.keys(config.scopes ?? {}),
      storage: runtime.storage,
      prefix: getStoragePrefix
    });
    entityState.hydrate();
    scopeIndex.hydrate();
    planesRef = {
      entityState,
      scopeIndex
    };
    return planesRef;
  };
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

  /** Plan-build validation: raw rows stay in the op (normalize is shape-sensitive); invalid rows drop here. */
  const isPlanRow = value => {
    try {
      normalize(value);
      return true;
    } catch (error) {
      getDbLogger().error(`[${config.name}] plan row rejected`, {
        error
      });
      return false;
    }
  };
  let relationCache = null;
  const resolvedRelations = () => relationCache ??= config.relations?.() ?? {};
  const membershipScopes = Object.entries(config.scopes ?? {}).filter(entry => Boolean(entry[1].by));
  const scopeValueFromRow = (by, row) => {
    const value = {};
    for (const [scopeField, rowField] of Object.entries(by)) {
      const fieldValue = row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const isScopeMember = (scopeKey, id) => planes().scopeIndex.has(scopeKey, id);

  /** Declarative membership: an event row joins/leaves its `by` scopes inside the SAME plan. */
  const membershipForUpsert = row => {
    const id = String(row.id);
    const before = planes().entityState.read(id);
    const merged = {
      ...before,
      ...row,
      id
    };
    const deltas = [];
    for (const [scopeName, spec] of membershipScopes) {
      const beforeValue = before ? scopeValueFromRow(spec.by, before) : null;
      const afterValue = scopeValueFromRow(spec.by, merged);
      const beforeKey = beforeValue ? keyForScope(scopeName, beforeValue) : null;
      const afterKey = afterValue ? keyForScope(scopeName, afterValue) : null;
      if (beforeKey && beforeKey !== afterKey && isScopeMember(beforeKey, id)) deltas.push({
        scopeKey: beforeKey,
        detach: [id]
      });
      if (afterKey && !isScopeMember(afterKey, id)) deltas.push({
        scopeKey: afterKey,
        append: [id]
      });
    }
    return deltas;
  };
  const membershipForPatch = (id, patch) => {
    const current = planes().entityState.read(id);
    if (!current) return [];
    return membershipForUpsert({
      ...patch,
      id
    });
  };
  const detachForDestroy = id => planes().scopeIndex.keysOf(id).map(scopeKey => ({
    scopeKey,
    detach: [id]
  }));
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
  const writeRows = (rows, origin) => {
    const changes = [];
    for (const value of rows) {
      let incoming;
      try {
        incoming = normalize(value);
      } catch (error) {
        getDbLogger().error(`[${config.name}] apply row rejected`, {
          error
        });
        continue;
      }
      if (origin !== 'replace' && planes().entityState.isTombstoned(incoming.id)) continue;
      const current = planes().entityState.read(incoming.id);
      if (current && config.merge?.shouldOverwrite && !config.merge.shouldOverwrite(current, incoming)) continue;
      const result = planes().entityState.upsert({
        ...current,
        ...incoming
      });
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
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
      const current = planes().entityState.read(id);
      if (!current) return null;
      const result = planes().entityState.upsert({
        ...current,
        ...patch,
        id
      });
      if (result.changedFields !== null && result.changedFields.length === 0) return null;
      return {
        id,
        changedFields: result.changedFields
      };
    },
    destroy: (ids, tombstone) => {
      const removed = [];
      for (const id of ids) {
        const existed = planes().entityState.read(id) !== undefined;
        planes().entityState.destroy(id, {
          tombstone
        });
        if (existed) removed.push(id);
      }
      return removed;
    },
    counter: (id, field, delta) => {
      const row = planes().entityState.read(id);
      if (!row) return false;
      planes().entityState.upsert({
        ...row,
        [field]: (row[field] ?? 0) + delta
      });
      return true;
    },
    scope: (scopeKey, next) => {
      planes().scopeIndex.write(scopeKey, next);
    },
    scopeDelta: (scopeKey, delta) => {
      if (delta.detach.length > 0) planes().scopeIndex.detach(scopeKey, delta.detach);
      if (delta.append.length > 0) planes().scopeIndex.reconcile(scopeKey, 'delta', delta.append);
    },
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()]
  };
  registerApplyTarget(config.id, applyTarget);
  registerGcHost(config.id, {
    modelId: config.id,
    exempt: config.gc === 'exempt',
    rowIds: () => planes().entityState.values().map(row => String(row.id)),
    hasRow: id => planes().entityState.read(id) !== undefined,
    scopeKeys: () => planes().scopeIndex.keys(),
    scopeEntryIds: key => planes().scopeIndex.read(key).entries.map(entry => entry.id),
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
      const out = [];
      for (const relation of Object.values(resolvedRelations())) {
        if (relation.kind === 'belongsTo') {
          const value = row[relation.foreignKey];
          if (typeof value === 'string' && value.length > 0) out.push({
            model: relation.model.modelId,
            id: value
          });
        }
        if (relation.kind === 'references') {
          const raw = relation.ids(row);
          const list = Array.isArray(raw) ? raw : [raw];
          for (const value of list) {
            if (typeof value === 'string' && value.length > 0) out.push({
              model: relation.model.modelId,
              id: value
            });
          }
        }
      }
      return out;
    }
  });

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
    const value = planes().scopeIndex.read(keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter(Boolean);
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
    const spec = (config.scopes ?? {})[scopeName];
    const planApply = (scopeValue, rows, coverage, opts) => {
      const liveRows = rows.filter(({
        row
      }) => isPlanRow(row)).filter(({
        row
      }) => !planes().entityState.isTombstoned(String(row.id)));
      const scopeKey = keyForScope(scopeName, scopeValue);
      let {
        next
      } = planes().scopeIndex.reconcileNext(scopeKey, coverage, liveRows.map(({
        row,
        edge
      }) => ({
        id: row.id,
        edge
      })), opts);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (opts?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        next = planes().scopeIndex.trimValue(next, maxRows).next;
      }
      return [{
        kind: 'upsert',
        model: config.id,
        rows: liveRows.map(({
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
      modelId: config.id,
      use: scopeValue => {
        const rows = useLiveRead(() => scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue), scopeValue == null ? [modelDep] : memberDeps(keyForScope(scopeName, scopeValue), planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries), arraysShallowEqual);
        return rows;
      },
      useWindow: (scopeValue, options) => {
        const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const [windowSize, setWindowSize] = useState(pageSize);
        const rows = useLiveRead(() => scopeValue == null ? EMPTY_ROWS : scopeSortedRows(scopeName, scopeValue), scopeValue == null ? [modelDep] : memberDeps(keyForScope(scopeName, scopeValue), planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries), arraysShallowEqual);
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
          loadMore: () => setWindowSize(current => current + pageSize)
        };
      },
      useCount: scopeValue => useLiveRead(() => scopeValue == null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length, scopeValue == null ? [] : [scopeDep(keyForScope(scopeName, scopeValue))]),
      invalidate: scopeValue => {
        invalidateModel(config.id, scopeValue);
      },
      read: scopeValue => scopeSortedRows(scopeName, scopeValue),
      __apply: (scopeValue, rows, coverage, opts) => {
        applySnapshot(planApply(scopeValue, rows.map(row => ({
          row
        })), coverage, opts));
      },
      __planApply: planApply
    };
  };
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)]));
  const planRows = rows => [{
    kind: 'upsert',
    model: config.id,
    rows: rows.filter(isPlanRow)
  }];
  const captureMembership = id => planes().scopeIndex.keysOf(id).flatMap(scopeKey => {
    const entry = planes().scopeIndex.read(scopeKey).entries.find(candidate => candidate.id === id);
    return entry ? [{
      id,
      scopeKey,
      order: entry.order,
      edge: entry.edge
    }] : [];
  });
  const restoreMembership = (nextId, memberships) => memberships.map(membership => ({
    kind: 'scope-delta',
    model: config.id,
    scopeKey: membership.scopeKey,
    append: [{
      id: nextId,
      order: membership.order,
      edge: membership.edge
    }],
    detach: [membership.id]
  }));
  const replacementId = next => {
    try {
      return normalize(next).id;
    } catch {
      return null;
    }
  };
  const planReplace = (oldId, next) => {
    const memberships = captureMembership(oldId);
    const nextId = replacementId(next);
    return [{
      kind: 'destroy',
      model: config.id,
      ids: [oldId]
    }, {
      kind: 'upsert',
      model: config.id,
      rows: [next],
      origin: 'replace'
    }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
  };
  const planRestore = (next, memberships) => {
    const nextId = replacementId(next);
    return [{
      kind: 'upsert',
      model: config.id,
      rows: [next],
      origin: 'replace'
    }, ...(nextId == null ? [] : restoreMembership(nextId, memberships))];
  };
  const model = {
    modelId: config.id,
    get: id => id == null ? undefined : planes().entityState.read(id),
    getWhere: (where, options) => sortRows(planes().entityState.values().filter(row => matchesDbWhere(row, where)), options),
    getAll: () => planes().entityState.values(),
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
    replaceRaw: (oldId, next) => applyEvent(planReplace(oldId, next)),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      invalidateModel(config.id, scope);
    },
    use: {
      row: (id, options) => {
        const select = options?.select;
        return useLiveRead(() => id == null ? undefined : planes().entityState.read(id), id == null ? [] : [rowDep(id, select)]);
      },
      field: (id, field) => useLiveRead(() => id == null ? undefined : planes().entityState.read(id)?.[field], id == null ? [] : [rowDep(id, [String(field)])]),
      first: (where, options) => useLiveRead(() => sortRows(planes().entityState.values().filter(row => where == null || matchesDbWhere(row, where)), options)[0], [modelDep]),
      where: (where, options) => useLiveRead(() => where == null ? EMPTY_ROWS : sortRows(planes().entityState.values().filter(row => matchesDbWhere(row, where)), options), where == null ? [] : [modelDep], arraysShallowEqual),
      byIds: ids => useLiveRead(() => ids.map(id => planes().entityState.read(id)).filter(Boolean), ids.map(id => rowDep(id)), arraysShallowEqual),
      count: where => useLiveRead(() => where == null ? planes().entityState.values().length : planes().entityState.values().filter(row => matchesDbWhere(row, where)).length, [modelDep]),
      related: (id, relationName) => {
        const relation = resolvedRelations()[relationName];
        if (!relation) throw new Error(`${config.name} has no relation ${relationName}`);
        let compute;
        let deps;
        let isEqual = Object.is;
        if (relation.kind === 'belongsTo') {
          const parentIdOf = () => {
            const child = id == null ? undefined : planes().entityState.read(id);
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
        } else if (relation.kind === 'hasOne') {
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
//# sourceMappingURL=defineModel.js.map
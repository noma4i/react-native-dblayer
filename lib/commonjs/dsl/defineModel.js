"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModel = void 0;
var _compileDbWhere = require("../core/compileDbWhere.js");
var _transaction = require("../core/apply/transaction.js");
var _liveScopeReads = require("../core/tanstack/liveScopeReads.js");
var _mirror = require("../core/tanstack/mirror.js");
var _gc = require("../core/gc.js");
var _entityState = require("../core/planes/entityState.js");
var _scopeIndex = require("../core/planes/scopeIndex.js");
var _invalidationRegistry = require("../core/invalidationRegistry.js");
var _logger = require("../core/logger.js");
var _relations = require("../core/relations.js");
var _reset = require("../core/reset.js");
var _fieldSpec = require("../schema/fieldSpec.js");
var _useLiveRead = require("../read/useLiveRead.js");
var _projectionGate = require("../read/projectionGate.js");
var _incrementalReadEngine = require("../read/incrementalReadEngine.js");
var _configure = require("./configure.js");
var _defineFetch = require("./defineFetch.js");
var _defineMutation = require("./defineMutation.js");
var _defineQuery = require("./defineQuery.js");
var _defineView = require("./defineView.js");
var _defineIngest = require("./defineIngest.js");
var _readBuilder = require("./readBuilder.js");
var _requireFields = require("../read/requireFields.js");
var _react = require("react");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _transport = require("../core/transport.js");
var _modelStatusPoller = require("../utils/modelStatusPoller.js");
var _runtimePrimitives = require("../utils/runtimePrimitives.js");
var _maintenanceRegistry = require("./maintenanceRegistry.js");
var _esToolkit = require("es-toolkit");
var _subscriptionRuntime = require("../core/subscriptionRuntime.js");
var _internalHandles = require("../core/internalHandles.js");
const issuedScopeSequenceByKey = new Map();
(0, _reset.registerReset)(() => {
  issuedScopeSequenceByKey.clear();
});

/** Result of ScopeHandle.useWindow: locally-windowed scope rows plus paging/resolution flags. */

/** Manual injection surface for a query's colocated live entries. */

/**
 * Reactive access to one named scope of a model (`model.scopes.<name>`), backed by the scope's
 * membership index. `scopeValue` selects the concrete scope instance (e.g. `{ chatId }`); `null`/`undefined`
 * reads as empty without subscribing.
 */

const EMPTY_ROWS = [];
const readField = (field, input, key, complete) => {
  const value = complete ? field.read(input, key) : field[_fieldSpec.fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/merge policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `patch`/`destroy`/`insertStored`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
const defineModel = config => {
  const mergeGate = (() => {
    const groups = config.mergePolicy?.groups;
    if (!groups) return undefined;
    if (groups.length === 0) throw new Error(`${config.name} mergePolicy groups must not be empty`);
    const declaredFields = new Set(Object.keys(config.fields));
    const groupedFields = new Set();
    for (const group of groups) {
      if (group.fields.length === 0) throw new Error(`${config.name} mergePolicy groups must not be empty`);
      for (const field of group.fields) {
        if (!declaredFields.has(field)) throw new Error(`${config.name} mergePolicy field ${field} is not declared`);
        if (groupedFields.has(field)) throw new Error(`${config.name} mergePolicy field ${field} appears in more than one group`);
        groupedFields.add(field);
      }
    }
    return (previous, incoming) => {
      let merged;
      for (const group of groups) {
        if (!group.fields.some(field => !Object.is(incoming[field], previous[field])) || group.allowWrite(incoming, previous)) continue;
        merged ??= {
          ...incoming
        };
        for (const field of group.fields) merged[field] = previous[field];
      }
      return merged ?? incoming;
    };
  })();
  let planesRef = null;
  let revision = 0;
  /** Planes are created and hydrated on first touch, so models can be defined before configureDb. */
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = (0, _configure.getDbRuntimeConfig)();
    const entityState = (0, _entityState.createEntityState)({
      modelId: config.id,
      clock: (0, _entityState.createEntityClock)(),
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: _configure.getStoragePrefix,
      mergeGate
    });
    const scopeIndex = (0, _scopeIndex.createScopeIndex)({
      modelId: config.id,
      scopeNames: Object.keys(config.scopes ?? {}),
      storage: runtime.storage,
      prefix: _configure.getStoragePrefix
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
    const id = (0, _normalizeHelpers.stringifyNullish)(config.rowId?.(input) ?? ((0, _normalizeHelpers.isRecord)(input) ? input.id : undefined));
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
      (0, _logger.getDbLogger)().error(`[${config.name}] plan row rejected`, {
        error
      });
      return false;
    }
  };
  let relationCache = null;
  const resolvedRelations = () => relationCache ??= config.relations?.() ?? {};
  const membershipScopes = Object.entries(config.scopes ?? {}).flatMap(([name, spec]) => spec.by ? [[name, {
    ...spec,
    by: spec.by
  }]] : []);
  const scopeValueFromRow = (by, row) => {
    const value = {};
    for (const [scopeField, rowField] of Object.entries(by)) {
      const fieldSpec = config.fields[rowField];
      const fieldValue = fieldSpec ? readField(fieldSpec, row, rowField, false) : row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const scopeByFieldMap = new Map(membershipScopes.map(([name, spec]) => [name, spec.by]));
  const coerceScopeValueForKey = (scopeName, scopeValue) => {
    if (!(0, _normalizeHelpers.isRecord)(scopeValue)) return scopeValue;
    const by = scopeByFieldMap.get(scopeName);
    if (!by) return scopeValue;
    const out = {};
    for (const [scopeField, raw] of Object.entries(scopeValue)) {
      const rowField = by[scopeField];
      const fieldSpec = rowField ? config.fields[rowField] : undefined;
      out[scopeField] = fieldSpec && raw !== undefined && raw !== null ? fieldSpec.readValue(raw) : raw;
    }
    return out;
  };
  const keyForScope = (scopeName, scopeValue) => `${scopeName}:${(0, _compileDbWhere.buildScopeKey)(coerceScopeValueForKey(scopeName, scopeValue))}`;
  const criteriaCache = new WeakMap();
  const normalizeCriteria = where => {
    if (typeof where !== 'object' || where === null || Array.isArray(where)) return where;
    const record = where;
    if ('and' in record) return {
      and: record.and.map(normalizeCriteria)
    };
    if ('or' in record) return {
      or: record.or.map(normalizeCriteria)
    };
    if ('not' in record) return {
      not: normalizeCriteria(record.not)
    };
    const out = {};
    for (const [key, value] of Object.entries(record)) {
      const fieldSpec = config.fields[key];
      const normalizeOperand = operand => {
        if (operand === undefined || operand === null) return operand;
        if (key === 'id') return (0, _normalizeHelpers.stringifyNullish)(operand);
        const normalized = fieldSpec ? fieldSpec.readValue(operand) : undefined;
        return normalized === undefined || normalized === null ? operand : normalized;
      };
      if ((0, _compileDbWhere.isWhereOperatorValue)(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([operator, operand]) => [operator, Array.isArray(operand) ? operand.map(normalizeOperand) : normalizeOperand(operand)]));
        continue;
      }
      out[key] = normalizeOperand(value);
    }
    return out;
  };
  const matchesCriteria = (row, where) => {
    if (typeof where !== 'object' || where === null) return (0, _compileDbWhere.matchesDbWhere)(row, where);
    let normalized = criteriaCache.get(where);
    if (!normalized) {
      normalized = normalizeCriteria(where);
      criteriaCache.set(where, normalized);
    }
    return (0, _compileDbWhere.matchesDbWhere)(row, normalized);
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
  (0, _relations.registerRelationHost)(config.id, {
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
        (0, _logger.getDbLogger)().error(`[${config.name}] apply row rejected`, {
          error
        });
        continue;
      }
      if (origin === undefined && planes().entityState.isTombstoned(incoming.id)) continue;
      const current = planes().entityState.read(incoming.id);
      if (current && config.merge?.shouldOverwrite && !config.merge.shouldOverwrite(current, incoming)) continue;
      let merged = {
        ...current,
        ...incoming
      };
      if (current && origin !== 'replace') {
        const owned = (0, _configure.getOperationState)().ownedFields(config.id, incoming.id);
        if (owned.size > 0) for (const field of owned) if (field in current) merged[field] = current[field];
      }
      const result = planes().entityState.upsert(merged);
      if (result.changedFields !== null && result.changedFields.length === 0) continue;
      changes.push({
        id: incoming.id,
        changedFields: result.changedFields
      });
    }
    if (changes.length > 0) revision += 1;
    return changes;
  };
  const applyTarget = {
    readRow: id => planes().entityState.read(id),
    readAllRows: () => planes().entityState.values(),
    readScopeOrder: scopeKey => {
      const separator = scopeKey.indexOf(`:`);
      const scopeName = separator < 0 ? scopeKey : scopeKey.slice(0, separator);
      const rawValue = separator < 0 ? `{}` : scopeKey.slice(separator + 1);
      try {
        return scopeSortedRows(scopeName, JSON.parse(rawValue)).map(row => String(row.id));
      } catch {
        return planes().scopeIndex.read(scopeKey).entries.map(entry => entry.id);
      }
    },
    readScopeEntries: scopeKey => planes().scopeIndex.read(scopeKey).entries,
    readScopeOrderRevision: scopeKey => planes().scopeIndex.orderRevision(scopeKey),
    scopeOrderAffected: (scopeKey, id, fields) => {
      if (fields === null || !planes().scopeIndex.has(scopeKey, id)) return true;
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`:`));
      const spec = config.scopes?.[scopeName];
      if (!spec) return false;
      if (spec.sort && spec.sort !== `server-order` && `comparator` in spec.sort) return true;
      const relevant = new Set(spec.by ? Object.values(spec.by) : []);
      if (spec.sort && spec.sort !== `server-order` && `field` in spec.sort) relevant.add(String(spec.sort.field));
      return fields.some(field => relevant.has(field));
    },
    scopeSortMeta: scopeKey => {
      const scopeName = scopeKey.slice(0, scopeKey.indexOf(`:`));
      const sort = config.scopes?.[scopeName]?.sort;
      if (!sort || sort === `server-order`) return {
        kind: `server-order`
      };
      if (`comparator` in sort) return {
        kind: `comparator`
      };
      return {
        kind: `field`,
        field: String(sort.field),
        dir: sort.dir
      };
    },
    readAllScopeKeys: () => planes().scopeIndex.keys(),
    upsert: writeRows,
    patch: (id, patch) => {
      const key = String(id);
      const current = planes().entityState.read(key);
      if (!current) return null;
      const result = planes().entityState.upsert({
        ...current,
        ...patch,
        id: key
      });
      if (result.changedFields !== null && result.changedFields.length === 0) return null;
      revision += 1;
      return {
        id: key,
        changedFields: result.changedFields
      };
    },
    destroy: (ids, tombstone) => {
      const removed = [];
      for (const id of ids) {
        const key = String(id);
        const existed = planes().entityState.read(key) !== undefined;
        planes().entityState.destroy(key, {
          tombstone
        });
        if (existed) removed.push(key);
      }
      if (removed.length > 0) revision += 1;
      return removed;
    },
    counter: (id, field, delta, next) => {
      const key = String(id);
      const row = planes().entityState.read(key);
      if (!row) return false;
      planes().entityState.upsert({
        ...row,
        id: key,
        [field]: next ?? (row[field] ?? 0) + delta
      });
      revision += 1;
      return true;
    },
    counterValue: (id, field) => {
      const value = planes().entityState.read(id)?.[field];
      return typeof value === 'number' ? value : value == null ? null : Number(value);
    },
    scope: (scopeKey, next) => {
      planes().scopeIndex.write(scopeKey, next);
    },
    scopeDelta: (scopeKey, delta) => {
      if (delta.detach.length > 0) planes().scopeIndex.detach(scopeKey, delta.detach);
      if (delta.append.length > 0) planes().scopeIndex.reconcile(scopeKey, 'delta', delta.append);
    },
    reactiveScopes: ids => planes().scopeIndex.touchMembers(ids),
    persistEntries: () => [...planes().entityState.persistEntries(), ...planes().scopeIndex.persistEntries()]
  };
  (0, _transaction.registerApplyTarget)(config.id, applyTarget);
  if ((0, _configure.hasReplayedJournal)()) (0, _mirror.seedCollections)([config.id]);
  (0, _gc.registerGcHost)(config.id, {
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
    idleScopeAfterMs: () => config.maintenance?.dropIdleScopesAfterMs,
    scopeLastAccess: key => planes().scopeIndex.lastAccess(key),
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
    (0, _configure.getApplyRuntime)().apply(ops);
  };

  /** Imperative/domain writes are events: expand declared relation side effects into the same plan. */
  const applyEvent = ops => {
    (0, _configure.getApplyRuntime)().apply((0, _relations.expandPlan)(ops.map(op => op.kind === 'upsert' && op.origin === undefined ? {
      ...op,
      origin: 'event'
    } : op)));
  };
  const scopeSortedRows = (scopeName, scopeValue) => {
    const spec = (config.scopes ?? {})[scopeName];
    const value = planes().scopeIndex.read(keyForScope(scopeName, scopeValue));
    const rows = value.entries.map(entry => planes().entityState.read(entry.id)).filter(row => row !== undefined);
    if (!spec?.sort || spec.sort === 'server-order') return rows;
    if ('comparator' in spec.sort) return [...rows].sort(spec.sort.comparator);
    const {
      field,
      dir
    } = spec.sort;
    return (0, _incrementalReadEngine.sortModelReadRows)(rows, [{
      field,
      direction: dir
    }]);
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
  const memberDeps = scopeKey => [scopeDep(scopeKey)];
  const useScopeAccess = scopeKey => {
    (0, _react.useEffect)(() => {
      if (scopeKey != null) planes().scopeIndex.noteAccess(scopeKey);
    }, [scopeKey]);
  };
  function whereRead(where) {
    const defaultOrders = config.defaultOrder ? [config.defaultOrder] : [];
    return (0, _readBuilder.createReadBuilder)(where, {
      rows: (criteria, orders, limit, required, projection) => {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        (0, _projectionGate.validateProjectionOptions)(projection, `${config.id}.use.where`);
        const projectionRef = (0, _react.useRef)(projection);
        const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
        projectionRef.current = projection;
        const signature = (0, _incrementalReadEngine.incrementalSignature)('where-builder', config.id, (0, _compileDbWhere.buildScopeKey)({
          criteria,
          orders: effectiveOrders,
          limit,
          required
        }));
        return (0, _incrementalReadEngine.useIncrementalRead)({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => (0, _incrementalReadEngine.createModelReadEngine)({
            signature,
            model: config.id,
            where: row => criteria != null && matchesCriteria(row, criteria) && (0, _requireFields.hasRequiredFields)(row, required),
            options: {
              orderBy: effectiveOrders,
              limit
            },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => gateRef.current.projectRows(rows, projectionRef.current),
            isEqual: _useLiveRead.arraysShallowEqual
          })
        });
      },
      pluck: (criteria, orders, limit, required, projection, field) => {
        const effectiveOrders = orders.length > 0 ? orders : defaultOrders;
        const projectionRef = (0, _react.useRef)(projection);
        projectionRef.current = projection;
        const signature = (0, _incrementalReadEngine.incrementalSignature)('where-pluck', config.id, (0, _compileDbWhere.buildScopeKey)({
          criteria,
          orders: effectiveOrders,
          limit,
          required,
          field
        }));
        return (0, _incrementalReadEngine.useIncrementalRead)({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => (0, _incrementalReadEngine.createModelReadEngine)({
            signature,
            model: config.id,
            where: row => criteria != null && matchesCriteria(row, criteria) && (0, _requireFields.hasRequiredFields)(row, required),
            options: {
              orderBy: effectiveOrders,
              limit
            },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => {
              const selector = projectionRef.current.select;
              const projected = selector ? rows.map(row => selector(row)) : rows;
              return projected.map(row => Reflect.get(row, field));
            },
            isEqual: _useLiveRead.arraysShallowEqual
          })
        });
      },
      exists: (criteria, required) => {
        const signature = (0, _incrementalReadEngine.incrementalSignature)('where-exists', config.id, (0, _compileDbWhere.buildScopeKey)({
          criteria,
          required
        }));
        return (0, _incrementalReadEngine.useIncrementalRead)({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => (0, _incrementalReadEngine.createModelReadEngine)({
            signature,
            model: config.id,
            where: row => criteria != null && matchesCriteria(row, criteria) && (0, _requireFields.hasRequiredFields)(row, required),
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: (_rows, count) => count > 0,
            countOnly: true
          })
        });
      }
    });
  }
  const makeScopeHandle = scopeName => {
    const spec = (config.scopes ?? {})[scopeName];
    const planScope = (scopeKey, liveRows, coverage, opts) => {
      let {
        next
      } = planes().scopeIndex.reconcileNext(scopeKey, coverage, liveRows.map(({
        row,
        edge
      }) => ({
        id: String(row.id),
        edge
      })), opts);
      const maxRows = spec?.retention?.maxRows;
      if (maxRows != null && (opts?.resetOrder === true || coverage === 'complete') && next.entries.length > maxRows) {
        if (spec.sort && spec.sort !== 'server-order') {
          const scopeSort = spec.sort;
          const incomingById = new Map(liveRows.flatMap(({
            row
          }) => {
            try {
              const stored = normalize(row);
              return [[String(stored.id), stored]];
            } catch {
              return [];
            }
          }));
          const rowsById = new Map(next.entries.flatMap(entry => {
            const row = incomingById.get(entry.id) ?? planes().entityState.read(entry.id);
            return row ? [[entry.id, row]] : [];
          }));
          const ordered = 'comparator' in scopeSort ? [...rowsById.values()].sort(scopeSort.comparator) : (0, _incrementalReadEngine.sortModelReadRows)([...rowsById.values()], [{
            field: String(scopeSort.field),
            direction: scopeSort.dir
          }]);
          const positions = new Map(ordered.map((row, index) => [String(row.id), index]));
          next = {
            ...next,
            entries: [...next.entries].sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER))
          };
        }
        next = planes().scopeIndex.trimValue(next, maxRows).next;
      }
      return {
        kind: 'scope',
        model: config.id,
        scopeKey,
        next
      };
    };
    const planApply = (scopeValue, rows, coverage, opts) => {
      const liveRows = rows.filter(({
        row
      }) => isPlanRow(row)).filter(({
        row
      }) => !planes().entityState.isTombstoned(String(row.id)));
      const requestedScopeKey = keyForScope(scopeName, scopeValue);
      const upsert = {
        kind: 'upsert',
        model: config.id,
        rows: liveRows.map(({
          row
        }) => row)
      };
      if (!spec?.by) return [upsert, planScope(requestedScopeKey, liveRows, coverage, opts)];
      const rowsByScope = new Map();
      for (const entry of liveRows) {
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
    const readScopeRows = (scopeValue, options = {}) => {
      const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
      useScopeAccess(scopeKey);
      return (0, _liveScopeReads.useScopeLiveRows)(config.id, scopeKey, applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`), () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0, options);
    };
    const scopeHandle = {
      modelId: config.id,
      use: readScopeRows,
      useFirst: (scopeValue, options = {}) => readScopeRows(scopeValue ?? null, options)[0],
      useWindow: (scopeValue, options = {}) => {
        const pageSize = options?.pageSize ?? (0, _configure.getDbRuntimeConfig)().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        const windowStateRef = (0, _react.useRef)({
          scopeKey,
          size: pageSize
        });
        const [, setWindowRevision] = (0, _react.useState)(0);
        if (windowStateRef.current.scopeKey !== scopeKey) windowStateRef.current = {
          scopeKey,
          size: pageSize
        };
        const windowSize = windowStateRef.current.size;
        useScopeAccess(scopeKey);
        const window = (0, _liveScopeReads.useScopeLiveWindowRows)(config.id, scopeKey, applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`), windowSize, () => scopeKey == null || planes().scopeIndex.read(scopeKey).generation > 0, options);
        return {
          rows: window.rows,
          totalCount: window.totalCount,
          hasMore: window.totalCount > windowSize,
          isPreviousData: window.isPreviousData,
          resolved: window.resolved,
          fetchNextPage: () => {
            windowStateRef.current = windowStateRef.current.scopeKey === scopeKey ? {
              ...windowStateRef.current,
              size: windowStateRef.current.size + pageSize
            } : {
              scopeKey,
              size: pageSize + pageSize
            };
            setWindowRevision(current => current + 1);
          }
        };
      },
      useCount: scopeValue => {
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        useScopeAccess(scopeKey);
        return (0, _useLiveRead.useLiveRead)(() => scopeValue == null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length, scopeKey == null ? [] : [scopeDep(scopeKey)]);
      },
      invalidate: scopeValue => {
        (0, _invalidationRegistry.invalidateModel)(config.id, scopeValue);
      },
      read: scopeValue => {
        const scopeKey = keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        return scopeSortedRows(scopeName, scopeValue);
      },
      issueSequence: (scopeValue, field) => {
        if (scopeValue == null) throw new Error(`${config.name}.${scopeName}.issueSequence requires a scope value`);
        const scopeKey = keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        const maxFieldValue = scopeSortedRows(scopeName, scopeValue).reduce((maximum, row) => {
          const value = row[field];
          return typeof value === 'number' && value > maximum ? value : maximum;
        }, 0);
        const issuedKey = `${config.id}\0${scopeKey}\0${field}`;
        const maxIssuedThisSession = issuedScopeSequenceByKey.get(issuedKey) ?? 0;
        const next = Math.max(maxFieldValue, maxIssuedThisSession) + 1;
        issuedScopeSequenceByKey.set(issuedKey, next);
        return next;
      },
      seed: (scopeValue, rows) => {
        const liveRows = rows.filter(isPlanRow).filter(row => !planes().entityState.isTombstoned(String(row.id))).map(row => ({
          row: row
        }));
        applyEvent([{
          kind: 'upsert',
          model: config.id,
          rows: liveRows.map(entry => entry.row)
        }, planScope(keyForScope(scopeName, scopeValue), liveRows, 'complete', {
          resetOrder: true
        })]);
      }
    };
    (0, _internalHandles.registerInternalScopeHandle)(scopeHandle, {
      apply: (scopeValue, rows, coverage, options) => {
        applySnapshot(planApply(scopeValue, rows.map(row => ({
          row: row
        })), coverage, options));
      },
      planApply,
      key: scopeValue => keyForScope(scopeName, scopeValue),
      isServerOrder: () => !spec?.sort || spec.sort === 'server-order',
      planPlacement: (scopeValue, id, position) => {
        const scopeKey = keyForScope(scopeName, scopeValue);
        const entries = planes().scopeIndex.read(scopeKey).entries;
        const order = position === 'prepend' ? Math.min(0, ...entries.map(entry => entry.order)) - 1 : Math.max(-1, ...entries.map(entry => entry.order)) + 1;
        return [{
          kind: 'scope-delta',
          model: config.id,
          scopeKey,
          append: [{
            id,
            order
          }],
          detach: []
        }];
      },
      readRows: scopeValue => scopeSortedRows(scopeName, scopeValue),
      isResolved: scopeValue => planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).generation > 0,
      noteAccess: scopeValue => {
        planes().scopeIndex.noteAccess(keyForScope(scopeName, scopeValue));
      }
    });
    return scopeHandle;
  };
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)]));
  const planRows = (rows, options) => {
    const accepted = rows.filter(isPlanRow);
    const ops = [{
      kind: 'upsert',
      model: config.id,
      rows: accepted,
      ...(options?.origin ? {
        origin: options.origin
      } : {})
    }];
    if (!options?.includeMembership) return ops;
    for (const row of accepted) {
      let stored;
      try {
        stored = normalize(row);
      } catch {
        continue;
      }
      for (const delta of membershipForUpsert(stored)) {
        ops.push({
          kind: 'scope-delta',
          model: config.id,
          scopeKey: delta.scopeKey,
          append: (delta.append ?? []).map(id => ({
            id
          })),
          detach: delta.detach ?? []
        });
      }
    }
    return ops;
  };
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
    // Reconciliation and mutation commit share this replacement seam, so both clear retained failure state.
    (0, _defineMutation.clearFailedOptimisticMutation)(config.id, oldId);
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
    // The runtime branch adds `live` exactly when the overload's live config is present.
    query: (name, queryConfig) => {
      const {
        live,
        ...queryOptions
      } = queryConfig;
      const handle = (0, _defineQuery.defineQuery)({
        ...queryOptions,
        key: queryConfig.key ?? `${config.id}:${name}`,
        into: queryConfig.into ?? model
      });
      if (!live) return handle;
      const compiled = (0, _defineIngest.defineModelIngest)(model, live);
      let runtime = null;
      let readers = 0;
      const sync = () => {
        if (readers === 0) return;
        runtime ??= (0, _subscriptionRuntime.createDbSubscriptionRuntime)(compiled.entries);
        runtime.setActive(true);
      };
      model.registerReset(() => {
        runtime?.setActive(false);
        runtime = null;
        sync();
      });
      return {
        ...handle,
        use: (scope, options) => {
          const result = handle.use(scope, options);
          (0, _react.useEffect)(() => {
            readers += 1;
            sync();
            return () => {
              readers -= 1;
              if (readers === 0) runtime?.setActive(false);
            };
          }, []);
          return result;
        },
        live: {
          apply: compiled.apply
        }
      };
    },
    mutation: (name, mutationConfig) => {
      const dedupe = mutationConfig.dedupe === false ? false : mutationConfig.dedupe ?? {
        key: input => `${config.id}:${name}:${(0, _compileDbWhere.buildScopeKey)(input)}`
      };
      return (0, _defineMutation.defineMutation)({
        ...mutationConfig,
        dedupe
      });
    },
    crud: sections => {
      const handles = {};
      if (sections.list) {
        if (!sections.list.into) throw new Error(`${config.id}: crud list requires an explicit into scope`);
        handles.list = model.query('list', sections.list);
      }
      if (sections.get) handles.get = model.query('get', {
        ...sections.get,
        into: sections.get.into ?? model
      });
      if (sections.create) {
        const {
          respond,
          build,
          selectServerNode,
          prependTo,
          appendTo,
          optimistic,
          ...create
        } = sections.create;
        const hasOptimistic = Object.prototype.hasOwnProperty.call(sections.create, 'optimistic');
        if (!hasOptimistic && !respond && (!build || !selectServerNode)) throw new Error(`${config.id}: crud create requires respond or build with selectServerNode`);
        const createOptimistic = hasOptimistic ? optimistic === false ? undefined : optimistic : respond ? {
          model,
          respond,
          selectServerNode,
          prependTo,
          appendTo
        } : {
          model,
          build,
          selectServerNode,
          prependTo,
          appendTo
        };
        handles.create = model.mutation('create', {
          ...create,
          optimistic: createOptimistic
        });
      }
      if (sections.update) {
        const {
          optimistic,
          ...update
        } = sections.update;
        handles.update = model.mutation('update', {
          ...update,
          optimistic: optimistic === false ? undefined : optimistic ?? {
            method: 'patch',
            model,
            selectId: input => input.id,
            selectPatch: input => (0, _esToolkit.omit)(input, ['id'])
          }
        });
      }
      if (sections.destroy) {
        const {
          optimistic,
          ...destroy
        } = sections.destroy;
        handles.destroy = model.mutation('destroy', {
          ...destroy,
          optimistic: optimistic === false ? undefined : optimistic ?? {
            method: 'destroy',
            model,
            selectId: input => input.id
          }
        });
      }
      return handles;
    },
    fetch: (name, fetchConfig) => (0, _defineFetch.defineFetch)({
      ...fetchConfig,
      key: fetchConfig.key ?? `${config.id}:${name}`
    }),
    poller: (name, pollerConfig) => (0, _modelStatusPoller.createModelStatusPoller)({
      ...pollerConfig,
      fetch: async id => {
        try {
          return (await (0, _transport.getDbTransport)().query({
            query: pollerConfig.document,
            variables: pollerConfig.vars?.(id) ?? {
              id
            }
          })).data;
        } catch (error) {
          (0, _logger.getDbLogger)().error('Model.poller', 'fetch failed', {
            key: `${config.id}:${name}`,
            id,
            error
          });
          throw error;
        }
      }
    }),
    view: (name, viewConfig) => (0, _defineView.defineView)(model, name, viewConfig),
    ingest: entries => (0, _defineIngest.defineModelIngest)(model, entries),
    get: id => id == null ? undefined : planes().entityState.read(String(id)),
    getWhere: (where, options) => {
      const rows = planes().entityState.values().filter(row => matchesCriteria(row, where));
      const order = options?.orderBy ?? config.defaultOrder;
      if (!order) return (0, _incrementalReadEngine.limitRows)(rows, options?.limit);
      return (0, _incrementalReadEngine.sortModelReadRows)(rows, [{
        field: String(order.field),
        direction: order.direction
      }], options?.limit);
    },
    getAll: () => planes().entityState.values(),
    patch: (id, patch) => applyEvent([{
      kind: 'patch',
      model: config.id,
      id: String(id),
      patch: patch
    }]),
    destroy: id => applyEvent([{
      kind: 'destroy',
      model: config.id,
      ids: [String(id)]
    }]),
    destroyMany: ids => applyEvent([{
      kind: 'destroy',
      model: config.id,
      ids: ids.map(id => String(id))
    }]),
    patchWhere: (where, patch) => {
      const rows = planes().entityState.values().filter(row => matchesCriteria(row, where));
      if (rows.length === 0) return 0;
      applyEvent(rows.map(row => ({
        kind: 'patch',
        model: config.id,
        id: String(row.id),
        patch: patch
      })));
      return rows.length;
    },
    destroyWhere: where => {
      const ids = planes().entityState.values().filter(row => matchesCriteria(row, where)).map(row => String(row.id));
      if (ids.length === 0) return 0;
      applyEvent([{
        kind: 'destroy',
        model: config.id,
        ids
      }]);
      return ids.length;
    },
    insertStored: row => applyEvent([{
      kind: 'upsert',
      model: config.id,
      rows: [row]
    }]),
    insertStoredMany: rows => applyEvent([{
      kind: 'upsert',
      model: config.id,
      rows
    }]),
    seed: rows => applyEvent(planRows(rows)),
    replaceRaw: (oldId, next) => applyEvent(planReplace(String(oldId), next)),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      (0, _invalidationRegistry.invalidateModel)(config.id, scope);
    },
    use: {
      pending: id => {
        const key = id == null ? null : String(id);
        const readPending = (0, _react.useCallback)(() => key != null && (0, _configure.getOperationState)().pending().some(operation => operation.model === config.id && (operation.rowIds ?? operation.tempIds).includes(key)), [key]);
        const subscribePending = (0, _react.useCallback)(listener => {
          if (key == null) return () => {};
          const subscription = (0, _configure.getCommitBus)().subscribe(listener, [{
            kind: 'pending',
            model: config.id,
            id: key
          }]);
          return () => subscription.unsubscribe();
        }, [key]);
        return (0, _react.useSyncExternalStore)(subscribePending, readPending, readPending);
      },
      failed: id => {
        const key = id == null ? null : String(id);
        const readFailed = (0, _react.useCallback)(() => key != null && (0, _configure.getOperationState)().failedFor(config.id, key) !== undefined, [key]);
        const subscribeFailed = (0, _react.useCallback)(listener => {
          if (key == null) return () => {};
          const subscription = (0, _configure.getCommitBus)().subscribe(listener, [{
            kind: 'pending',
            model: config.id,
            id: key
          }]);
          return () => subscription.unsubscribe();
        }, [key]);
        return (0, _react.useSyncExternalStore)(subscribeFailed, readFailed, readFailed);
      },
      unsyncedChanges: id => {
        const key = id == null ? null : String(id);
        const cacheRef = (0, _react.useRef)(undefined);
        const readChanges = (0, _react.useCallback)(() => {
          if (key == null) return undefined;
          let merged;
          for (const operation of (0, _configure.getOperationState)().pending()) {
            if (operation.model !== config.id) continue;
            if (operation.intent !== 'patch') continue;
            if (!(operation.rowIds ?? operation.tempIds).includes(key)) continue;
            if (!operation.patchedValues) continue;
            merged = {
              ...(merged ?? {}),
              ...operation.patchedValues
            };
          }
          const next = merged;
          const previous = cacheRef.current;
          if (previous && next && (0, _useLiveRead.rowsShallowEqual)(previous, next)) return previous;
          cacheRef.current = next;
          return next;
        }, [key]);
        const subscribeChanges = (0, _react.useCallback)(listener => {
          if (key == null) return () => {};
          const subscription = (0, _configure.getCommitBus)().subscribe(listener, [{
            kind: 'pending',
            model: config.id,
            id: key
          }]);
          return () => subscription.unsubscribe();
        }, [key]);
        return (0, _react.useSyncExternalStore)(subscribeChanges, readChanges, readChanges);
      },
      row: (id, options = {}) => {
        const required = options?.require ?? [];
        const key = id == null ? undefined : String(id);
        return (0, _projectionGate.useProjectedLiveRow)(() => {
          const row = key == null ? undefined : planes().entityState.read(key);
          return (0, _requireFields.hasRequiredFields)(row, required) ? row : undefined;
        }, key == null ? [] : [rowDep(key, required.length > 0 ? required : undefined)], options, `${config.id}.use.row`);
      },
      field: (id, field) => {
        const key = id == null ? undefined : String(id);
        return (0, _useLiveRead.useLiveRead)(() => key == null ? undefined : planes().entityState.read(key)?.[field], key == null ? [] : [rowDep(key, [String(field)])]);
      },
      first: (where, options = {}) => {
        (0, _projectionGate.validateProjectionOptions)(options, `${config.id}.use.first`);
        const optionsRef = (0, _react.useRef)(options);
        const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
        optionsRef.current = options;
        const order = options.orderBy ?? config.defaultOrder;
        const signature = (0, _incrementalReadEngine.incrementalSignature)('first', config.id, where, order, options.limit, options.require);
        return (0, _incrementalReadEngine.useIncrementalRead)({
          signature,
          deps: [modelDep],
          create: () => (0, _incrementalReadEngine.createModelReadEngine)({
            signature,
            model: config.id,
            where: row => (where == null || matchesCriteria(row, where)) && (0, _requireFields.hasRequiredFields)(row, optionsRef.current.require ?? []),
            options: order ? {
              orderBy: [{
                field: String(order.field),
                direction: order.direction
              }],
              limit: options.limit
            } : {
              limit: options.limit
            },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => rows[0] ? gateRef.current.project(rows[0], optionsRef.current) : undefined,
            isEqual: Object.is
          })
        });
      },
      where: whereRead,
      byIds: (ids, options = {}) => {
        const resolvedIds = (ids ?? []).map(id => String(id));
        const rows = (0, _projectionGate.useProjectedLiveRows)(() => resolvedIds.map(id => planes().entityState.read(id)).filter(row => row !== undefined), resolvedIds.map(id => rowDep(id)), options, `${config.id}.use.byIds`);
        const resultRef = (0, _react.useRef)(null);
        if (resultRef.current?.rows !== rows) resultRef.current = {
          rows,
          byId: new Map(rows.map((row, index) => [resolvedIds[index], row]))
        };
        return resultRef.current;
      },
      count: where => (0, _incrementalReadEngine.useIncrementalRead)({
        signature: (0, _incrementalReadEngine.incrementalSignature)('count', config.id, where),
        deps: [modelDep],
        create: () => (0, _incrementalReadEngine.createModelReadEngine)({
          signature: (0, _incrementalReadEngine.incrementalSignature)('count', config.id, where),
          model: config.id,
          where: row => where == null || matchesCriteria(row, where),
          initial: () => planes().entityState.values(),
          read: id => planes().entityState.read(id),
          select: (_rows, count) => count,
          countOnly: true
        })
      }),
      related: (id, relationName, options = {}) => {
        const relation = resolvedRelations()[relationName];
        if (!relation) throw new Error(`${config.name} has no relation ${relationName}`);
        if (relation.kind === 'hasMany') {
          return (0, _projectionGate.useProjectedLiveRows)(() => id == null ? EMPTY_ROWS : relation.model.getWhere({
            [relation.foreignKey]: id
          }), id == null ? [] : [{
            kind: 'model',
            model: relation.model.modelId
          }], options, `${config.id}.use.related`);
        }
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
        return (0, _useLiveRead.useLiveRead)(compute, deps, isEqual);
      }
    },
    scopes: scopeHandles,
    registerReset: fn => {
      (0, _reset.registerReset)(fn);
    }
  };
  (0, _internalHandles.registerInternalModelHandle)(model, {
    readRow: id => planes().entityState.read(id),
    applyRows: rows => applySnapshot(planRows(rows)),
    planRows,
    planReplace,
    captureMembership,
    planRestore,
    relations: resolvedRelations,
    revision: () => revision
  });
  (0, _defineIngest.registerIngestModel)(config.name, model);
  if (config.maintenance) {
    (0, _maintenanceRegistry.registerModelMaintenance)(config.id, () => {
      const reports = [];
      for (const task of config.maintenance?.maxRowsPerScope ?? []) {
        reports.push({
          model: config.id,
          task: 'maxRowsPerScope',
          affected: (0, _runtimePrimitives.trimRowsPerScope)(model, task.scopeField, task.limit, task.compare, task.protect?.())
        });
      }
      return reports;
    });
  }
  (0, _reset.registerReset)(() => {
    revision += 1;
    planesRef?.entityState.reset();
    planesRef?.scopeIndex.reset();
    // The apply target stays registered: a model must keep working after the kill-switch.
  });
  for (const [scopeName, spec] of Object.entries(config.queryScopes ?? {})) {
    if (scopeName in model.use) throw new Error(`${config.name} queryScope '${scopeName}' collides with a built-in use key`);
    model.use[scopeName] = extra => {
      const criteria = extra ? {
        and: [spec.where, extra]
      } : spec.where;
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
  return Object.assign(model, statics);
};
exports.defineModel = defineModel;
//# sourceMappingURL=defineModel.js.map
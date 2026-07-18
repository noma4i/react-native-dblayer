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
var _incrementalReadEngine = require("../read/incrementalReadEngine.js");
var _configure = require("./configure.js");
var _defineFetch = require("./defineFetch.js");
var _defineMutation = require("./defineMutation.js");
var _defineQuery = require("./defineQuery.js");
var _defineView = require("./defineView.js");
var _react = require("react");
/**
 * Reactive access to one named scope of a model (`model.scopes.<name>`), backed by the scope's
 * membership index. `scopeValue` selects the concrete scope instance (e.g. `{ chatId }`); `null`/`undefined`
 * reads as empty without subscribing.
 */

const keyForScope = (scopeName, scopeValue) => `${scopeName}:${(0, _compileDbWhere.buildScopeKey)(scopeValue)}`;
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
  let planesRef = null;
  /** Planes are created and hydrated on first touch, so models can be defined before configureDb. */
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = (0, _configure.getDbRuntimeConfig)();
    const entityState = (0, _entityState.createEntityState)({
      modelId: config.id,
      clock: (0, _entityState.createEntityClock)(),
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: _configure.getStoragePrefix
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
      (0, _logger.getDbLogger)().error(`[${config.name}] plan row rejected`, {
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
    counter: (id, field, delta, next) => {
      const row = planes().entityState.read(id);
      if (!row) return false;
      planes().entityState.upsert({
        ...row,
        [field]: next ?? (row[field] ?? 0) + delta
      });
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
  const memberDeps = scopeKey => [scopeDep(scopeKey)];
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
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        return (0, _liveScopeReads.useScopeLiveRows)(config.id, scopeKey, applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`));
      },
      useWindow: (scopeValue, options) => {
        const pageSize = options?.pageSize ?? (0, _configure.getDbRuntimeConfig)().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        const [windowState, setWindowState] = (0, _react.useState)({
          scopeKey,
          size: pageSize
        });
        const windowSize = windowState.scopeKey === scopeKey ? windowState.size : pageSize;
        if (windowState.scopeKey !== scopeKey) setWindowState({
          scopeKey,
          size: pageSize
        });
        const window = (0, _liveScopeReads.useScopeLiveWindowRows)(config.id, scopeKey, applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`), windowSize);
        return {
          rows: window.rows,
          totalCount: window.totalCount,
          hasMore: window.totalCount > windowSize,
          fetchNextPage: () => setWindowState(current => current.scopeKey === scopeKey ? {
            ...current,
            size: current.size + pageSize
          } : {
            scopeKey,
            size: pageSize + pageSize
          })
        };
      },
      useCount: scopeValue => (0, _useLiveRead.useLiveRead)(() => scopeValue == null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length, scopeValue == null ? [] : [scopeDep(keyForScope(scopeName, scopeValue))]),
      invalidate: scopeValue => {
        (0, _invalidationRegistry.invalidateModel)(config.id, scopeValue);
      },
      read: scopeValue => scopeSortedRows(scopeName, scopeValue),
      __apply: (scopeValue, rows, coverage, opts) => {
        applySnapshot(planApply(scopeValue, rows.map(row => ({
          row
        })), coverage, opts));
      },
      __planApply: planApply,
      __key: scopeValue => keyForScope(scopeName, scopeValue)
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
    query: (name, queryConfig) => (0, _defineQuery.defineQuery)({
      ...queryConfig,
      key: queryConfig.key ?? `${config.id}:${name}`,
      into: queryConfig.into ?? model
    }),
    mutation: (name, mutationConfig) => {
      const dedupe = mutationConfig.dedupe === false ? undefined : mutationConfig.dedupe ?? {
        key: input => `${config.id}:${name}:${(0, _compileDbWhere.buildScopeKey)(input)}`
      };
      return (0, _defineMutation.defineMutation)({
        ...mutationConfig,
        dedupe
      });
    },
    fetch: (name, fetchConfig) => (0, _defineFetch.defineFetch)({
      ...fetchConfig,
      key: fetchConfig.key ?? `${config.id}:${name}`
    }),
    view: (name, viewConfig) => (0, _defineView.defineView)(model, name, viewConfig),
    get: id => id == null ? undefined : planes().entityState.read(id),
    getWhere: (where, options) => sortRows(planes().entityState.values().filter(row => (0, _compileDbWhere.matchesDbWhere)(row, where)), options),
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
    insertStoredMany: rows => applyEvent([{
      kind: 'upsert',
      model: config.id,
      rows
    }]),
    replaceRaw: (oldId, next) => applyEvent(planReplace(oldId, next)),
    buildStored: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      (0, _invalidationRegistry.invalidateModel)(config.id, scope);
    },
    use: {
      row: (id, options) => {
        const select = options?.select;
        return (0, _useLiveRead.useLiveRead)(() => id == null ? undefined : planes().entityState.read(id), id == null ? [] : [rowDep(id, select)]);
      },
      field: (id, field) => (0, _useLiveRead.useLiveRead)(() => id == null ? undefined : planes().entityState.read(id)?.[field], id == null ? [] : [rowDep(id, [String(field)])]),
      first: (where, options) => (0, _incrementalReadEngine.useIncrementalRead)({
        signature: (0, _incrementalReadEngine.incrementalSignature)('first', config.id, where, options),
        deps: [modelDep],
        create: () => (0, _incrementalReadEngine.createModelReadEngine)({
          signature: (0, _incrementalReadEngine.incrementalSignature)('first', config.id, where, options),
          model: config.id,
          where: row => where == null || (0, _compileDbWhere.matchesDbWhere)(row, where),
          options: options ? {
            orderBy: options.orderBy ? {
              field: String(options.orderBy.field),
              direction: options.orderBy.direction
            } : undefined,
            limit: options.limit
          } : undefined,
          initial: () => planes().entityState.values(),
          read: id => planes().entityState.read(id),
          select: rows => rows[0]
        })
      }),
      where: (where, options) => (0, _incrementalReadEngine.useIncrementalRead)({
        signature: (0, _incrementalReadEngine.incrementalSignature)('where', config.id, where, options),
        deps: where == null ? [] : [modelDep],
        create: () => (0, _incrementalReadEngine.createModelReadEngine)({
          signature: (0, _incrementalReadEngine.incrementalSignature)('where', config.id, where, options),
          model: config.id,
          where: row => where != null && (0, _compileDbWhere.matchesDbWhere)(row, where),
          options: options ? {
            orderBy: options.orderBy ? {
              field: String(options.orderBy.field),
              direction: options.orderBy.direction
            } : undefined,
            limit: options.limit
          } : undefined,
          initial: () => planes().entityState.values(),
          read: id => planes().entityState.read(id),
          select: rows => rows
        })
      }),
      byIds: ids => (0, _useLiveRead.useLiveRead)(() => ids.map(id => planes().entityState.read(id)).filter(Boolean), ids.map(id => rowDep(id)), _useLiveRead.arraysShallowEqual),
      count: where => (0, _incrementalReadEngine.useIncrementalRead)({
        signature: (0, _incrementalReadEngine.incrementalSignature)('count', config.id, where),
        deps: [modelDep],
        create: () => (0, _incrementalReadEngine.createModelReadEngine)({
          signature: (0, _incrementalReadEngine.incrementalSignature)('count', config.id, where),
          model: config.id,
          where: row => where == null || (0, _compileDbWhere.matchesDbWhere)(row, where),
          initial: () => planes().entityState.values(),
          read: id => planes().entityState.read(id),
          select: (_rows, count) => count,
          countOnly: true
        })
      }),
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
          isEqual = (a, b) => (0, _useLiveRead.arraysShallowEqual)(a, b);
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
    },
    __applyRows: rows => applySnapshot(planRows(rows)),
    __planRows: planRows,
    __planReplace: planReplace,
    __captureMembership: captureMembership,
    __planRestore: planRestore,
    __relations: resolvedRelations
  };
  (0, _reset.registerReset)(() => {
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
exports.defineModel = defineModel;
//# sourceMappingURL=defineModel.js.map
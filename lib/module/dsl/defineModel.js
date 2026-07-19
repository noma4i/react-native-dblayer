"use strict";

import { buildScopeKey, matchesDbWhere } from "../core/compileDbWhere.js";
import { registerApplyTarget } from "../core/apply/transaction.js";
import { useScopeLiveRows, useScopeLiveWindowRows } from "../core/tanstack/liveScopeReads.js";
import { seedCollections } from "../core/tanstack/mirror.js";
import { registerGcHost } from "../core/gc.js";
import { createEntityClock, createEntityState } from "../core/planes/entityState.js";
import { createScopeIndex } from "../core/planes/scopeIndex.js";
import { invalidateModel } from "../core/invalidationRegistry.js";
import { getDbLogger } from "../core/logger.js";
import { expandPlan, registerRelationHost } from "../core/relations.js";
import { registerReset } from "../core/reset.js";
import { fieldSpecSparseRead } from "../schema/fieldSpec.js";
import { useLiveRead, arraysShallowEqual } from "../read/useLiveRead.js";
import { createProjectionGate, useProjectedLiveRow, useProjectedLiveRows, validateProjectionOptions } from "../read/projectionGate.js";
import { createModelReadEngine, incrementalSignature, limitRows, sortModelReadRows, useIncrementalRead } from "../read/incrementalReadEngine.js";
import { getApplyRuntime, getDbRuntimeConfig, getStoragePrefix, hasReplayedJournal } from "./configure.js";
import { defineFetch } from "./defineFetch.js";
import { defineMutation } from "./defineMutation.js";
import { defineQuery } from "./defineQuery.js";
import { defineView } from "./defineView.js";
import { defineModelIngest, registerIngestModel } from "./defineIngest.js";
import { createReadBuilder } from "./readBuilder.js";
import { hasRequiredFields } from "../read/requireFields.js";
import { useEffect, useRef, useState } from 'react';
import { isRecord } from "../utils/normalizeHelpers.js";
import { getDbTransport } from "../core/transport.js";
import { createModelStatusPoller } from "../utils/modelStatusPoller.js";
import { trimRowsPerScope } from "../utils/runtimePrimitives.js";
import { registerModelMaintenance } from "./maintenanceRegistry.js";
import { omit } from 'es-toolkit';
import { createDbSubscriptionRuntime } from "../core/subscriptionRuntime.js";

/** Manual injection surface for a query's colocated live entries. */

/**
 * Reactive access to one named scope of a model (`model.scopes.<name>`), backed by the scope's
 * membership index. `scopeValue` selects the concrete scope instance (e.g. `{ chatId }`); `null`/`undefined`
 * reads as empty without subscribing.
 */

const keyForScope = (scopeName, scopeValue) => `${scopeName}:${buildScopeKey(scopeValue)}`;
const EMPTY_ROWS = [];
const readField = (field, input, key, complete) => {
  const value = complete ? field.read(input, key) : field[fieldSpecSparseRead](input, key);
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
export const defineModel = config => {
  let planesRef = null;
  let revision = 0;
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
    const id = config.rowId?.(input) ?? (isRecord(input) ? input.id : undefined);
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
      const current = planes().entityState.read(id);
      if (!current) return null;
      const result = planes().entityState.upsert({
        ...current,
        ...patch,
        id
      });
      if (result.changedFields !== null && result.changedFields.length === 0) return null;
      revision += 1;
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
      if (removed.length > 0) revision += 1;
      return removed;
    },
    counter: (id, field, delta, next) => {
      const row = planes().entityState.read(id);
      if (!row) return false;
      planes().entityState.upsert({
        ...row,
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
  registerApplyTarget(config.id, applyTarget);
  if (hasReplayedJournal()) seedCollections([config.id]);
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
    getApplyRuntime().apply(ops);
  };

  /** Imperative/domain writes are events: expand declared relation side effects into the same plan. */
  const applyEvent = ops => {
    getApplyRuntime().apply(expandPlan(ops.map(op => op.kind === 'upsert' && op.origin === undefined ? {
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
    return sortModelReadRows(rows, [{
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
    useEffect(() => {
      if (scopeKey != null) planes().scopeIndex.noteAccess(scopeKey);
    }, [scopeKey]);
  };
  function whereRead(where) {
    return createReadBuilder(where, {
      rows: (criteria, orders, limit, required, projection) => {
        validateProjectionOptions(projection, `${config.id}.use.where`);
        const projectionRef = useRef(projection);
        const gateRef = useRef(createProjectionGate());
        projectionRef.current = projection;
        const signature = incrementalSignature('where-builder', config.id, buildScopeKey({
          criteria,
          orders,
          limit,
          required
        }));
        return useIncrementalRead({
          signature,
          deps: criteria == null ? [] : [modelDep],
          create: () => createModelReadEngine({
            signature,
            model: config.id,
            where: row => criteria != null && matchesDbWhere(row, criteria) && hasRequiredFields(row, required),
            options: {
              orderBy: orders,
              limit
            },
            initial: () => planes().entityState.values(),
            read: id => planes().entityState.read(id),
            select: rows => gateRef.current.projectRows(rows, projectionRef.current),
            isEqual: arraysShallowEqual
          })
        });
      },
      read: (criteria, orders, limit, required, projection) => {
        const rows = planes().entityState.values().filter(row => criteria != null && matchesDbWhere(row, criteria) && hasRequiredFields(row, required));
        const selected = orders.length > 0 ? sortModelReadRows(rows, orders, limit) : limitRows(rows, limit);
        return projection.select ? selected.map(projection.select) : selected;
      }
    });
  }
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
      use: (scopeValue, options = {}) => {
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        useScopeAccess(scopeKey);
        return useScopeLiveRows(config.id, scopeKey, applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`), options);
      },
      useWindow: (scopeValue, options = {}) => {
        const pageSize = options?.pageSize ?? getDbRuntimeConfig().defaults?.pageSize ?? 20;
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        const [windowState, setWindowState] = useState({
          scopeKey,
          size: pageSize
        });
        const windowSize = windowState.scopeKey === scopeKey ? windowState.size : pageSize;
        if (windowState.scopeKey !== scopeKey) setWindowState({
          scopeKey,
          size: pageSize
        });
        useScopeAccess(scopeKey);
        const window = useScopeLiveWindowRows(config.id, scopeKey, applyTarget.scopeSortMeta(scopeKey ?? `${scopeName}:`), windowSize, options);
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
      useCount: scopeValue => {
        const scopeKey = scopeValue == null ? null : keyForScope(scopeName, scopeValue);
        useScopeAccess(scopeKey);
        return useLiveRead(() => scopeValue == null ? 0 : planes().scopeIndex.read(keyForScope(scopeName, scopeValue)).entries.length, scopeKey == null ? [] : [scopeDep(scopeKey)]);
      },
      invalidate: scopeValue => {
        invalidateModel(config.id, scopeValue);
      },
      read: scopeValue => {
        const scopeKey = keyForScope(scopeName, scopeValue);
        planes().scopeIndex.noteAccess(scopeKey);
        return scopeSortedRows(scopeName, scopeValue);
      },
      __apply: (scopeValue, rows, coverage, opts) => {
        applySnapshot(planApply(scopeValue, rows.map(row => ({
          row
        })), coverage, opts));
      },
      __planApply: planApply,
      __key: scopeValue => keyForScope(scopeName, scopeValue),
      __isServerOrder: () => !spec?.sort || spec.sort === 'server-order',
      __planPlacement: (scopeValue, id, position) => {
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
      __readRows: scopeValue => scopeSortedRows(scopeName, scopeValue),
      __noteAccess: scopeValue => {
        planes().scopeIndex.noteAccess(keyForScope(scopeName, scopeValue));
      }
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
    // The runtime branch adds `live` exactly when the overload's live config is present.
    query: (name, queryConfig) => {
      const {
        live,
        ...queryOptions
      } = queryConfig;
      const handle = defineQuery({
        ...queryOptions,
        key: queryConfig.key ?? `${config.id}:${name}`,
        into: queryConfig.into ?? model
      });
      if (!live) return handle;
      const compiled = defineModelIngest(model, live);
      let runtime = null;
      let readers = 0;
      const sync = () => {
        if (readers === 0) return;
        runtime ??= createDbSubscriptionRuntime(compiled.entries);
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
          useEffect(() => {
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
      const dedupe = mutationConfig.dedupe === false ? undefined : mutationConfig.dedupe ?? {
        key: input => `${config.id}:${name}:${buildScopeKey(input)}`
      };
      return defineMutation({
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
            selectPatch: input => omit(input, ['id'])
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
    fetch: (name, fetchConfig) => defineFetch({
      ...fetchConfig,
      key: fetchConfig.key ?? `${config.id}:${name}`
    }),
    poller: (name, pollerConfig) => createModelStatusPoller({
      ...pollerConfig,
      fetch: async id => {
        try {
          return (await getDbTransport().query({
            query: pollerConfig.document,
            variables: pollerConfig.vars?.(id) ?? {
              id
            }
          })).data;
        } catch (error) {
          getDbLogger().error('Model.poller', 'fetch failed', {
            key: `${config.id}:${name}`,
            id,
            error
          });
          throw error;
        }
      }
    }),
    view: (name, viewConfig) => defineView(model, name, viewConfig),
    ingest: entries => defineModelIngest(model, entries),
    get: id => id == null ? undefined : planes().entityState.read(id),
    getWhere: (where, options) => {
      const rows = planes().entityState.values().filter(row => matchesDbWhere(row, where));
      if (!options?.orderBy) return limitRows(rows, options?.limit);
      return sortModelReadRows(rows, [{
        field: String(options.orderBy.field),
        direction: options.orderBy.direction
      }], options.limit);
    },
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
      invalidateModel(config.id, scope);
    },
    use: {
      row: (id, options = {}) => {
        const required = options?.require ?? [];
        return useProjectedLiveRow(() => {
          const row = id == null ? undefined : planes().entityState.read(id);
          return hasRequiredFields(row, required) ? row : undefined;
        }, id == null ? [] : [rowDep(id, required.length > 0 ? required : undefined)], options, `${config.id}.use.row`);
      },
      field: (id, field) => useLiveRead(() => id == null ? undefined : planes().entityState.read(id)?.[field], id == null ? [] : [rowDep(id, [String(field)])]),
      first: (where, options = {}) => {
        validateProjectionOptions(options, `${config.id}.use.first`);
        const optionsRef = useRef(options);
        const gateRef = useRef(createProjectionGate());
        optionsRef.current = options;
        const signature = incrementalSignature('first', config.id, where, options.orderBy, options.limit, options.require);
        return useIncrementalRead({
          signature,
          deps: [modelDep],
          create: () => createModelReadEngine({
            signature,
            model: config.id,
            where: row => (where == null || matchesDbWhere(row, where)) && hasRequiredFields(row, optionsRef.current.require ?? []),
            options: options.orderBy ? {
              orderBy: [{
                field: String(options.orderBy.field),
                direction: options.orderBy.direction
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
        const resolvedIds = ids ?? [];
        const rows = useProjectedLiveRows(() => resolvedIds.map(id => planes().entityState.read(id)).filter(Boolean), resolvedIds.map(id => rowDep(id)), options, `${config.id}.use.byIds`);
        const resultRef = useRef(null);
        if (resultRef.current?.rows !== rows) resultRef.current = {
          rows,
          byId: new Map(rows.map((row, index) => [resolvedIds[index], row]))
        };
        return resultRef.current;
      },
      count: where => useIncrementalRead({
        signature: incrementalSignature('count', config.id, where),
        deps: [modelDep],
        create: () => createModelReadEngine({
          signature: incrementalSignature('count', config.id, where),
          model: config.id,
          where: row => where == null || matchesDbWhere(row, where),
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
          return useProjectedLiveRows(() => id == null ? EMPTY_ROWS : relation.model.getWhere({
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
    __planRestore: planRestore,
    __relations: resolvedRelations,
    __revision: () => revision
  };
  registerIngestModel(config.name, model);
  if (config.maintenance) {
    registerModelMaintenance(config.id, () => {
      const reports = [];
      for (const task of config.maintenance?.maxRowsPerScope ?? []) {
        reports.push({
          model: config.id,
          task: 'maxRowsPerScope',
          affected: trimRowsPerScope(model, task.scopeField, task.limit, task.compare, task.protect?.())
        });
      }
      return reports;
    });
  }
  registerReset(() => {
    revision += 1;
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
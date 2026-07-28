"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.syncStoreScopes = exports.storeScopeCollection = exports.runInApplyBatch = exports.resetStores = exports.registerModelStoreFactory = exports.markStoresReady = exports.hydrateStoreScopes = exports.createModelStore = void 0;
var _db = require("@tanstack/db");
var _serialize = require("./serialize.js");
var _diagnostics = require("./diagnostics.js");
class SyncFeed {
  methods = null;
  sync = methods => {
    this.methods = methods;
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };
  start() {
    this.requireMethods().begin();
  }
  pushMessage(message) {
    this.requireMethods().write(message);
  }
  finish() {
    this.requireMethods().commit();
  }
  truncate() {
    this.requireMethods().truncate();
  }
  markReady() {
    this.requireMethods().markReady();
  }
  requireMethods() {
    if (!this.methods) throw new Error('Store sync feed is not connected');
    return this.methods;
  }
}
const membershipKey = (scopeKey, entityId) => `${scopeKey}:${entityId}`;
const rankAlphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const fractionalOrderKey = (lower, upper) => {
  let prefix = '';
  for (let index = 0;; index += 1) {
    const lowerCharacter = lower?.[index] ?? rankAlphabet[0];
    const upperCharacter = upper?.[index] ?? rankAlphabet.at(-1);
    if (lowerCharacter === upperCharacter) {
      prefix += lowerCharacter;
      continue;
    }
    const lowerIndex = rankAlphabet.indexOf(lowerCharacter);
    const upperIndex = rankAlphabet.indexOf(upperCharacter);
    if (lowerIndex < 0 || upperIndex < 0 || lowerIndex > upperIndex) throw new Error('Invalid fractional order bounds');
    if (upperIndex - lowerIndex > 1) return `${prefix}${rankAlphabet[Math.floor((lowerIndex + upperIndex) / 2)]}`;
    return `${prefix}${lowerCharacter}${lower?.slice(index + 1) ?? ''}${rankAlphabet[Math.floor(rankAlphabet.length / 2)]}`;
  }
};

/**
 * Tombstone retention tuning. Three tiers, from gentlest to most aggressive:
 * - `TOMBSTONE_TTL_MS`: unconditional max lifetime - any tombstone older than this is pruned
 *   regardless of size, every prune() call.
 * - `TOMBSTONE_CAP` + `TOMBSTONE_MIN_AGE_MS`: normal size enforcement. Once the map exceeds the
 *   cap, prune oldest-first back down to the cap, but ONLY among tombstones already older than
 *   the min-age floor - this protects the delete-before-create race window (see `destroy`'s
 *   comment) from being cut short just because the map happens to be near capacity.
 * - Safety valve (`TOMBSTONE_CAP * 2`): a mass-destroy burst can push the map far past the cap
 *   in one tick, all at `now()` and therefore all younger than `TOMBSTONE_MIN_AGE_MS` - the
 *   normal tier above would then prune nothing and the map would stay oversized until the 24h
 *   TTL catches up. Once size exceeds twice the cap, prune oldest-first straight down to the cap
 *   IGNORING the min-age floor for the overflow: an extreme burst is a bigger memory/storage
 *   risk than the narrow race window the floor exists to protect.
 */
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_MIN_AGE_MS = 10 * 60 * 1000;
const TOMBSTONE_CAP = 10_000;
const TOMBSTONE_OVERFLOW_CAP = TOMBSTONE_CAP * 2;
const diffTopLevelFields = (previous, next) => {
  const fields = new Set();
  for (const key of Object.keys(next)) {
    if (!Object.is(previous[key], next[key])) fields.add(key);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) fields.add(key);
  }
  return [...fields];
};
const DELETED = Symbol('store-row-deleted');

/** Store factories are a definition registry (registered at defineModel time, replaced per generation); active stores die on reset. */
const storeFactories = new Map();
const activeStores = new Map();
let storeSequence = 0;
let storeScopeCollectionCount = 0;
let applyBatchDepth = 0;
const pendingBatchFlushes = new Set();
globalThis.__DBLAYER_STORE_SCOPE_COLLECTIONS__ = {
  count: () => storeScopeCollectionCount
};
const registerModelStoreFactory = (modelId, factory) => {
  storeFactories.set(modelId, factory);
};
exports.registerModelStoreFactory = registerModelStoreFactory;
const ensureModelStore = modelId => {
  const active = activeStores.get(modelId);
  if (active) return active;
  const factory = storeFactories.get(modelId);
  if (!factory) throw new Error(`No store registered for model ${modelId}`);
  return factory();
};

/**
 * Run one apply pass with batched collection flushes: every store write inside `run` lands in a
 * per-store transactional buffer (readable through the store immediately) and is committed to the
 * collections as one sync-feed transaction per store when the pass ends, so live queries observe
 * one consistent tick instead of per-row churn. Flushing in `finally` deliberately preserves the
 * partial-application semantics of a mid-batch failure.
 */
const runInApplyBatch = run => {
  applyBatchDepth += 1;
  try {
    return run();
  } finally {
    applyBatchDepth -= 1;
    if (applyBatchDepth === 0) {
      const flushes = [...pendingBatchFlushes];
      pendingBatchFlushes.clear();
      for (const flush of flushes) flush();
    }
  }
};
exports.runInApplyBatch = runInApplyBatch;
const createModelStore = options => {
  const {
    modelId,
    now,
    storage,
    prefix,
    ownedFields
  } = options;
  const applyWriteGate = options.applyWriteGate;
  const storeId = storeSequence += 1;
  const entityFeed = new SyncFeed();
  const membershipFeed = new SyncFeed();
  const entities = (0, _db.createCollection)({
    id: `dblayer-${modelId}-entities-${storeId}`,
    getKey: row => row.id,
    startSync: true,
    sync: {
      sync: entityFeed.sync
    }
  });
  const memberships = (0, _db.createCollection)({
    id: `dblayer-${modelId}-memberships-${storeId}`,
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: {
      sync: membershipFeed.sync
    }
  });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, {
    indexType: _db.BasicIndex
  });

  /** Enriched-to-clean row cache: collection reads return virtual-prop copies; our written row objects stay the canonical identities. */
  const cleanRows = new WeakMap();
  const buffer = new Map();
  let bufferQueued = false;
  const tombstones = new Map();
  const dirty = new Map();
  let tombstonesDirty = false;
  let ready = false;
  const rowKey = id => `${prefix()}row:${modelId}:${id}`;
  const rowsPrefix = () => `${prefix()}row:${modelId}:`;
  const tombstonesKey = () => `${prefix()}tombstones:${modelId}`;
  const cleanOf = enriched => {
    const cached = cleanRows.get(enriched);
    if (cached) return cached;
    const clean = Object.fromEntries(Object.entries(enriched).filter(([key]) => !key.startsWith('$')));
    cleanRows.set(enriched, clean);
    return clean;
  };
  const readCommitted = id => {
    const enriched = entities.get(id);
    return enriched === undefined ? undefined : cleanOf(enriched);
  };
  const flushBuffer = () => {
    bufferQueued = false;
    if (buffer.size === 0) return;
    const written = [];
    entityFeed.start();
    for (const [id, entry] of buffer) {
      if (entry === DELETED) {
        if (entities.has(id)) entityFeed.pushMessage({
          type: 'delete',
          key: id
        });
        continue;
      }
      entityFeed.pushMessage({
        type: entities.has(id) ? 'update' : 'insert',
        value: entry
      });
      written.push([id, entry]);
    }
    buffer.clear();
    entityFeed.finish();
    for (const [id, row] of written) {
      const enriched = entities.get(id);
      if (enriched) cleanRows.set(enriched, row);
    }
  };
  const bufferWrite = (id, entry) => {
    buffer.set(id, entry);
    if (applyBatchDepth > 0) {
      if (!bufferQueued) {
        bufferQueued = true;
        pendingBatchFlushes.add(flushBuffer);
      }
      return;
    }
    flushBuffer();
  };
  const prune = () => {
    const cutoff = now() - TOMBSTONE_TTL_MS;
    const minAge = now() - TOMBSTONE_MIN_AGE_MS;
    let pruned = 0;
    for (const [id, tombstone] of tombstones) {
      if (tombstone.at < cutoff) {
        tombstones.delete(id);
        pruned += 1;
      }
    }
    if (tombstones.size > TOMBSTONE_CAP) {
      const prunable = [...tombstones.entries()].filter(([, tombstone]) => tombstone.at < minAge).sort((a, b) => a[1].at - b[1].at);
      for (const [id] of prunable.slice(0, tombstones.size - TOMBSTONE_CAP)) {
        tombstones.delete(id);
        pruned += 1;
      }
    }
    if (tombstones.size > TOMBSTONE_OVERFLOW_CAP) {
      const overflow = [...tombstones.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of overflow.slice(0, tombstones.size - TOMBSTONE_CAP)) {
        tombstones.delete(id);
        pruned += 1;
      }
    }
    if (pruned > 0) {
      tombstonesDirty = true;
      (0, _diagnostics.noteDataLoss)('tombstone-expiry', modelId, pruned);
    }
    return pruned;
  };
  const read = id => {
    const key = String(id);
    const buffered = buffer.get(key);
    if (buffered !== undefined) return buffered === DELETED ? undefined : buffered;
    return readCommitted(key);
  };
  const scopeCollections = new Map();
  const buildScopeCollection = scopeKey => (0, _db.createLiveQueryCollection)({
    id: `dblayer-${modelId}-scope-${storeId}-${scopeKey}`,
    startSync: true,
    query: q => q.from({
      membership: memberships
    }).where(({
      membership
    }) => (0, _db.eq)(membership.scopeKey, scopeKey)).join({
      entity: entities
    }, ({
      membership,
      entity
    }) => (0, _db.eq)(membership.entityId, entity.id)).orderBy(({
      membership
    }) => membership.orderKey, {
      direction: 'asc',
      stringSort: 'lexical'
    }).select(({
      membership,
      entity
    }) => ({
      ...entity,
      orderKey: membership.orderKey
    })),
    getKey: row => row.$key
  });
  const getScopeCollection = scopeKey => {
    const existing = scopeCollections.get(scopeKey);
    if (existing) return existing;
    const entry = {
      collection: buildScopeCollection(scopeKey),
      consumers: 0
    };
    scopeCollections.set(scopeKey, entry);
    storeScopeCollectionCount += 1;
    return entry;
  };
  const releaseScopeCollection = (scopeKey, entry) => {
    entry.consumers -= 1;
    if (entry.consumers !== 0 || scopeCollections.get(scopeKey) !== entry) return;
    scopeCollections.delete(scopeKey);
    storeScopeCollectionCount -= 1;
    void entry.collection.cleanup();
  };
  const scopeMembers = scopeKey => [...membershipsByScope.equalityLookup(scopeKey)].flatMap(key => {
    if (typeof key !== 'string') return [];
    const row = memberships.get(key);
    return row ? [row] : [];
  });
  const writeMemberships = messages => {
    if (messages.length === 0) return;
    membershipFeed.start();
    for (const message of messages) membershipFeed.pushMessage(message);
    membershipFeed.finish();
  };
  const membershipUpsertsWithOrder = (appendIds, detachIds, scopeKey, scopeOrder) => {
    const pendingIds = new Set(appendIds);
    const ranks = new Map(scopeMembers(scopeKey).filter(row => !detachIds.has(row.entityId) && !pendingIds.has(row.entityId)).map(row => [row.entityId, row.orderKey]));
    const upserts = [];
    for (let index = 0; index < scopeOrder.length; index += 1) {
      const entityId = scopeOrder[index];
      if (!pendingIds.has(entityId)) continue;
      const lower = scopeOrder.slice(0, index).reverse().map(id => ranks.get(id)).find(Boolean);
      const upper = scopeOrder.slice(index + 1).map(id => ranks.get(id)).find(Boolean);
      const orderKey = fractionalOrderKey(lower, upper);
      ranks.set(entityId, orderKey);
      const value = {
        scopeKey,
        entityId,
        orderKey
      };
      upserts.push({
        type: memberships.has(membershipKey(scopeKey, entityId)) ? 'update' : 'insert',
        value
      });
    }
    return upserts;
  };
  const replaceScope = (scopeKey, entityIds) => {
    const nextIds = new Set(entityIds);
    const deletes = scopeMembers(scopeKey).filter(row => !nextIds.has(row.entityId)).map(row => ({
      type: 'delete',
      key: membershipKey(scopeKey, row.entityId)
    }));
    let previousOrderKey;
    const upserts = entityIds.map(entityId => {
      previousOrderKey = fractionalOrderKey(previousOrderKey, undefined);
      const value = {
        scopeKey,
        entityId,
        orderKey: previousOrderKey
      };
      return {
        type: memberships.has(membershipKey(scopeKey, entityId)) ? 'update' : 'insert',
        value
      };
    });
    writeMemberships([...deletes, ...upserts]);
  };
  const store = {
    read: id => read(id),
    values: () => {
      const rows = [];
      for (const enriched of entities.toArray) {
        const clean = cleanOf(enriched);
        const buffered = buffer.get(clean.id);
        if (buffered === DELETED) continue;
        rows.push(buffered === undefined ? clean : buffered);
      }
      if (buffer.size > 0) {
        for (const [id, entry] of buffer) {
          if (entry !== DELETED && !entities.has(id)) rows.push(entry);
        }
      }
      return rows;
    },
    upsert: (incoming, upsertOptions = {}) => {
      let row = incoming;
      const id = String(row.id);
      if (row.id !== id) row = {
        ...row,
        id
      };
      const previous = read(row.id);
      const mergePrevious = previous ?? upsertOptions.mergeBase;
      if (previous === row) return {
        changedFields: []
      };
      const ctx = upsertOptions.ctx ?? {
        origin: 'snapshot'
      };
      if (mergePrevious && ctx.origin !== 'replace' && ctx.operationId === undefined && ownedFields) {
        const owned = ownedFields(row.id, ctx.operationId);
        if (owned.size > 0) {
          let overlaid;
          for (const field of owned) {
            if (!(field in mergePrevious)) continue;
            overlaid ??= {
              ...row
            };
            overlaid[field] = mergePrevious[field];
          }
          row = overlaid ?? row;
        }
      }
      if (mergePrevious) row = applyWriteGate(mergePrevious, row, ctx);
      const changedFields = previous ? diffTopLevelFields(previous, row) : null;
      if (changedFields !== null && changedFields.length === 0) return {
        changedFields
      };
      if (previous && changedFields !== null && changedFields.every(field => (0, _serialize.stableSerialize)(previous[field]) === (0, _serialize.stableSerialize)(row[field]))) {
        (0, _diagnostics.noteEntityUpsertGuardHit)();
        return {
          changedFields: []
        };
      }
      bufferWrite(row.id, row);
      dirty.set(row.id, 'set');
      if (tombstones.delete(row.id)) {
        tombstonesDirty = true;
      }
      return {
        changedFields
      };
    },
    destroy: (id, destroyOptions = {}) => {
      id = String(id);
      bufferWrite(id, DELETED);
      if (destroyOptions.tombstone !== false) tombstones.set(id, {
        at: now()
      }); // Preserve delete-before-create protection through the tombstone and defineModel's isTombstoned gate within the TTL.
      dirty.set(id, 'delete');
      if (destroyOptions.tombstone !== false) tombstonesDirty = true;
    },
    evict: id => {
      id = String(id);
      if (read(id) === undefined) return false;
      bufferWrite(id, DELETED);
      dirty.set(id, 'delete');
      return true;
    },
    isTombstoned: id => tombstones.has(String(id)),
    pruneTombstones: prune,
    persistEntries: () => {
      prune();
      const entries = [];
      for (const [id, op] of dirty) {
        entries.push({
          key: rowKey(id),
          value: op === 'set' ? JSON.stringify(read(id)) : null
        });
      }
      if (tombstonesDirty) {
        entries.push({
          key: tombstonesKey(),
          value: tombstones.size > 0 ? JSON.stringify(Object.fromEntries(tombstones)) : null
        });
      }
      return entries;
    },
    ackPersist: () => {
      dirty.clear();
      tombstonesDirty = false;
    },
    hydrate: () => {
      buffer.clear();
      bufferQueued = false;
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      const loaded = [];
      for (const fullKey of storage.keys(rowsPrefix())) {
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          const row = JSON.parse(raw);
          if (typeof row.id !== 'string') row.id = String(row.id);
          loaded.push(row);
        } catch {
          storage.set([{
            key: fullKey,
            value: null
          }]);
          (0, _diagnostics.noteDataLoss)('corrupt-row', modelId, 1);
        }
      }
      entityFeed.start();
      entityFeed.truncate();
      for (const row of loaded) entityFeed.pushMessage({
        type: 'insert',
        value: row
      });
      entityFeed.finish();
      for (const row of loaded) {
        const enriched = entities.get(row.id);
        if (enriched) cleanRows.set(enriched, row);
      }
      const rawTombstones = storage.get(tombstonesKey());
      if (rawTombstones) {
        try {
          for (const [id, tombstone] of Object.entries(JSON.parse(rawTombstones))) tombstones.set(id, tombstone);
        } catch {
          storage.set([{
            key: tombstonesKey(),
            value: null
          }]);
          (0, _diagnostics.noteDataLoss)('corrupt-tombstones', modelId, 1);
        }
      }
    },
    reset: () => {
      buffer.clear();
      bufferQueued = false;
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      entityFeed.start();
      entityFeed.truncate();
      entityFeed.finish();
      membershipFeed.start();
      membershipFeed.truncate();
      membershipFeed.finish();
    },
    scopeCollection: scopeKey => ({
      toArray: () => ready ? [...getScopeCollection(scopeKey).collection.toArray] : [],
      subscribe: listener => {
        const entry = getScopeCollection(scopeKey);
        entry.consumers += 1;
        const subscription = entry.collection.subscribeChanges(changes => listener(changes), {
          includeInitialState: false
        });
        return () => {
          subscription.unsubscribe();
          releaseScopeCollection(scopeKey, entry);
        };
      }
    }),
    replaceScope,
    applyScopeChanges: (changes, rowChanges, source) => {
      for (const change of changes) {
        const orderChanged = rowChanges.some(row => source.scopeOrderAffected(change.scopeKey, row.id, row.fields));
        if (change.rebuild === true || orderChanged) {
          replaceScope(change.scopeKey, source.readScopeOrder(change.scopeKey));
          continue;
        }
        const appendIds = [...new Set([...(change.appendIds ?? []), ...(change.appendEntries ?? []).map(entry => entry.id)])];
        const detachIds = new Set(change.detachIds ?? []);
        const deletes = [...detachIds].map(entityId => ({
          type: 'delete',
          key: membershipKey(change.scopeKey, entityId)
        }));
        const upserts = appendIds.length > 0 ? membershipUpsertsWithOrder(appendIds, detachIds, change.scopeKey, source.readScopeOrder(change.scopeKey)) : [];
        writeMemberships([...deletes, ...upserts]);
      }
    },
    markReady: () => {
      entityFeed.markReady();
      membershipFeed.markReady();
      ready = true;
    },
    dispose: () => {
      for (const entry of scopeCollections.values()) void entry.collection.cleanup();
      storeScopeCollectionCount -= scopeCollections.size;
      scopeCollections.clear();
      if (activeStores.get(modelId) === store) activeStores.delete(modelId);
    }
  };
  activeStores.set(modelId, store);
  return store;
};

/** Project this commit batch's scope changes into the membership collections (rows are already in the entity collections). */
exports.createModelStore = createModelStore;
const syncStoreScopes = (batch, getSource, readyAfterApply = false) => {
  const models = new Set([...batch.rows.map(change => change.model), ...batch.scopes.map(change => change.model), ...(batch.scopeChanges ?? []).map(change => change.model)]);
  for (const model of models) {
    const source = getSource(model);
    const store = ensureModelStore(model);
    const detailedScopes = batch.scopeChanges ?? [];
    const scopeByKey = new Map();
    for (const scope of batch.scopes.filter(change => change.model === model)) {
      scopeByKey.set(scope.scopeKey, detailedScopes.find(detail => detail.model === model && detail.scopeKey === scope.scopeKey) ?? scope);
    }
    for (const scope of detailedScopes.filter(change => change.model === model)) scopeByKey.set(scope.scopeKey, scope);
    store.applyScopeChanges([...scopeByKey.values()], batch.rows.filter(row => row.model === model), source);
    if (readyAfterApply) store.markReady();
  }
};

/** Boot-time projection: rebuild every persisted scope's membership rows from the hydrated stores. */
exports.syncStoreScopes = syncStoreScopes;
const hydrateStoreScopes = sources => {
  for (const [model, source] of sources) {
    const store = ensureModelStore(model);
    for (const scopeKey of source.readAllScopeKeys()) store.replaceScope(scopeKey, source.readScopeOrder(scopeKey));
  }
};
exports.hydrateStoreScopes = hydrateStoreScopes;
const markStoresReady = () => {
  for (const store of activeStores.values()) store.markReady();
};
exports.markStoresReady = markStoresReady;
const resetStores = () => {
  for (const store of [...activeStores.values()]) store.dispose();
  activeStores.clear();
};
exports.resetStores = resetStores;
const storeScopeCollection = (model, scopeKey) => ensureModelStore(model).scopeCollection(scopeKey);
exports.storeScopeCollection = storeScopeCollection;
//# sourceMappingURL=store.js.map
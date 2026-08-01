"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.markStoresReady = exports.hydrateStoreScopes = exports.createModelStore = void 0;
Object.defineProperty(exports, "poisonStoreReads", {
  enumerable: true,
  get: function () {
    return _storeSync.poisonStoreReads;
  }
});
exports.resetStores = exports.registerModelStoreFactory = exports.publishProjectedBatch = void 0;
Object.defineProperty(exports, "restoreStoreReads", {
  enumerable: true,
  get: function () {
    return _storeSync.restoreStoreReads;
  }
});
Object.defineProperty(exports, "runInApplyBatch", {
  enumerable: true,
  get: function () {
    return _storeSync.runInApplyBatch;
  }
});
Object.defineProperty(exports, "runInStoreTransaction", {
  enumerable: true,
  get: function () {
    return _storeSync.runInStoreTransaction;
  }
});
exports.storeScopeCollection = exports.storeModelQuery = void 0;
var _storeEntities = require("./storeEntities.js");
var _residency = require("./residency.js");
var _storeSync = require("./storeSync.js");
var _storeScopeCollections = require("./storeScopeCollections.js");
var _storeModelQueries = require("./storeModelQueries.js");
/** Store factories are a definition registry (registered at defineModel time, replaced per generation); active stores die on reset. */
const storeFactories = new Map();
const activeStores = new Map();
(0, _residency.registerResidency)('modelStores', () => activeStores.size);
let storeSequence = 0;
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
 * Per-model primary store facade: composes the entity plane (rows, transactional buffer,
 * tombstones, persistence) with the scope plane (membership collection, live scope collections)
 * into the `ModelStore` contract. Both planes are private to this composition.
 */
const createModelStore = options => {
  const {
    modelId,
    now,
    storage,
    prefix,
    ownedFields
  } = options;
  const storeId = storeSequence += 1;
  let ready = false;
  const entityPlane = (0, _storeEntities.createEntityPlane)({
    modelId,
    storeId,
    now,
    storage,
    prefix,
    applyWriteGate: options.applyWriteGate,
    ownedFields
  });
  const modelQueryPlane = (0, _storeModelQueries.createModelQueryPlane)({
    modelId,
    storeId,
    entities: entityPlane.entities
  });
  const scopePlane = (0, _storeScopeCollections.createScopePlane)({
    modelId,
    storeId,
    entities: entityPlane.entities,
    readCommitted: entityPlane.readCommitted,
    isReady: () => ready
  });
  const store = {
    read: id => entityPlane.read(id),
    values: () => entityPlane.values(),
    previewUpsert: (incoming, upsertOptions) => entityPlane.previewUpsert(incoming, upsertOptions),
    put: incoming => entityPlane.put(incoming),
    upsert: (incoming, upsertOptions) => entityPlane.upsert(incoming, upsertOptions),
    destroy: (id, destroyOptions) => entityPlane.destroy(id, destroyOptions),
    evict: id => entityPlane.evict(id),
    isTombstoned: id => entityPlane.isTombstoned(id),
    pruneTombstones: () => entityPlane.pruneTombstones(),
    persistEntries: () => entityPlane.persistEntries(),
    ackPersist: () => entityPlane.ackPersist(),
    hydrate: () => entityPlane.hydrate(),
    reset: () => {
      entityPlane.reset();
      scopePlane.reset();
    },
    scopeCollection: scopeKey => scopePlane.scopeCollection(scopeKey),
    modelQuery: (key, spec) => modelQueryPlane.query(key, spec),
    applyScopeChanges: changes => scopePlane.applyScopeChanges(changes),
    markReady: () => {
      entityPlane.markReady();
      scopePlane.markReady();
      ready = true;
    },
    dispose: () => {
      entityPlane.dispose();
      modelQueryPlane.dispose();
      scopePlane.dispose();
      if (activeStores.get(modelId) === store) activeStores.delete(modelId);
    }
  };
  activeStores.set(modelId, store);
  return store;
};

/**
 * THE publish seam: project this batch's scope changes into the membership collections, then
 * publish on the commit bus. Every scope-carrying batch - commit, replay, and GC - goes through
 * here, so a scope-plane mutation can never bypass the store projection.
 */
exports.createModelStore = createModelStore;
const publishProjectedBatch = (bus, build, options) => (0, _storeSync.runInStoreTransaction)(() => {
  const batch = build();
  const models = new Set([...batch.rows.map(change => change.model), ...batch.scopes.map(change => change.model), ...(batch.scopeChanges ?? []).map(change => change.model)]);
  for (const model of models) {
    const store = ensureModelStore(model);
    store.applyScopeChanges((batch.scopeChanges ?? []).filter(change => change.model === model));
    if (options?.readyAfterApply) store.markReady();
  }
  (0, _storeSync.afterStoreTransaction)(() => bus.publish(batch));
  return batch;
});

/** Boot-time projection: rebuild every persisted scope's membership rows straight from persisted entries. */
exports.publishProjectedBatch = publishProjectedBatch;
const hydrateStoreScopes = sources => {
  for (const [model, source] of sources) {
    const store = ensureModelStore(model);
    store.applyScopeChanges(source.readAllScopeKeys().map(scopeKey => ({
      scopeKey,
      entries: source.readScopeEntries(scopeKey)
    })));
  }
};
exports.hydrateStoreScopes = hydrateStoreScopes;
const markStoresReady = () => {
  for (const store of activeStores.values()) store.markReady();
};
exports.markStoresReady = markStoresReady;
const resetStores = () => {
  (0, _storeSync.restoreStoreReads)();
  for (const store of [...activeStores.values()]) store.dispose();
  activeStores.clear();
};
exports.resetStores = resetStores;
const storeScopeCollection = (model, scopeKey) => ensureModelStore(model).scopeCollection(scopeKey);

/** Hold one declared model read as a live query of the engine; the caller releases it when its reader leaves. */
exports.storeScopeCollection = storeScopeCollection;
const storeModelQuery = (model, key, spec) => ensureModelStore(model).modelQuery(key, spec);
exports.storeModelQuery = storeModelQuery;
//# sourceMappingURL=store.js.map
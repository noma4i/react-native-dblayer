"use strict";

import { createEntityPlane } from "./storeEntities.js";
import { registerResidency } from "./residency.js";
import { afterStoreTransaction, restoreStoreReads, runInStoreTransaction } from "./storeSync.js";
import { createScopePlane } from "./storeScopeCollections.js";
import { createModelQueryPlane } from "./storeModelQueries.js";
export { runInApplyBatch, poisonStoreReads, restoreStoreReads } from "./storeSync.js";

/** Store factories are a definition registry (registered at defineModel time, replaced per generation); active stores die on reset. */
const storeFactories = new Map();
const activeStores = new Map();
registerResidency('modelStores', () => activeStores.size);
let storeSequence = 0;
export const registerModelStoreFactory = (modelId, factory) => {
  storeFactories.set(modelId, factory);
};
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
export const createModelStore = options => {
  const {
    modelId,
    now,
    storage,
    prefix,
    ownedFields
  } = options;
  const storeId = storeSequence += 1;
  let ready = false;
  const entityPlane = createEntityPlane({
    modelId,
    storeId,
    now,
    storage,
    prefix,
    applyWriteGate: options.applyWriteGate,
    ownedFields
  });
  const modelQueryPlane = createModelQueryPlane({
    modelId,
    storeId,
    entities: entityPlane.entities
  });
  const scopePlane = createScopePlane({
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
 * publish on the commit bus. Every scope-carrying batch - commit, replay, and maintenance - goes through
 * here, so a scope-plane mutation can never bypass the store projection.
 */
export const publishProjectedBatch = (bus, build, options) => runInStoreTransaction(() => {
  const batch = build();
  const models = new Set([...batch.rows.map(change => change.model), ...batch.scopes.map(change => change.model), ...(batch.scopeChanges ?? []).map(change => change.model)]);
  for (const model of models) {
    const store = ensureModelStore(model);
    store.applyScopeChanges((batch.scopeChanges ?? []).filter(change => change.model === model));
    if (options?.readyAfterApply) store.markReady();
  }
  afterStoreTransaction(() => bus.publish(batch));
  return batch;
});

/** Boot-time projection: rebuild every persisted scope's membership rows straight from persisted entries. */
export const hydrateStoreScopes = sources => {
  for (const [model, source] of sources) {
    const store = ensureModelStore(model);
    store.applyScopeChanges(source.readAllScopeKeys().map(scopeKey => ({
      scopeKey,
      steps: [{
        entries: source.readScopeEntries(scopeKey)
      }]
    })));
  }
};
export const markStoresReady = () => {
  for (const store of activeStores.values()) store.markReady();
};
export const resetStores = () => {
  restoreStoreReads();
  for (const store of [...activeStores.values()]) store.dispose();
  activeStores.clear();
};
export const storeScopeCollection = (model, scopeKey) => ensureModelStore(model).scopeCollection(scopeKey);

/** Hold one declared model read as a live query of the engine; the caller releases it when its reader leaves. */
export const storeModelQuery = (model, key, spec) => ensureModelStore(model).modelQuery(key, spec);
//# sourceMappingURL=store.js.map
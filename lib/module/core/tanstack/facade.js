"use strict";

import { BasicIndex, createCollection, createLiveQueryCollection, createTransaction, eq } from '@tanstack/db';

/** Creates a TanStack live query collection for internal data-layer projections. */
export { createLiveQueryCollection };

/** Builds an equality predicate for internal TanStack live query joins and filters. */
export { eq };

/** A stored row accepted by the TanStack collection facade. */

/** One ordered scope membership row stored in a TanStack collection. */

/** The synchronous writer callbacks supplied by a TanStack collection sync adapter. */

const writerRegistry = new Map();
const collectionRegistry = new Map();
let resetLiveScopeReads = null;

/** Registers the shared scope-live-read registry cleanup used by collection reset. */
export function registerLiveScopeReadReset(reset) {
  resetLiveScopeReads = reset;
}

/** Creates an empty, ready TanStack collection for a model identifier. */
export function createModelCollection(modelId) {
  const collection = createCollection({
    id: modelId,
    getKey: row => row.id,
    defaultIndexType: BasicIndex,
    startSync: true,
    sync: {
      sync: ({
        begin,
        write,
        commit,
        markReady
      }) => {
        writerRegistry.set(modelId, {
          begin,
          write,
          commit,
          markReady
        });
        begin();
        commit();
        markReady();
      }
    }
  });
  collection.createIndex(row => row.id);
  collectionRegistry.set(modelId, collection);
  return collection;
}

/** Returns a model collection, creating its ready writer-backed instance when absent. */
export function ensureModelCollection(modelId) {
  return collectionRegistry.get(modelId) ?? createModelCollection(modelId);
}

/** Returns a model membership collection, creating its ready writer-backed instance when absent. */
export function ensureMembershipCollection(modelId) {
  const id = `${modelId}::membership`;
  const existing = collectionRegistry.get(id);
  if (existing) return existing;
  const collection = createCollection({
    id,
    getKey: row => row.key,
    startSync: true,
    sync: {
      sync: ({
        begin,
        write,
        commit,
        markReady
      }) => {
        writerRegistry.set(id, {
          begin,
          write,
          commit,
          markReady
        });
        begin();
        commit();
        markReady();
      }
    }
  });
  collectionRegistry.set(id, collection);
  return collection;
}

/** Returns the registered synchronous writer for a model identifier. */
export function writerFor(modelId) {
  const writer = writerRegistry.get(modelId);
  if (!writer) {
    throw new Error(`Missing writer for ${modelId}`);
  }
  return writer;
}

/** Returns the registered synchronous membership writer for a model identifier. */
export function membershipWriterFor(modelId) {
  return writerFor(`${modelId}::membership`);
}

/** Reports whether a synchronous writer is registered for a model identifier. */
export function hasWriter(modelId) {
  return writerRegistry.has(modelId);
}

/** Clears the TanStack collection and writer registries. */
export function resetCollectionRegistry() {
  writerRegistry.clear();
  collectionRegistry.clear();
  resetLiveScopeReads?.();
}

/** Runs synchronous writes in one TanStack cross-collection transaction context. */
export function runInWriteBatch(fn) {
  let result;
  const transaction = createTransaction({
    mutationFn: async () => undefined
  });
  transaction.mutate(() => {
    result = fn();
  });
  return result;
}

/** Returns the registered TanStack collection for a model identifier. */
export function collectionFor(modelId) {
  const collection = collectionRegistry.get(modelId);
  if (!collection) {
    throw new Error(`Missing collection for ${modelId}`);
  }
  return collection;
}

/** Returns the registered membership collection for a model identifier. */
export function membershipCollectionFor(modelId) {
  const collection = collectionRegistry.get(`${modelId}::membership`);
  if (!collection) throw new Error(`Missing membership collection for ${modelId}`);
  return collection;
}
//# sourceMappingURL=facade.js.map
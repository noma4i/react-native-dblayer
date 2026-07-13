"use strict";

import { createCollection, createTransaction } from '@tanstack/db';
import { createCollectionModel } from "./createCollectionModel.js";
import { getDbLogger } from "./logger.js";
import { mmkvCollectionOptions } from "./mmkvCollectionOptions.js";
import { clearAllCollections, registerPersistentCollectionMutationAcceptor } from "./registry.js";
const isDevBuild = () => typeof __DEV__ !== 'undefined' && __DEV__;
const reportWriteFailure = (operation, collectionId, key, error) => {
  getDbLogger().error('[persistentCollection]', `${operation} failed`, {
    id: collectionId,
    key,
    error
  });

  // A swallowed write failure is how a schema field silently stops reaching stored rows.
  // Fail loudly while developing; keep production resilient.
  if (isDevBuild()) throw error;
};

/**
 * Create a persistent TanStack DB collection backed by the configured storage adapter.
 * @param config Collection id used as the storage key prefix.
 * @returns Persistent collection adapter used by models.
 */
export const createPersistentCollection = config => {
  const collection = createCollection(mmkvCollectionOptions({
    id: config.id,
    getKey: item => item.id
  }));
  collection.startSyncImmediate();
  const acceptMutations = transaction => {
    collection.utils.acceptMutations(transaction);
  };
  registerPersistentCollectionMutationAcceptor(config.id, acceptMutations);
  clearAllCollections.register(() => {
    const ids = [...collection.state.keys()];
    if (ids.length === 0) return;
    const tx = createTransaction({
      mutationFn: ({
        transaction
      }) => {
        acceptMutations(transaction);
        return Promise.resolve();
      }
    });
    tx.mutate(() => {
      for (const id of ids) {
        collection.delete(id);
      }
    });
  });
  const tryUpdate = (id, updater) => {
    try {
      collection.update(id, draft => {
        updater(draft);
      });
      return true;
    } catch (error) {
      reportWriteFailure('update', config.id, id, error);
      return false;
    }
  };
  const tryDelete = id => {
    try {
      collection.delete(id);
      return true;
    } catch (error) {
      reportWriteFailure('delete', config.id, id, error);
      return false;
    }
  };
  return {
    id: config.id,
    get: id => collection.state.get(id),
    has: id => collection.state.has(id),
    insert: item => {
      if (collection.state.has(item.id) && tryUpdate(item.id, draft => {
        Object.assign(draft, item);
      })) {
        return;
      }
      collection.insert(item);
    },
    update: (id, updater) => {
      tryUpdate(id, updater);
    },
    delete: id => {
      tryDelete(id);
    },
    keys: () => collection.state.keys(),
    values: () => collection.state.values(),
    acceptMutations,
    get size() {
      return collection.state.size;
    },
    get _collection() {
      return collection;
    }
  };
};

/**
 * Define a persistent, reactive model with a normalizer.
 * @param config Model id, name, normalizer, freshness, merge, replace, and sort options.
 * @returns Collection model for snapshot reads, reactive hooks, and writes.
 *
 * @example
 * const UserModel = defineModel<UserInput, User>({
 *   id: 'users',
 *   name: 'UserModel',
 *   normalize: user => ({ id: user.id, name: user.name, updatedAt: user.updatedAt })
 * });
 */

export function defineModel(config) {
  const {
    id,
    ...modelConfig
  } = config;
  return createCollectionModel({
    ...modelConfig,
    collection: createPersistentCollection({
      id
    })
  });
}
//# sourceMappingURL=createPersistentCollection.js.map
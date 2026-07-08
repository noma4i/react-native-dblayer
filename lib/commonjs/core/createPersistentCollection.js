"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createPersistentCollection = void 0;
exports.defineModel = defineModel;
var _db = require("@tanstack/db");
var _createCollectionModel = require("./createCollectionModel.js");
var _mmkvCollectionOptions = require("./mmkvCollectionOptions.js");
var _registry = require("./registry.js");
/**
 * Create a persistent TanStack DB collection backed by the configured storage adapter.
 * @param config Collection id used as the storage key prefix.
 * @returns Persistent collection adapter used by models.
 */
const createPersistentCollection = config => {
  const collection = (0, _db.createCollection)((0, _mmkvCollectionOptions.mmkvCollectionOptions)({
    id: config.id,
    getKey: item => item.id
  }));
  collection.startSyncImmediate();
  const acceptMutations = transaction => {
    collection.utils.acceptMutations(transaction);
  };
  (0, _registry.registerPersistentCollectionMutationAcceptor)(config.id, acceptMutations);
  _registry.clearAllCollections.register(() => {
    const ids = [...collection.state.keys()];
    if (ids.length === 0) return;
    const tx = (0, _db.createTransaction)({
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
    } catch {
      return false;
    }
  };
  const tryDelete = id => {
    try {
      collection.delete(id);
      return true;
    } catch {
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
exports.createPersistentCollection = createPersistentCollection;
function defineModel(config) {
  const {
    id,
    ...modelConfig
  } = config;
  return (0, _createCollectionModel.createCollectionModel)({
    ...modelConfig,
    collection: createPersistentCollection({
      id
    })
  });
}
//# sourceMappingURL=createPersistentCollection.js.map
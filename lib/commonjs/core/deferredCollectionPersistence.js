"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.deferredCollectionPersistence = void 0;
// Adapted from @tanstack/db local-storage.ts (MIT); deferred persistence is maintained here.

const FLUSH_DEBOUNCE_MS = 300;
const encodeStorageKey = key => typeof key === 'number' ? `n:${key}` : `s:${key}`;
const decodeStorageKey = key => {
  if (key.startsWith('n:')) return Number(key.slice(2));
  if (key.startsWith('s:')) return key.slice(2);
  return key;
};
const generateUuid = () => {
  const random = globalThis.crypto?.randomUUID;
  return random ? random.call(globalThis.crypto) : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};
const validateJsonSerializable = (parser, value, operation) => {
  try {
    parser.stringify(value);
  } catch (error) {
    throw new Error(`Cannot serialize ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const loadFromStorage = (storageKey, storage, parser) => {
  try {
    const rawData = storage.getItem(storageKey);
    if (!rawData) return new Map();
    const parsed = parser.parse(rawData);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid storage object for ${storageKey}`);
    const dataMap = new Map();
    for (const [encodedKey, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || !('versionKey' in value) || !('data' in value)) {
        throw new Error(`Invalid storage data for ${storageKey}:${encodedKey}`);
      }
      dataMap.set(decodeStorageKey(encodedKey), value);
    }
    return dataMap;
  } catch (error) {
    console.warn(`[DeferredCollectionPersistence] Error loading storage key "${storageKey}":`, error);
    return new Map();
  }
};
const createStorageSync = (storageKey, storage, storageEventApi, parser, lastKnownData) => {
  let syncParams = null;
  let collection = null;
  const processStorageChanges = () => {
    if (!syncParams) return;
    const newData = loadFromStorage(storageKey, storage, parser);
    const changes = [];
    for (const [key, oldStoredItem] of lastKnownData) {
      const newStoredItem = newData.get(key);
      if (!newStoredItem) changes.push({
        type: 'delete',
        value: oldStoredItem.data
      });else if (oldStoredItem.versionKey !== newStoredItem.versionKey) changes.push({
        type: 'update',
        value: newStoredItem.data
      });
    }
    for (const [key, newStoredItem] of newData) {
      if (!lastKnownData.has(key)) changes.push({
        type: 'insert',
        value: newStoredItem.data
      });
    }
    if (!changes.length) return;
    const {
      begin,
      write,
      commit
    } = syncParams;
    begin();
    for (const {
      type,
      value
    } of changes) {
      if (value) {
        validateJsonSerializable(parser, value, type);
        write({
          type,
          value
        });
      }
    }
    commit();
    lastKnownData.clear();
    for (const [key, storedItem] of newData) lastKnownData.set(key, storedItem);
  };
  const sync = {
    sync: params => {
      const {
        begin,
        write,
        commit,
        markReady
      } = params;
      syncParams = params;
      collection = params.collection;
      const initialData = loadFromStorage(storageKey, storage, parser);
      if (initialData.size) {
        begin();
        for (const storedItem of initialData.values()) {
          validateJsonSerializable(parser, storedItem.data, 'load');
          write({
            type: 'insert',
            value: storedItem.data
          });
        }
        commit();
      }
      lastKnownData.clear();
      for (const [key, storedItem] of initialData) lastKnownData.set(key, storedItem);
      markReady();
      storageEventApi.addEventListener('storage', event => {
        if (event.key === storageKey && event.storageArea === storage) processStorageChanges();
      });
    },
    getSyncMetadata: () => ({
      storageKey,
      storageType: 'custom'
    }),
    collection
  };
  const confirmOperationsSync = mutations => {
    if (!syncParams) return;
    const {
      begin,
      write,
      commit
    } = syncParams;
    begin();
    for (const mutation of mutations) {
      write({
        type: mutation.type,
        value: mutation.type === 'delete' ? mutation.original : mutation.modified
      });
    }
    commit();
  };
  Object.defineProperty(sync, 'collection', {
    get: () => collection
  });
  return Object.assign(sync, {
    confirmOperationsSync
  });
};

/** Build collection options that defer only whole-collection storage serialization. */
const deferredCollectionPersistence = config => {
  if (!config.storageKey) throw new Error('storageKey is required');
  const parser = config.parser ?? JSON;
  const lastKnownData = new Map();
  const sync = createStorageSync(config.storageKey, config.storage, config.storageEventApi, parser, lastKnownData);
  let flushTimer = null;
  let dirty = false;
  const saveToStorage = () => {
    try {
      const objectData = {};
      for (const [key, storedItem] of lastKnownData) objectData[encodeStorageKey(key)] = storedItem;
      config.storage.setItem(config.storageKey, parser.stringify(objectData));
    } catch (error) {
      console.error(`[DeferredCollectionPersistence] Error saving storage key "${config.storageKey}":`, error);
      throw error;
    }
  };
  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    saveToStorage();
  };
  const markDirty = () => {
    dirty = true;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
  };
  require('react-native').AppState.addEventListener('change', state => {
    if (state === 'background' || state === 'inactive') flush();
  });
  const persistMutations = mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'delete') {
        lastKnownData.delete(mutation.key);
      } else {
        lastKnownData.set(mutation.key, {
          versionKey: generateUuid(),
          data: mutation.modified
        });
      }
    }
    markDirty();
    sync.confirmOperationsSync(mutations);
  };
  const wrappedOnInsert = async params => {
    for (const mutation of params.transaction.mutations) validateJsonSerializable(parser, mutation.modified, 'insert');
    const result = config.onInsert ? (await config.onInsert(params)) ?? {} : {};
    persistMutations(params.transaction.mutations);
    return result;
  };
  const wrappedOnUpdate = async params => {
    for (const mutation of params.transaction.mutations) validateJsonSerializable(parser, mutation.modified, 'update');
    const result = config.onUpdate ? (await config.onUpdate(params)) ?? {} : {};
    persistMutations(params.transaction.mutations);
    return result;
  };
  const wrappedOnDelete = async params => {
    const result = config.onDelete ? (await config.onDelete(params)) ?? {} : {};
    persistMutations(params.transaction.mutations);
    return result;
  };
  const {
    storageKey: _storageKey,
    storage: _storage,
    storageEventApi: _storageEventApi,
    parser: _parser,
    onInsert: _onInsert,
    onUpdate: _onUpdate,
    onDelete: _onDelete,
    id,
    ...restConfig
  } = config;
  const collectionId = id ?? `local-collection:${config.storageKey}`;
  const acceptMutations = transaction => {
    const collectionMutations = transaction.mutations.filter(mutation => mutation.collection === sync.collection || mutation.collection.id === collectionId);
    if (!collectionMutations.length) return;
    for (const mutation of collectionMutations) {
      validateJsonSerializable(parser, mutation.type === 'delete' ? mutation.original : mutation.modified, mutation.type);
    }
    persistMutations(collectionMutations);
  };
  return {
    ...restConfig,
    id: collectionId,
    sync,
    onInsert: wrappedOnInsert,
    onUpdate: wrappedOnUpdate,
    onDelete: wrappedOnDelete,
    utils: {
      clearStorage: () => config.storage.removeItem(config.storageKey),
      getStorageSize: () => {
        const data = config.storage.getItem(config.storageKey);
        return data ? new Blob([data]).size : 0;
      },
      acceptMutations
    }
  };
};
exports.deferredCollectionPersistence = deferredCollectionPersistence;
//# sourceMappingURL=deferredCollectionPersistence.js.map
// Adapted from @tanstack/db local-storage.ts (MIT); deferred persistence is maintained here.
import type {
  BaseCollectionConfig,
  CollectionConfig,
  DeleteMutationFnParams,
  InsertMutationFnParams,
  LocalStorageCollectionUtils,
  PendingMutation,
  StorageApi,
  StorageEventApi,
  SyncConfig,
  UpdateMutationFnParams
} from '@tanstack/db';

type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

type AppStateModule = {
  AppState: {
    addEventListener: (event: 'change', listener: (state: AppStateStatus) => void) => unknown;
  };
};

type StoredItem<T> = { versionKey: string; data: T };

type Parser = { parse: (data: string) => unknown; stringify: (data: unknown) => string };

type DeferredCollectionPersistenceConfig<T extends object, TKey extends string | number> = BaseCollectionConfig<T, TKey, never, LocalStorageCollectionUtils> & {
  storageKey: string;
  storage: StorageApi;
  storageEventApi: StorageEventApi;
  parser?: Parser;
};

declare const require: <T>(moduleName: string) => T;

const FLUSH_DEBOUNCE_MS = 300;

const encodeStorageKey = (key: string | number): string => (typeof key === 'number' ? `n:${key}` : `s:${key}`);

const decodeStorageKey = (key: string): string | number => {
  if (key.startsWith('n:')) return Number(key.slice(2));
  if (key.startsWith('s:')) return key.slice(2);
  return key;
};

const generateUuid = (): string => {
  const random = globalThis.crypto?.randomUUID;
  return random ? random.call(globalThis.crypto) : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const validateJsonSerializable = (parser: Parser, value: unknown, operation: string): void => {
  try {
    parser.stringify(value);
  } catch (error) {
    throw new Error(`Cannot serialize ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const loadFromStorage = <T extends object>(storageKey: string, storage: StorageApi, parser: Parser): Map<string | number, StoredItem<T>> => {
  try {
    const rawData = storage.getItem(storageKey);
    if (!rawData) return new Map();
    const parsed = parser.parse(rawData);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid storage object for ${storageKey}`);

    const dataMap = new Map<string | number, StoredItem<T>>();
    for (const [encodedKey, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || !('versionKey' in value) || !('data' in value)) {
        throw new Error(`Invalid storage data for ${storageKey}:${encodedKey}`);
      }
      dataMap.set(decodeStorageKey(encodedKey), value as StoredItem<T>);
    }
    return dataMap;
  } catch (error) {
    console.warn(`[DeferredCollectionPersistence] Error loading storage key "${storageKey}":`, error);
    return new Map();
  }
};

const createStorageSync = <T extends object, TKey extends string | number>(
  storageKey: string,
  storage: StorageApi,
  storageEventApi: StorageEventApi,
  parser: Parser,
  lastKnownData: Map<string | number, StoredItem<T>>
): SyncConfig<T, TKey> & { collection: unknown; confirmOperationsSync: (mutations: Array<PendingMutation<any>>) => void } => {
  let syncParams: Parameters<SyncConfig<T, TKey>['sync']>[0] | null = null;
  let collection: unknown = null;

  const processStorageChanges = (): void => {
    if (!syncParams) return;
    const newData = loadFromStorage<T>(storageKey, storage, parser);
    const changes: Array<{ type: 'insert' | 'update' | 'delete'; value?: T }> = [];

    for (const [key, oldStoredItem] of lastKnownData) {
      const newStoredItem = newData.get(key);
      if (!newStoredItem) changes.push({ type: 'delete', value: oldStoredItem.data });
      else if (oldStoredItem.versionKey !== newStoredItem.versionKey) changes.push({ type: 'update', value: newStoredItem.data });
    }
    for (const [key, newStoredItem] of newData) {
      if (!lastKnownData.has(key)) changes.push({ type: 'insert', value: newStoredItem.data });
    }
    if (!changes.length) return;

    const { begin, write, commit } = syncParams;
    begin();
    for (const { type, value } of changes) {
      if (value) {
        validateJsonSerializable(parser, value, type);
        write({ type, value });
      }
    }
    commit();
    lastKnownData.clear();
    for (const [key, storedItem] of newData) lastKnownData.set(key, storedItem);
  };

  const sync: SyncConfig<T, TKey> & { collection: unknown } = {
    sync: params => {
      const { begin, write, commit, markReady } = params;
      syncParams = params;
      collection = params.collection;

      const initialData = loadFromStorage<T>(storageKey, storage, parser);
      if (initialData.size) {
        begin();
        for (const storedItem of initialData.values()) {
          validateJsonSerializable(parser, storedItem.data, 'load');
          write({ type: 'insert', value: storedItem.data });
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
    getSyncMetadata: () => ({ storageKey, storageType: 'custom' }),
    collection
  };

  const confirmOperationsSync = (mutations: Array<PendingMutation<any>>): void => {
    if (!syncParams) return;
    const { begin, write, commit } = syncParams;
    begin();
    for (const mutation of mutations) {
      write({ type: mutation.type, value: mutation.type === 'delete' ? mutation.original : mutation.modified });
    }
    commit();
  };

  Object.defineProperty(sync, 'collection', { get: () => collection });
  return Object.assign(sync, { confirmOperationsSync });
};

/** Build collection options that defer only whole-collection storage serialization. */
export const deferredCollectionPersistence = <T extends object, TKey extends string | number = string>(
  config: DeferredCollectionPersistenceConfig<T, TKey>
): CollectionConfig<T, TKey, never, LocalStorageCollectionUtils> & { id: string; utils: LocalStorageCollectionUtils; schema?: never } => {
  if (!config.storageKey) throw new Error('storageKey is required');

  const parser = config.parser ?? JSON;
  const lastKnownData = new Map<string | number, StoredItem<T>>();
  const sync = createStorageSync<T, TKey>(config.storageKey, config.storage, config.storageEventApi, parser, lastKnownData);
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const saveToStorage = (): void => {
    try {
      const objectData: Record<string, StoredItem<T>> = {};
      for (const [key, storedItem] of lastKnownData) objectData[encodeStorageKey(key)] = storedItem;
      config.storage.setItem(config.storageKey, parser.stringify(objectData));
    } catch (error) {
      console.error(`[DeferredCollectionPersistence] Error saving storage key "${config.storageKey}":`, error);
      throw error;
    }
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    saveToStorage();
  };

  const markDirty = (): void => {
    dirty = true;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
  };

  require<AppStateModule>('react-native').AppState.addEventListener('change', state => {
    if (state === 'background' || state === 'inactive') flush();
  });

  const persistMutations = (mutations: Array<PendingMutation<any>>): void => {
    for (const mutation of mutations) {
      if (mutation.type === 'delete') {
        lastKnownData.delete(mutation.key);
      } else {
        lastKnownData.set(mutation.key, { versionKey: generateUuid(), data: mutation.modified as T });
      }
    }
    markDirty();
    sync.confirmOperationsSync(mutations);
  };

  const wrappedOnInsert = async (params: InsertMutationFnParams<T, TKey, LocalStorageCollectionUtils>): Promise<unknown> => {
    for (const mutation of params.transaction.mutations) validateJsonSerializable(parser, mutation.modified, 'insert');
    const result = config.onInsert ? (await config.onInsert(params)) ?? {} : {};
    persistMutations(params.transaction.mutations);
    return result;
  };

  const wrappedOnUpdate = async (params: UpdateMutationFnParams<T, TKey, LocalStorageCollectionUtils>): Promise<unknown> => {
    for (const mutation of params.transaction.mutations) validateJsonSerializable(parser, mutation.modified, 'update');
    const result = config.onUpdate ? (await config.onUpdate(params)) ?? {} : {};
    persistMutations(params.transaction.mutations);
    return result;
  };

  const wrappedOnDelete = async (params: DeleteMutationFnParams<T, TKey, LocalStorageCollectionUtils>): Promise<unknown> => {
    const result = config.onDelete ? (await config.onDelete(params)) ?? {} : {};
    persistMutations(params.transaction.mutations);
    return result;
  };

  const { storageKey: _storageKey, storage: _storage, storageEventApi: _storageEventApi, parser: _parser, onInsert: _onInsert, onUpdate: _onUpdate, onDelete: _onDelete, id, ...restConfig } = config;
  const collectionId = id ?? `local-collection:${config.storageKey}`;

  const acceptMutations = (transaction: { mutations: Array<PendingMutation<any>> }): void => {
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
  } as unknown as CollectionConfig<T, TKey, never, LocalStorageCollectionUtils> & { id: string; utils: LocalStorageCollectionUtils; schema?: never };
};

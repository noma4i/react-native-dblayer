type LoadedStorage = {
  adapter: typeof import('../utils/mmkvStorage').mmkvStorageAdapter;
  clearDbStorage: typeof import('../utils/mmkvStorage').clearDbStorage;
  getDbStorageKeys: typeof import('../utils/mmkvStorage').getDbStorageKeys;
  removeDbStorageKey: typeof import('../utils/mmkvStorage').removeDbStorageKey;
  storage: {
    getString: jest.Mock<string | undefined, [string]>;
    set: jest.Mock<void, [string, string]>;
    remove: jest.Mock<void, [string]>;
    clearAll: jest.Mock<void, []>;
    getAllKeys: jest.Mock<string[], []>;
  };
};

const loadStorage = (): LoadedStorage => {
  jest.resetModules();
  const values = new Map<string, string>();
  const storage = {
    getString: jest.fn((key: string) => values.get(key)),
    set: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    remove: jest.fn((key: string) => {
      values.delete(key);
    }),
    clearAll: jest.fn(() => {
      values.clear();
    }),
    getAllKeys: jest.fn(() => Array.from(values.keys()))
  };

  jest.doMock('react-native-mmkv', () => ({ createMMKV: jest.fn(() => storage) }));
  const module = require('../utils/mmkvStorage') as typeof import('../utils/mmkvStorage');
  return {
    adapter: module.mmkvStorageAdapter,
    clearDbStorage: module.clearDbStorage,
    getDbStorageKeys: module.getDbStorageKeys,
    removeDbStorageKey: module.removeDbStorageKey,
    storage
  };
};

describe('mmkv storage adapter', () => {
  afterEach(() => {
    jest.dontMock('react-native-mmkv');
    jest.resetModules();
  });

  it('writes and removes values synchronously', () => {
    const { adapter, storage } = loadStorage();

    adapter.setItem('feed', 'value');
    expect(storage.set).toHaveBeenCalledWith('feed', 'value');
    expect(adapter.getItem('feed')).toBe('value');

    adapter.removeItem('feed');
    expect(storage.remove).toHaveBeenCalledWith('feed');
    expect(adapter.getItem('feed')).toBeNull();
  });

  it('enumerates, removes, and clears physical storage keys', () => {
    const { adapter, clearDbStorage, getDbStorageKeys, removeDbStorageKey, storage } = loadStorage();
    adapter.setItem('a', 'first');
    adapter.setItem('b', 'second');

    expect(getDbStorageKeys().sort()).toEqual(['a', 'b']);
    removeDbStorageKey('a');
    expect(getDbStorageKeys()).toEqual(['b']);

    clearDbStorage();
    expect(storage.clearAll).toHaveBeenCalledTimes(1);
    expect(getDbStorageKeys()).toEqual([]);
  });
});

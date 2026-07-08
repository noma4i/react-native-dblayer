type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

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
  listeners: Array<(state: AppStateStatus) => void>;
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
  const listeners: Array<(state: AppStateStatus) => void> = [];

  jest.doMock('react-native-mmkv', () => ({
    createMMKV: jest.fn(() => storage)
  }));
  jest.doMock('react-native', () => ({
    AppState: {
      addEventListener: jest.fn((_event: 'change', listener: (state: AppStateStatus) => void) => {
        listeners.push(listener);
        return { remove: jest.fn() };
      })
    }
  }));

  const module = require('../utils/mmkvStorage') as typeof import('../utils/mmkvStorage');
  return {
    adapter: module.mmkvStorageAdapter,
    clearDbStorage: module.clearDbStorage,
    getDbStorageKeys: module.getDbStorageKeys,
    removeDbStorageKey: module.removeDbStorageKey,
    storage,
    listeners
  };
};

describe('mmkv storage write-back buffer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('react-native');
    jest.dontMock('react-native-mmkv');
    jest.resetModules();
  });

  it('coalesces repeated writes until the debounce window closes', () => {
    const { adapter, storage } = loadStorage();

    adapter.setItem('feed', 'v1');
    adapter.setItem('feed', 'v2');
    adapter.setItem('profile', 'p1');
    jest.advanceTimersByTime(299);

    expect(storage.set).not.toHaveBeenCalled();
    expect(adapter.getItem('feed')).toBe('v2');

    jest.advanceTimersByTime(1);

    expect(storage.set).toHaveBeenCalledTimes(2);
    expect(storage.set).toHaveBeenCalledWith('feed', 'v2');
    expect(storage.set).toHaveBeenCalledWith('profile', 'p1');
  });

  it('forces a flush at max wait while writes keep extending the debounce timer', () => {
    const { adapter, storage } = loadStorage();

    adapter.setItem('chat', 'v1');
    jest.advanceTimersByTime(250);
    adapter.setItem('chat', 'v2');
    jest.advanceTimersByTime(250);
    adapter.setItem('chat', 'v3');
    jest.advanceTimersByTime(250);
    adapter.setItem('chat', 'v4');
    jest.advanceTimersByTime(249);

    expect(storage.set).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);

    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenCalledWith('chat', 'v4');
  });

  it('flushes pending writes when the app leaves the foreground', () => {
    const { adapter, storage, listeners } = loadStorage();

    adapter.setItem('users', 'pending');
    expect(listeners).toHaveLength(1);

    listeners[0]('inactive');

    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenCalledWith('users', 'pending');
  });

  it('keeps reads and key enumeration current before and after flush boundaries', () => {
    const { adapter, getDbStorageKeys, removeDbStorageKey, storage } = loadStorage();

    adapter.setItem('a', 'first');
    adapter.setItem('b', 'stored');
    jest.advanceTimersByTime(300);
    storage.set.mockClear();

    adapter.setItem('a', 'second');
    removeDbStorageKey('b');

    expect(adapter.getItem('a')).toBe('second');
    expect(adapter.getItem('b')).toBeNull();
    expect(getDbStorageKeys().sort()).toEqual(['a']);

    jest.advanceTimersByTime(300);

    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenCalledWith('a', 'second');
    expect(storage.remove).toHaveBeenCalledWith('b');
    expect(adapter.getItem('a')).toBe('second');
    expect(adapter.getItem('b')).toBeNull();
  });

  it('does not lose writes that arrive across adjacent flush cycles', () => {
    const { adapter, storage } = loadStorage();

    adapter.setItem('scope', 'first');
    jest.advanceTimersByTime(300);
    adapter.setItem('scope', 'second');
    jest.advanceTimersByTime(300);

    expect(storage.set).toHaveBeenCalledTimes(2);
    expect(storage.set).toHaveBeenNthCalledWith(1, 'scope', 'first');
    expect(storage.set).toHaveBeenNthCalledWith(2, 'scope', 'second');
    expect(adapter.getItem('scope')).toBe('second');
  });

  it('clears pending writes without flushing stale values', () => {
    const { adapter, clearDbStorage, storage } = loadStorage();

    adapter.setItem('moments', 'pending');
    clearDbStorage();
    jest.advanceTimersByTime(300);

    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.clearAll).toHaveBeenCalledTimes(1);
    expect(adapter.getItem('moments')).toBeNull();
  });
});

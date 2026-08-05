import type { UsedMmkvMethods } from '../../testApi';
import { configureDb , bootDb , mmkvStoragePlane , mmkvStorageAdapter, getDbStorageKeys, removeDbStorageKey } from '../../testApi';
import { createMockTransport } from '../helpers/harness';

// Type-only import: pulls the real-package-bound mock factory (__mocks__/mmkvMockFactory.ts) into this
// file's tsc program (`yarn typecheck`), on top of ts-jest's own per-file diagnostics while this suite runs.
type EnsureMockTypeChecked = UsedMmkvMethods;

const declaresUsedMethods = (methods: EnsureMockTypeChecked): EnsureMockTypeChecked => methods;
void declaresUsedMethods;

describe('mmkv storage contract: mmkvStorage -> storagePlane -> manifest boot path', () => {
  const removeAllDbKeys = (): void => {
    for (const key of getDbStorageKeys()) removeDbStorageKey(key);
  };

  beforeEach(removeAllDbKeys);

  afterEach(removeAllDbKeys);

  it('creates one MMKV wrapper and reuses it across adapter operations', async () => {
    const storage = {
      getString: jest.fn(() => undefined),
      set: jest.fn(),
      remove: jest.fn(),
      getAllKeys: jest.fn(() => [])
    };
    const createMMKV = jest.fn(() => storage);
    jest.doMock('react-native-mmkv', () => ({ createMMKV }));
    try {
      await jest.isolateModulesAsync(async () => {
        const isolated = await import('../../testApi');
        expect(isolated.mmkvStorageAdapter.getItem('missing')).toBeNull();
        expect(isolated.getDbStorageKeys()).toEqual([]);
      });
      expect(createMMKV).toHaveBeenCalledTimes(1);
    } finally {
      jest.dontMock('react-native-mmkv');
    }
  });

  it('round-trips through the real mmkv-backed adapter (getItem/setItem/removeItem)', () => {
    expect(mmkvStorageAdapter.getItem('missing-key')).toBeNull();

    mmkvStorageAdapter.setItem('greeting', 'hello');
    expect(mmkvStorageAdapter.getItem('greeting')).toBe('hello');

    mmkvStorageAdapter.removeItem('greeting');
    expect(mmkvStorageAdapter.getItem('greeting')).toBeNull();
  });

  it('lists every stored key through getAllKeys, and removeDbStorageKey drops one', () => {
    mmkvStorageAdapter.setItem('a', '1');
    mmkvStorageAdapter.setItem('b', '2');

    expect(getDbStorageKeys().sort()).toEqual(['a', 'b']);

    removeDbStorageKey('a');
    expect(getDbStorageKeys()).toEqual(['b']);
  });

  it('[P21] mmkvStoragePlane() get/set/keys round-trip against the real adapter chain', () => {
    const plane = mmkvStoragePlane();

    expect(plane.get('dbl:sentinel')).toBeUndefined();

    plane.set('dbl:sentinel', 'kept');
    expect(plane.get('dbl:sentinel')).toBe('kept');
    expect(plane.keys('dbl:')).toEqual(['dbl:sentinel']);

    plane.set('dbl:sentinel', null);
    expect(plane.get('dbl:sentinel')).toBeUndefined();
  });

  it('boots through the real mmkv-backed storage plane (default configureDb storage) and writes the manifest', async () => {
    configureDb({ transport: createMockTransport() });

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    const manifestKeys = getDbStorageKeys().filter(key => key.endsWith('manifest'));
    expect(manifestKeys.length).toBeGreaterThan(0);
  });
});

import type { UsedMmkvMethods } from '../../testApi';
import { configureDb , bootDb , mmkvStoragePlane , mmkvStorageAdapter, getDbStorageKeys, removeDbStorageKey, encodePersistence, DB_FORMAT_VERSION, computeSchemaFingerprints } from '../../testApi';
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

  it('serves one shared MMKV instance to the adapter, the plane, and the key registry', () => {
    // Each entry point of the module would hold a private store if the wrapper were re-created:
    // a value written through one surface must be readable through every other.
    mmkvStorageAdapter.setItem('shared-key', 'via-adapter');
    const plane = mmkvStoragePlane();

    expect(plane.get('shared-key')).toBe('via-adapter');

    plane.set('plane-key', 'via-plane');

    expect(mmkvStorageAdapter.getItem('plane-key')).toBe('via-plane');
    expect(getDbStorageKeys().sort()).toEqual(['plane-key', 'shared-key']);

    removeDbStorageKey('shared-key');
    expect(plane.get('shared-key')).toBeUndefined();
    expect(mmkvStorageAdapter.getItem('plane-key')).toBe('via-plane');
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

  it('boots through the real mmkv-backed storage plane (default configureDb storage) and writes the current manifest payload', async () => {
    configureDb({ transport: createMockTransport() });

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(mmkvStoragePlane().get('dbl:manifest')).toBe(
      encodePersistence({ formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null })
    );
  });
});

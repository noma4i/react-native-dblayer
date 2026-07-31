import {
  compositeStorageKey,
  configureDb,
  encodePersistence,
  type QueryPersistenceRecord,
  type StoragePlane
} from '../../testApi';
import {
  readPersistedQuery,
  readPersistedQueryFamily,
  writePersistedQuery
} from '../../../core/queryPersistence';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const declaration = {
  family: 'query-persistence-contract',
  persistenceVersion: 1,
  fingerprint: 'fingerprint'
};

const record = (
  overrides: Partial<QueryPersistenceRecord<string, null>> = {}
): QueryPersistenceRecord<string, null> => ({
  recordVersion: 1,
  family: declaration.family,
  identity: 'identity',
  persistenceVersion: declaration.persistenceVersion,
  fingerprint: declaration.fingerprint,
  scope: null,
  payload: 'value',
  empty: false,
  dataUpdatedAt: 1,
  invalidated: false,
  ...overrides
});

const keyOf = (family = declaration.family, identity = 'identity'): string =>
  compositeStorageKey('dbl:', 'query', family, identity);

describe('query persistence records', () => {
  it('removes corrupt, unsupported, and incompatible exact records', () => {
    const onSyncError = jest.fn();
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError, inSessionGc: false }
    });

    storage.set([{ key: keyOf(), value: 'corrupt' }]);
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(storage.get(keyOf())).toBeUndefined();

    storage.set([{ key: keyOf(), value: encodePersistence(record(), 99) }]);
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(onSyncError).toHaveBeenCalledTimes(1);

    storage.set([{ key: keyOf(), value: encodePersistence(record({ persistenceVersion: 2 })) }]);
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(storage.get(keyOf())).toBeUndefined();
  });

  it('removes corrupt and incompatible family records while retaining valid siblings', () => {
    const onSyncError = jest.fn();
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError, inSessionGc: false }
    });
    storage.set([
      { key: keyOf(declaration.family, 'corrupt'), value: 'corrupt' },
      {
        key: keyOf(declaration.family, 'wrong-family'),
        value: encodePersistence(record({ identity: 'wrong-family', family: 'other-family' }))
      },
      {
        key: keyOf(declaration.family, 'valid'),
        value: encodePersistence(record({ identity: 'valid' }))
      }
    ]);

    expect(readPersistedQueryFamily(declaration).map(value => value.identity)).toEqual(['valid']);
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(storage.snapshotKeys().filter(key => key.startsWith(compositeStorageKey('dbl:', 'query', declaration.family)))).toEqual([
      keyOf(declaration.family, 'valid')
    ]);
  });

  it('ignores a disappeared family key and rejects non-JSON scope and payload values', () => {
    const base = createMemoryPlane();
    const ghostKey = keyOf(declaration.family, 'ghost');
    const storage: StoragePlane = {
      get: key => (key === ghostKey ? undefined : base.get(key)),
      set: entries => base.set(entries),
      keys: prefix => [...base.keys(prefix), ...(ghostKey.startsWith(prefix) ? [ghostKey] : [])]
    };
    const onSyncError = jest.fn();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError, inSessionGc: false }
    });

    expect(readPersistedQueryFamily(declaration)).toEqual([]);
    expect(
      writePersistedQuery({
        ...declaration,
        identity: 'bad-scope',
        scope: Symbol('scope'),
        payload: 'value',
        empty: false,
        dataUpdatedAt: 1
      })
    ).toBe(false);
    expect(
      writePersistedQuery({
        ...declaration,
        identity: 'bad-payload',
        scope: null,
        payload: Symbol('payload'),
        empty: false,
        dataUpdatedAt: 1
      })
    ).toBe(false);
    expect(onSyncError).toHaveBeenCalledTimes(2);
  });
});

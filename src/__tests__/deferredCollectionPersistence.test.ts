const appStateListeners: Array<(state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => void> = [];

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((_event: 'change', listener: (state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => void) => {
      appStateListeners.push(listener);
      return { remove: jest.fn() };
    })
  }
}));

import { createCollection } from '@tanstack/db';
import { deferredCollectionPersistence } from '../core/deferredCollectionPersistence';

type Row = { id: string; value: string };

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn((key: string) => {
      values.delete(key);
    }),
    eventApi: {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    }
  };
};

const createPersistentRows = (storage: ReturnType<typeof createStorage>) => {
  const collection = createCollection(
    deferredCollectionPersistence<Row>({
      id: 'rows',
      storageKey: 'rows',
      storage,
      storageEventApi: storage.eventApi,
      getKey: row => row.id
    })
  );
  collection.startSyncImmediate();
  return collection;
};

describe('deferred collection persistence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    appStateListeners.splice(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces repeated collection commits into one storage serialization', async () => {
    const storage = createStorage();
    const collection = createPersistentRows(storage);

    collection.insert({ id: 'one', value: 'first' });
    collection.insert({ id: 'two', value: 'second' });
    await Promise.resolve();

    expect(collection.state.get('one')?.value).toBe('first');
    expect(storage.setItem).not.toHaveBeenCalled();
    jest.advanceTimersByTime(300);

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.setItem.mock.calls[0]![1])).toMatchObject({
      's:one': { data: { id: 'one', value: 'first' } },
      's:two': { data: { id: 'two', value: 'second' } }
    });
  });

  it('flushes the current collection snapshot when the app backgrounds', async () => {
    const storage = createStorage();
    const collection = createPersistentRows(storage);
    collection.insert({ id: 'one', value: 'first' });
    await Promise.resolve();

    appStateListeners.at(-1)?.('inactive');

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.setItem.mock.calls[0]![1])['s:one'].data).toEqual({ id: 'one', value: 'first' });
  });

  it('confirms accepted mutations synchronously while deferring their storage write', () => {
    const storage = createStorage();
    const collection = createPersistentRows(storage);
    const row = { id: 'accepted', value: 'current' };

    collection.utils.acceptMutations({
      mutations: [{ type: 'insert', key: row.id, modified: row, collection } as never]
    });

    expect(collection.state.get(row.id)).toMatchObject({ ...row, $synced: true });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('hydrates the serialized snapshot into a new collection', async () => {
    const storage = createStorage();
    const firstCollection = createPersistentRows(storage);
    firstCollection.insert({ id: 'one', value: 'persisted' });
    await Promise.resolve();
    jest.advanceTimersByTime(300);

    const hydratedCollection = createPersistentRows(storage);
    expect(hydratedCollection.state.get('one')).toMatchObject({ id: 'one', value: 'persisted', $synced: true });
  });
});

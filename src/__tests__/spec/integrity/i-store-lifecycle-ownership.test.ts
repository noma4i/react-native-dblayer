import { createModelStore, keysForSequence } from '../../testApi';
import { createMemoryPlane } from '../helpers/harness';

type Row = { id: string } & Record<string, unknown>;

const KEYS = keysForSequence(2);

let storeTag = 0;
const buildStore = () =>
  createModelStore<Row>({
    modelId: `SpecStoreLifetime${(storeTag += 1)}`,
    now: () => Date.now(),
    storage: createMemoryPlane(),
    prefix: () => 'spec-lifetime:',
    applyWriteGate: (_previous, incoming) => incoming
  });

/**
 * An idle stretch with no mounted reader, long enough for any third-party retention timer to fire.
 * Retention timers are armed from a microtask and their cleanup passes run from an idle callback,
 * so the wait has to drain both queues - a synchronous advance would silently skip every one.
 */
const idleFor = async (minutes: number): Promise<void> => {
  await Promise.resolve();
  jest.advanceTimersByTime(minutes * 60 * 1000);
  await Promise.resolve();
  jest.runOnlyPendingTimers();
  await Promise.resolve();
  jest.runOnlyPendingTimers();
};

/**
 * The store owns the lifetime of its planes. Rows and scope memberships leave memory when this
 * package evicts them - GC, reset, or dispose - and at no other moment. A collection library that
 * drops idle data on its own timer would delete rows the app never released, and would leave the
 * scope index pointing at rows the collection no longer holds.
 */
describe('store plane lifetime ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const seed = () => {
    const store = buildStore();
    store.upsert({ id: 'row-1', label: 'first' });
    store.upsert({ id: 'row-2', label: 'second' });
    store.applyScopeChanges([
      {
        scopeKey: 'scope-1',
        entries: [
          { id: 'row-1', orderKey: KEYS[0]! },
          { id: 'row-2', orderKey: KEYS[1]! }
        ]
      }
    ]);
    store.markReady();
    // A reader mounts and leaves: this is what arms an idle-retention timer.
    store.scopeCollection('scope-1').subscribe(() => undefined)();
    return store;
  };

  it('keeps rows readable after a long idle stretch with no mounted reader', async () => {
    const store = seed();

    await idleFor(30);

    expect(store.read('row-1')).toMatchObject({ id: 'row-1', label: 'first' });
    expect(store.values().map(row => row.id)).toEqual(['row-1', 'row-2']);
  });

  it('keeps a scope readable after a long idle stretch', async () => {
    const store = seed();

    await idleFor(30);

    expect(store.scopeCollection('scope-1').toArray().map(row => row.id)).toEqual(['row-1', 'row-2']);
  });

  it('projects a scope change after a long idle stretch instead of failing on a stale membership', async () => {
    const store = seed();

    await idleFor(30);

    // The exact production sequence: a background sweep projects a shrunken snapshot into a scope
    // nobody has read for a while.
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries: [{ id: 'row-1', orderKey: KEYS[0]! }] }]);

    expect(store.scopeCollection('scope-1').toArray().map(row => row.id)).toEqual(['row-1']);
  });

  it('serves a reader that mounts after the idle stretch', async () => {
    const store = seed();

    await idleFor(30);

    const seen: unknown[][] = [];
    const release = store.scopeCollection('scope-1').subscribe(changes => seen.push(changes));
    const rows = store.scopeCollection('scope-1').toArray();
    release();

    expect(rows.map(row => row.id)).toEqual(['row-1', 'row-2']);
  });
});

import { bootDb, configureDb, defineModelRuntime, f, getApplyRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

/**
 * A row exists because something DECLARED it, not because someone happens to be looking at it right
 * now. The app-shaped idle: readers mount, the user backgrounds the app (cache snapshots land, no
 * reader stays mounted), retention timers of every layer get their chance to fire, and the user comes
 * back - through the same runtime and through a cold boot on the same storage plane. Every row is
 * still there with its fields, and a reader that mounts again sees the same set.
 */
const idleFor = async (minutes: number): Promise<void> => {
  await Promise.resolve();
  jest.advanceTimersByTime(minutes * 60 * 1000);
  await Promise.resolve();
  jest.runOnlyPendingTimers();
  await Promise.resolve();
  jest.runOnlyPendingTimers();
};

describe('durability under idle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('[I5] keeps rows that belong to a declared scope when the app suspends', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport({}) });
    const define = () =>
      defineModelRuntime({
        id: 'SpecDurableScoped',
        name: 'SpecDurableScoped',
        fields: { bucket: f.str(), body: f.str() },
        scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
      });
    const scoped = define();
    await bootDb();
    scoped.insertMany([
      { id: 'row-1', bucket: 'a', body: 'first' },
      { id: 'row-2', bucket: 'a', body: 'second' }
    ]);
    const reader = renderCounted(() => scoped.scopes.byBucket.use({ bucket: 'a' }) as Array<{ id: string; body: string }>);
    expect(reader.result().map(row => [row.id, row.body])).toEqual([
      ['row-1', 'first'],
      ['row-2', 'second']
    ]);

    // Background: the reader leaves, cache snapshots land, a long idle stretch passes.
    reader.unmount();
    getApplyRuntime().flushCacheSnapshots();
    await idleFor(30);

    expect(scoped.scopes.byBucket.read({ bucket: 'a' }).map(row => [row.id, row.body])).toEqual([
      ['row-1', 'first'],
      ['row-2', 'second']
    ]);
    const remounted = renderCounted(() => scoped.scopes.byBucket.use({ bucket: 'a' }) as Array<{ id: string; body: string }>);
    expect(remounted.result().map(row => row.id)).toEqual(['row-1', 'row-2']);
    remounted.unmount();

    // Process restart on the same plane: the declared scope and its rows come back from disk.
    configureDb({ storage, transport: createMockTransport({}) });
    const rebooted = define();
    await bootDb();
    expect(rebooted.scopes.byBucket.read({ bucket: 'a' }).map(row => [row.id, row.body])).toEqual([
      ['row-1', 'first'],
      ['row-2', 'second']
    ]);
  });

  it('[A9] keeps written rows when the app suspends with no reader mounted', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport({}) });
    const define = () => defineModelRuntime({ id: 'SpecDurableIdle', name: 'SpecDurableIdle', fields: { body: f.str() } });
    const rows = define();
    await bootDb();
    rows.insertMany([
      { id: 'row-1', body: 'first' },
      { id: 'row-2', body: 'second' }
    ]);
    // Never read by anyone: a reader-rooted sweep would see no root at all.
    getApplyRuntime().flushCacheSnapshots();
    await idleFor(30);

    expect(rows.all().map(row => [row.id, row.body])).toEqual([
      ['row-1', 'first'],
      ['row-2', 'second']
    ]);

    // Process restart on the same plane.
    configureDb({ storage, transport: createMockTransport({}) });
    const rebooted = define();
    await bootDb();
    expect(rebooted.all().map(row => [row.id, row.body])).toEqual([
      ['row-1', 'first'],
      ['row-2', 'second']
    ]);
  });
});

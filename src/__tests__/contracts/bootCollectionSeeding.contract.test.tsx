import { act } from 'react-test-renderer';
import { bootDb, defineModel, f, flushPersistence, scope } from '../../index';
import { collectionFor } from '../../core/tanstack/facade';
import { createAcceptanceTransport, createMemoryPlane, renderCounted, setupAcceptanceRuntime } from '../acceptance/harness';

describe(`boot collection seeding`, () => {
  it(`hydrates an eagerly registered model before its first new-session write and skips stale storage models`, async () => {
    const storage = createMemoryPlane();
    setupAcceptanceRuntime({ storage });
    const first = defineModel({
      id: `BootSeedKnown`,
      name: `BootSeedKnown`,
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
      gc: `exempt`
    });
    act(() => {
      first.insertStored({ id: `hydrated`, group: `g`, title: `saved` });
      flushPersistence();
    });
    storage.set([{ key: `dbl:row:BootSeedStale:orphan`, value: JSON.stringify({ id: `orphan`, title: `stale` }) }]);

    const restarted = defineModel({
      id: `BootSeedKnown`,
      name: `BootSeedKnown`,
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: `group` }, sort: `server-order` }) },
      gc: `exempt`
    });

    await expect(bootDb({ storage, transport: createAcceptanceTransport() })).resolves.toEqual(expect.objectContaining({ replayed: expect.any(Number) }));

    expect(collectionFor(`BootSeedKnown`).get(`hydrated`)).toMatchObject({ id: `hydrated`, title: `saved` });
    const reader = renderCounted(() => restarted.scopes.feed.use({ group: `g` }));
    expect(reader.result()).toEqual([{ id: `hydrated`, group: `g`, title: `saved` }]);
    reader.unmount();
  });

  it(`seeds a persisted model that registers after stale-key boot`, async () => {
    const storage = createMemoryPlane();
    storage.set([{ key: `dbl:row:BootSeedLate:late`, value: JSON.stringify({ id: `late`, title: `persisted` }) }]);

    await expect(bootDb({ storage, transport: createAcceptanceTransport() })).resolves.toEqual(expect.objectContaining({ replayed: expect.any(Number) }));

    const late = defineModel({
      id: `BootSeedLate`,
      name: `BootSeedLate`,
      fields: { title: f.str() },
      gc: `exempt`
    });

    expect(late.get(`late`)).toEqual({ id: `late`, title: `persisted` });
    expect(collectionFor(`BootSeedLate`).get(`late`)).toMatchObject({ id: `late`, title: `persisted` });
  });
});

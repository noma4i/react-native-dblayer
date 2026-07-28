import { createCollection, localStorageCollectionOptions } from '@tanstack/db';

/**
 * Phase-2 PoC (tanstack-first redesign), persistence row: measures what the built-in
 * `localStorageCollectionOptions` path actually does over an injected StorageApi (the MMKV seam
 * candidate), producing the R14 evidence: (1) hydration from pre-existing storage works across a
 * simulated restart; (2) every point update rewrites the WHOLE collection under its single
 * storageKey - full-collection write amplification, which disqualifies this path for large models
 * and keeps our granular WAL/checkpoint persistence by proven merit, not inertia.
 */
type NoteRow = { id: string; body: string };

const createCountingStorage = () => {
  const data = new Map<string, string>();
  const counters = { setItemCalls: 0, bytesWritten: 0, lastWriteBytes: 0 };
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      counters.setItemCalls += 1;
      counters.bytesWritten += value.length;
      counters.lastWriteBytes = value.length;
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    }
  };
  return { storage, counters };
};

const createNotesCollection = (id: string, storage: ReturnType<typeof createCountingStorage>['storage']) =>
  createCollection({
    ...localStorageCollectionOptions<NoteRow>({
      id,
      storageKey: 'poc-notes',
      storage,
      getKey: row => row.id
    }),
    startSync: true
  });

describe('TanStack local-storage persistence PoC', () => {
  it('hydrates a collection from pre-existing storage across a simulated restart', () => {
    const { storage } = createCountingStorage();
    const first = createNotesCollection('poc-persist-first', storage);
    first.insert({ id: 'note-1', body: 'saved before restart' });

    const second = createNotesCollection('poc-persist-second', storage);

    expect(second.get('note-1')).toMatchObject({ body: 'saved before restart' });
  });

  it('rewrites the whole collection on every point update - full-collection write amplification', () => {
    const { storage, counters } = createCountingStorage();
    const notes = createNotesCollection('poc-persist-amplification', storage);
    const rowCount = 500;
    for (let index = 0; index < rowCount; index += 1) {
      notes.insert({ id: `note-${index}`, body: `body-${index}-${'x'.repeat(40)}` });
    }
    const fullSnapshotBytes = counters.lastWriteBytes;

    const before = { calls: counters.setItemCalls, bytes: counters.bytesWritten };
    const pointUpdates = 10;
    for (let index = 0; index < pointUpdates; index += 1) {
      notes.update(`note-${index}`, draft => {
        draft.body = `updated-${index}`;
      });
    }
    const perUpdateBytes = (counters.bytesWritten - before.bytes) / pointUpdates;

    expect(counters.setItemCalls - before.calls).toBe(pointUpdates);
    // Each one-row update rewrites at least ~90% of the full serialized collection: the single
    // storageKey design cannot flush deltas. This is the R14 disqualifier for large models.
    expect(perUpdateBytes).toBeGreaterThan(fullSnapshotBytes * 0.9);
  });
});

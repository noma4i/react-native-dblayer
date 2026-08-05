import {
  compositeKey,
  compositeStorageKey,
  createEntityPlane,
  createRowCleaner,
  encodePersistence,
  runInApplyBatch,
  type StoragePlane
} from '../../testApi';
import { createMemoryPlane, diagnostics } from '../helpers/harness';

const prefix = 'entity-edge:';
let storeId = 0;

const createPlane = (storage: StoragePlane = createMemoryPlane(), now: () => number = () => 1_000) => {
  const modelId = `SpecEntityPlaneEdges${(storeId += 1)}`;
  const plane = createEntityPlane({
    modelId,
    storeId,
    now,
    storage,
    prefix: () => prefix,
    applyWriteGate: (_previous, incoming) => incoming
  });
  plane.markReady();
  return { modelId, plane, storage };
};

describe('entity plane edges', () => {
  it('removes virtual collection properties from an enriched row', () => {
    const clean = createRowCleaner();
    const enriched = { id: 'row-1', label: 'clean', $meta: { source: 'collection' } };
    const first = clean(enriched);

    expect(first).toEqual({
      id: 'row-1',
      label: 'clean'
    });
    expect(clean(enriched)).toBe(first);
  });

  it('updates and deletes committed rows while ignoring a repeated delete', () => {
    const { plane } = createPlane();
    plane.put({ id: 'row-1', label: 'first' });
    expect(plane.readCommitted('row-1')).toEqual({ id: 'row-1', label: 'first' });
    expect(plane.readCommitted('row-1')).toEqual({ id: 'row-1', label: 'first' });

    plane.put({ id: 'row-1', label: 'second' });
    expect(plane.read('row-1')).toEqual({ id: 'row-1', label: 'second' });

    plane.destroy('row-1');
    plane.destroy('missing');
    expect(plane.read('row-1')).toBeUndefined();
    expect(plane.read('missing')).toBeUndefined();
  });

  it('reads buffered inserts and deletes and restores every side effect after batch abort', () => {
    const { plane } = createPlane();
    plane.put({ id: 'row-1', label: 'baseline' });
    plane.ackPersist();

    expect(() =>
      runInApplyBatch(() => {
        plane.put({ id: 'row-2', label: 'buffered' });
        plane.destroy('row-1');
        expect(plane.values()).toEqual([{ id: 'row-2', label: 'buffered' }]);
        throw new Error('abort');
      })
    ).toThrow('abort');

    expect(plane.values()).toEqual([{ id: 'row-1', label: 'baseline' }]);
    expect(plane.persistEntries()).toEqual([]);
  });

  it('restores pre-existing dirty and tombstone state after batch abort', () => {
    const { plane } = createPlane();
    plane.put({ id: 'row-1', label: 'baseline' });
    plane.destroy('row-1');

    expect(() =>
      runInApplyBatch(() => {
        plane.put({ id: 'row-1', label: 'resurrected' });
        throw new Error('abort');
      })
    ).toThrow('abort');

    expect(plane.isTombstoned('row-1')).toBe(true);
    expect(plane.persistEntries()).toContainEqual(expect.objectContaining({ value: null }));
  });

  it('handles id coercion, no-op writes, upsert no-ops, eviction, reset, and disposal', () => {
    const { plane } = createPlane();
    const row = { id: '7', label: 'first' };
    plane.put({ id: 8 as never, label: 'numeric' });
    plane.put(row);
    expect(plane.put(row)).toEqual({ changedFields: [] });
    expect(plane.put({ id: '7', label: 'first' })).toEqual({ changedFields: [] });
    expect(plane.upsert({ id: '7', label: 'first' })).toEqual({ changedFields: [] });
    expect(plane.evict('7')).toBe(true);
    expect(plane.evict('7')).toBe(false);
    plane.reset();
    plane.dispose();
    expect(plane.values()).toEqual([]);
  });

  it('persists a null tombstone record after a row resurrects', () => {
    const { modelId, plane } = createPlane();
    plane.put({ id: 'row-1', label: 'first' });
    plane.ackPersist();
    plane.destroy('row-1');
    plane.put({ id: 'row-1', label: 'resurrected' });

    expect(plane.persistEntries()).toContainEqual({
      key: compositeStorageKey(prefix, 'tombstones', modelId),
      value: null
    });
    expect(plane.evict('missing')).toBe(false);
  });

  it('[P4] drops missing and corrupt persisted rows and corrupt tombstones during hydrate', () => {
    const values = new Map<string, string>();
    let rowsPrefix = '';
    const storage: StoragePlane = {
      get: key => values.get(key),
      set: (key, value) => {
        if (value === null) values.delete(key);
        else values.set(key, value);
      },
      keys: requestedPrefix => {
        rowsPrefix = requestedPrefix;
        return [`${requestedPrefix}${compositeKey('missing')}`, ...[...values.keys()].filter(key => key.startsWith(requestedPrefix))];
      }
    };
    const { modelId, plane } = createPlane(storage);
    const wrongKey = compositeStorageKey(prefix, 'row', modelId, 'wrong');
    const corruptKey = compositeStorageKey(prefix, 'row', modelId, 'corrupt');
    values.set(wrongKey, encodePersistence({ id: 'other', label: 'wrong key' }));
    values.set(corruptKey, 'not-json');
    values.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence({ row: { at: -1 } }));
    diagnostics().reset();

    plane.hydrate();

    expect(rowsPrefix).toContain(modelId);
    expect(values.has(wrongKey)).toBe(false);
    expect(values.has(corruptKey)).toBe(false);
    expect(diagnostics().snapshot().dataLossEvents).toEqual(
      expect.arrayContaining([
        { mechanism: 'corrupt-row', model: modelId, count: 1 },
        { mechanism: 'corrupt-tombstones', model: modelId, count: 1 }
      ])
    );
  });

  it('hydrates valid rows and reuses their clean identity', () => {
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage);
    storage.set(compositeStorageKey(prefix, 'row', modelId, 'row-1'), encodePersistence({ id: 'row-1', label: 'persisted' }));

    plane.hydrate();
    const first = plane.readCommitted('row-1');
    const second = plane.readCommitted('row-1');

    expect(first).toEqual({ id: 'row-1', label: 'persisted' });
    expect(second).toBe(first);
  });

  it('prunes old tombstones back to the normal cap', () => {
    let now = 0;
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => now);
    const tombstones = Object.fromEntries(Array.from({ length: 10_002 }, (_, index) => [`row-${index}`, { at: 0 }]));
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence(tombstones));
    plane.hydrate();
    now = 700_000;

    expect(plane.pruneTombstones()).toBe(2);
  });

  it('prunes a tombstone after its absolute lifetime expires', () => {
    let now = 0;
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => now);
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence({ 'row-1': { at: 0 } }));
    plane.hydrate();
    now = 24 * 60 * 60 * 1000 + 1;

    expect(plane.pruneTombstones()).toBe(1);
  });

  it('keeps every tombstone while the map sits exactly at the cap', () => {
    let now = 0;
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => now);
    const tombstones = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`row-${index}`, { at: 0 }]));
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence(tombstones));
    plane.hydrate();
    now = 700_000;

    // The cap is a ceiling, not a target: at the ceiling nothing is evicted.
    expect(plane.pruneTombstones()).toBe(0);
    expect(plane.isTombstoned('row-0')).toBe(true);
  });

  it('[P18] evicts the oldest tombstones first and protects the young ones above the cap', () => {
    let now = 0;
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => now);
    // Three ages, inserted NEWEST-FIRST so insertion order contradicts age order: only an
    // age-ordered eviction can pick the right victims.
    const tombstones: Record<string, { at: number }> = {};
    for (let index = 0; index < 3; index += 1) tombstones[`young-${index}`] = { at: 699_000 };
    for (let index = 0; index < 5_000; index += 1) tombstones[`mid-${index}`] = { at: 50_000 };
    for (let index = 0; index < 5_000; index += 1) tombstones[`ancient-${index}`] = { at: index };
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence(tombstones));
    plane.hydrate();
    now = 700_000;

    expect(plane.pruneTombstones()).toBe(3);
    // Oldest-first: the three lowest timestamps go, regardless of where they sit in the map.
    expect(plane.isTombstoned('ancient-0')).toBe(false);
    expect(plane.isTombstoned('ancient-1')).toBe(false);
    expect(plane.isTombstoned('ancient-2')).toBe(false);
    expect(plane.isTombstoned('ancient-3')).toBe(true);
    expect(plane.isTombstoned('mid-0')).toBe(true);
    expect(plane.isTombstoned('young-0')).toBe(true);
  });

  it('keeps a tombstone that is younger than the protection window even above the cap', () => {
    let now = 0;
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => now);
    const tombstones = Object.fromEntries(Array.from({ length: 10_003 }, (_, index) => [`row-${index}`, { at: 699_500 }]));
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence(tombstones));
    plane.hydrate();
    now = 700_000;

    // Every entry is inside the protection window: the cap alone may not evict a fresh delete,
    // because a young tombstone is what keeps a late server row from resurrecting.
    expect(plane.pruneTombstones()).toBe(0);
    expect(plane.isTombstoned('row-0')).toBe(true);
  });

  it('keeps a tombstone whose age has exactly reached the absolute lifetime', () => {
    let now = 0;
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => now);
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence({ 'row-1': { at: 0 } }));
    plane.hydrate();
    now = 24 * 60 * 60 * 1000;

    // Expiry is strict: at the boundary the protection still holds.
    expect(plane.pruneTombstones()).toBe(0);
    expect(plane.isTombstoned('row-1')).toBe(true);
  });

  it('uses the overflow valve for a large young tombstone burst', () => {
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => 1_000);
    const tombstones = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`row-${index}`, { at: 1_000 }]));
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence(tombstones));
    plane.hydrate();

    expect(plane.pruneTombstones()).toBe(10_001);
  });

  it('evicts the oldest entries first when the overflow valve fires', () => {
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => 1_000);
    // Newest generation FIRST in the map: an unordered valve would shed exactly the wrong entries.
    const tombstones: Record<string, { at: number }> = {};
    for (let index = 0; index < 10_000; index += 1) tombstones[`newer-${index}`] = { at: 900 };
    for (let index = 0; index < 10_001; index += 1) tombstones[`older-${index}`] = { at: 500 };
    storage.set(compositeStorageKey(prefix, 'tombstones', modelId), encodePersistence(tombstones));
    plane.hydrate();

    expect(plane.pruneTombstones()).toBe(10_001);
    // The valve sheds pressure oldest-first: every survivor is from the newer generation.
    expect(plane.isTombstoned('older-0')).toBe(false);
    expect(plane.isTombstoned('older-10000')).toBe(false);
    expect(plane.isTombstoned('newer-0')).toBe(true);
    expect(plane.isTombstoned('newer-9999')).toBe(true);
  });
});

import {
  compositeStorageKey,
  createEntityPlane,
  encodePersistence,
  runInApplyBatch,
  type StoragePlane
} from '../../legacyTestApi';
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

  it('drops missing and corrupt persisted rows and corrupt tombstones during hydrate', () => {
    const values = new Map<string, string>();
    let rowsPrefix = '';
    const storage: StoragePlane = {
      get: key => values.get(key),
      set: entries => {
        for (const entry of entries) {
          if (entry.value === null) values.delete(entry.key);
          else values.set(entry.key, entry.value);
        }
      },
      keys: requestedPrefix => {
        rowsPrefix = requestedPrefix;
        return [`${requestedPrefix}${compositeStorageKey('', '', 'missing').slice(1)}`, ...[...values.keys()].filter(key => key.startsWith(requestedPrefix))];
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
    storage.set([
      {
        key: compositeStorageKey(prefix, 'row', modelId, 'row-1'),
        value: encodePersistence({ id: 'row-1', label: 'persisted' })
      }
    ]);

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
    storage.set([{ key: compositeStorageKey(prefix, 'tombstones', modelId), value: encodePersistence(tombstones) }]);
    plane.hydrate();
    now = 700_000;

    expect(plane.pruneTombstones()).toBe(2);
  });

  it('prunes a tombstone after its absolute lifetime expires', () => {
    let now = 0;
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => now);
    storage.set([
      {
        key: compositeStorageKey(prefix, 'tombstones', modelId),
        value: encodePersistence({ 'row-1': { at: 0 } })
      }
    ]);
    plane.hydrate();
    now = 24 * 60 * 60 * 1000 + 1;

    expect(plane.pruneTombstones()).toBe(1);
  });

  it('uses the overflow valve for a large young tombstone burst', () => {
    const storage = createMemoryPlane();
    const { modelId, plane } = createPlane(storage, () => 1_000);
    const tombstones = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`row-${index}`, { at: 1_000 }]));
    storage.set([{ key: compositeStorageKey(prefix, 'tombstones', modelId), value: encodePersistence(tombstones) }]);
    plane.hydrate();

    expect(plane.pruneTombstones()).toBe(10_001);
  });
});

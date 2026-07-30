import { act } from 'react';
import { configureDb, defineModelRuntime, f, resetRuntime } from '../../testApi';
import { createScopeIndex, isScopeIndexValue } from '../../../core/planes/scopeIndex';
import { compositeKey, compositeStorageKey } from '../../../core/serialize';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type ScopeRow = { id: string; bucket: string; rank: number; label: string };
const createScopeModel = (orderFields?: ReadonlyArray<keyof ScopeRow & string>, onCompare?: () => void) =>
  defineModelRuntime({
    id: 'SpecIntegrityScopeOrderReset',
    name: 'SpecIntegrityScopeOrderReset',
    fields: {
      id: f.str(),
      bucket: f.str(),
      rank: f.num(),
      label: f.str()
    },
    scopes: {
      byBucket: ({
        by: { bucket: 'bucket' },
        sort: {
          comparator: (left: ScopeRow, right: ScopeRow) => {
            onCompare?.();
            return left.rank - right.rank;
          },
          ...(orderFields === undefined ? {} : { orderFields })
        }
      })
    }
  });

describe('scope order cache reset contract', () => {
  beforeEach(() => {
    resetRuntime();
  });

  it('rebuilds comparator scope membership from fresh rows after resetRuntime', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const rows = createScopeModel();

    act(() => {
      rows.scopes.byBucket.seed({ bucket: 'shared' }, [
        { id: 'a-2', bucket: 'shared', rank: 2, label: 'two' },
        { id: 'a-1', bucket: 'shared', rank: 1, label: 'one' }
      ]);
    });
    const initialReader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));
    expect(initialReader.result().map(row => row.id)).toEqual(['a-1', 'a-2']);
    initialReader.unmount();

    act(() => {
      resetRuntime();
      rows.scopes.byBucket.seed({ bucket: 'shared' }, [
        { id: 'b-3', bucket: 'shared', rank: 3, label: 'three' },
        { id: 'b-1', bucket: 'shared', rank: 1, label: 'one' }
      ]);
    });
    const freshReader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));

    expect(freshReader.result().map(row => row.id)).toEqual(['b-1', 'b-3']);
    freshReader.unmount();
  });

  it('keeps an orderFields comparator scope projection stable for a non-order member patch', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const rows = createScopeModel(['rank']);
    act(() => {
      rows.scopes.byBucket.seed({ bucket: 'shared' }, [
        { id: 'row-2', bucket: 'shared', rank: 2, label: 'two' },
        { id: 'row-1', bucket: 'shared', rank: 1, label: 'one' }
      ]);
    });
    const reader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }, { renderKeys: ['rank'] }));
    const before = reader.result();
    const renders = reader.renders();

    act(() => {
      rows.update('row-1', { label: 'updated' });
    });

    expect(reader.result()).toBe(before);
    expect(reader.result().map(row => row.id)).toEqual(['row-1', 'row-2']);
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });

  it('resorts an orderFields comparator scope when an order field changes', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    let comparisons = 0;
    const rows = createScopeModel(['rank'], () => {
      comparisons += 1;
    });
    act(() => {
      rows.scopes.byBucket.seed({ bucket: 'shared' }, [
        { id: 'row-2', bucket: 'shared', rank: 2, label: 'two' },
        { id: 'row-1', bucket: 'shared', rank: 1, label: 'one' }
      ]);
    });
    const reader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));
    expect(reader.result().map(row => row.id)).toEqual(['row-1', 'row-2']);
    const before = comparisons;

    act(() => {
      rows.update('row-1', { rank: 3 });
    });

    expect(comparisons).toBeGreaterThan(before);
    expect(rows.scopes.byBucket.read({ bucket: 'shared' }).map(row => row.id)).toEqual(['row-2', 'row-1']);
    reader.unmount();
  });

  it('keeps comparator scopes without orderFields conservatively resorting on member patches', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    let comparisons = 0;
    const rows = createScopeModel(undefined, () => {
      comparisons += 1;
    });
    act(() => {
      rows.scopes.byBucket.seed({ bucket: 'shared' }, [
        { id: 'row-2', bucket: 'shared', rank: 2, label: 'two' },
        { id: 'row-1', bucket: 'shared', rank: 1, label: 'one' }
      ]);
    });
    const reader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }, { renderKeys: ['rank'] }));
    const before = comparisons;

    act(() => {
      rows.update('row-1', { label: 'updated' });
    });

    expect(comparisons).toBeGreaterThan(before);
    reader.unmount();
  });

  it('updates an orderFields comparator scope for membership append and detach', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const rows = createScopeModel(['rank']);
    act(() => {
      rows.insert({ id: 'row-1', bucket: 'shared', rank: 1, label: 'one' });
      rows.insert({ id: 'row-3', bucket: 'shared', rank: 3, label: 'three' });
    });
    const reader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));

    act(() => {
      rows.insert({ id: 'row-2', bucket: 'shared', rank: 2, label: 'two' });
    });
    expect(reader.result().map(row => row.id)).toEqual(['row-1', 'row-2', 'row-3']);
    act(() => {
      rows.update('row-2', { bucket: 'other' });
    });

    expect(reader.result().map(row => row.id)).toEqual(['row-1', 'row-3']);
    reader.unmount();
  });

  it('K1/K2 reconciles, trims, and evicts scope keys without retaining departed reverse memberships', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeReverseIndex', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeA = compositeKey('byBucket', '{"bucket":"a"}');
    const scopeB = compositeKey('byBucket', '{"bucket":"b"}');
    const land = (key: string, ids: string[]) =>
      index.write(
        key,
        index.reconcileNext(
          key,
          'complete',
          ids.map(id => ({ id }))
        ).next
      );

    land(scopeA, ['row-1', 'row-2']);
    land(scopeB, ['row-1']);
    land(scopeA, ['row-2']);
    expect(index.keysOf('row-1')).toEqual([scopeB]);

    land(scopeA, ['row-1', 'row-2']);
    index.write(scopeA, index.trimValue(index.read(scopeA), 0).next);
    expect(index.keysOf('row-1')).toEqual([scopeB]);

    land(scopeA, ['row-1']);
    index.remove(scopeA);
    expect(index.keysOf('row-1')).toEqual([scopeB]);
  });

  it('K3 removes the final reverse membership through the destroy detach path', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeReverseIndexDestroy', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = compositeKey('byBucket', '{"bucket":"destroy"}');

    index.write(scopeKey, index.reconcileNext(scopeKey, 'complete', [{ id: 'row-1' }]).next);
    index.detach(scopeKey, ['row-1']);

    expect(index.keysOf('row-1')).toEqual([]);
  });

  it('keeps the order revision stable for an unchanged complete order', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeOrderRevision', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = compositeKey('byBucket', '{"bucket":"stable"}');

    index.write(scopeKey, index.reconcileNext(scopeKey, 'complete', [{ id: 'row-1' }, { id: 'row-2' }]).next);
    const revision = index.orderRevision(scopeKey);
    index.write(scopeKey, index.reconcileNext(scopeKey, 'complete', [{ id: 'row-1' }, { id: 'row-2' }]).next);

    expect(index.orderRevision(scopeKey)).toBe(revision);
  });

  it.each(['delta', 'page'] as const)('deduplicates repeated incoming ids during %s reconciliation with the last payload value', coverage => {
    const index = createScopeIndex({ modelId: `SpecIntegrityScopeDedup${coverage}`, storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = compositeKey('byBucket', `{"bucket":"${coverage}"}`);
    index.write(scopeKey, index.reconcileNext(scopeKey, 'complete', [{ id: 'row-1' }]).next);

    const next = index.reconcileNext(scopeKey, coverage, [{ id: 'row-2' }, { id: 'row-2' }, { id: 'row-3' }]).next;
    index.write(scopeKey, next);

    expect(index.read(scopeKey).entries.map(entry => entry.id)).toEqual(['row-1', 'row-2', 'row-3']);
  });

  it('deduplicates repeated ids before applying a scope delta', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeApplyDedup', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = compositeKey('byBucket', '{"bucket":"apply"}');

    index.applyDelta(
      scopeKey,
      [
        { id: 'row-1', orderKey: 'V' },
        { id: 'row-1', orderKey: 'W' }
      ],
      []
    );

    expect(index.read(scopeKey).entries).toEqual([{ id: 'row-1', orderKey: 'W' }]);
  });

  it('validates generated scope values and rejects malformed reconciliation input', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeValidation', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = compositeKey('byBucket', '{"bucket":"invalid"}');

    expect(isScopeIndexValue(null)).toBe(false);
    expect(() => index.reconcileNext(scopeKey, 'complete', [{ id: '' }])).toThrow(
      `Invalid scope index value for SpecIntegrityScopeValidation:${scopeKey}`
    );
  });

  it('enforces staged apply lifecycle and projects staged writes and removals', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeStaging', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const removedKey = compositeKey('byBucket', '{"bucket":"removed"}');
    const retainedKey = compositeKey('byBucket', '{"bucket":"retained"}');
    index.write(removedKey, index.reconcileNext(removedKey, 'complete', [{ id: 'row-1' }]).next);

    index.beginApply();
    expect(() => index.beginApply()).toThrow('Scope apply already active for SpecIntegrityScopeStaging');
    index.remove(removedKey);
    index.write(retainedKey, index.reconcileNext(retainedKey, 'complete', [{ id: 'row-2' }]).next);
    expect(index.read(removedKey).entries).toEqual([]);
    expect(new Set(index.keys())).toEqual(new Set([retainedKey]));
    index.commitApply();

    expect(index.keys()).toEqual([retainedKey]);
    expect(index.keysOf('row-1')).toEqual([]);
    expect(index.keysOf('row-2')).toEqual([retainedKey]);
    expect(() => index.commitApply()).toThrow('Scope apply is not active for SpecIntegrityScopeStaging');
  });

  it('keeps no-op trims and missing-scope detaches empty', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeNoops', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = compositeKey('byBucket', '{"bucket":"noop"}');
    const value = index.reconcileNext(scopeKey, 'complete', [{ id: 'row-1' }]).next;
    index.write(scopeKey, value);

    expect(index.trimValue(value, 2)).toEqual({ next: value, trimmedIds: [] });
    expect(index.detach('missing', ['row-1']).entries).toEqual([]);
    expect(index.applyDelta(scopeKey, [], ['row-1']).entries).toEqual([]);
  });

  it('drops malformed persisted keys and skips vanished storage values during hydrate', () => {
    const modelId = 'SpecIntegrityScopeHydrateEdges';
    const storage = createMemoryPlane();
    const scopeKey = compositeKey('byBucket', '{"bucket":"stale"}');
    const staleKey = compositeStorageKey('dbl:', 'scope', modelId, 'not-a-scope-key');
    const malformedKey = `${compositeStorageKey('dbl:', 'scope', modelId)}not-encoded`;
    storage.set([
      { key: staleKey, value: 'corrupt' },
      { key: malformedKey, value: 'corrupt' }
    ]);
    const originalKeys = storage.keys.bind(storage);
    const vanishedKey = `${compositeStorageKey('dbl:', 'scope', modelId)}vanished`;
    storage.keys = prefix => [...originalKeys(prefix), vanishedKey];
    const index = createScopeIndex({ modelId, scopeNames: ['byBucket'], storage, prefix: () => 'dbl:' });

    index.hydrate();

    expect(storage.get(staleKey)).toBeUndefined();
    expect(storage.get(malformedKey)).toBeUndefined();
    expect(index.read(scopeKey).entries).toEqual([]);
  });
});

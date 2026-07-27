import { act } from 'react-test-renderer';
import { configureDb, defineModel, f, resetRuntime, scope } from '../../../index';
import { createScopeIndex } from '../../../core/planes/scopeIndex';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type ScopeRow = { id: string; bucket: string; rank: number; label: string };
const createScopeModel = (orderFields?: ReadonlyArray<keyof ScopeRow & string>, onCompare?: () => void) =>
  defineModel({
    id: 'SpecIntegrityScopeOrderReset',
    name: 'SpecIntegrityScopeOrderReset',
    fields: {
      id: f.str(),
      bucket: f.str(),
      rank: f.num(),
      label: f.str()
    },
    scopes: {
      byBucket: scope<ScopeRow>({
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
      rows.scopes.byBucket.seed(
        { bucket: 'shared' },
        [
          { id: 'a-2', bucket: 'shared', rank: 2, label: 'two' },
          { id: 'a-1', bucket: 'shared', rank: 1, label: 'one' }
        ]
      );
    });
    const initialReader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));
    expect(initialReader.result().map(row => row.id)).toEqual(['a-1', 'a-2']);
    initialReader.unmount();

    act(() => {
      resetRuntime();
      rows.scopes.byBucket.seed(
        { bucket: 'shared' },
        [
          { id: 'b-3', bucket: 'shared', rank: 3, label: 'three' },
          { id: 'b-1', bucket: 'shared', rank: 1, label: 'one' }
        ]
      );
    });
    const freshReader = renderCounted(() => rows.scopes.byBucket.use({ bucket: 'shared' }));

    expect(freshReader.result().map(row => row.id)).toEqual(['b-1', 'b-3']);
    freshReader.unmount();
  });

  it('keeps an orderFields comparator scope projection stable for a non-order member patch', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const rows = createScopeModel(['rank']);
    act(() => {
      rows.scopes.byBucket.seed(
        { bucket: 'shared' },
        [
          { id: 'row-2', bucket: 'shared', rank: 2, label: 'two' },
          { id: 'row-1', bucket: 'shared', rank: 1, label: 'one' }
        ]
      );
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
      rows.scopes.byBucket.seed(
        { bucket: 'shared' },
        [
          { id: 'row-2', bucket: 'shared', rank: 2, label: 'two' },
          { id: 'row-1', bucket: 'shared', rank: 1, label: 'one' }
        ]
      );
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
      rows.scopes.byBucket.seed(
        { bucket: 'shared' },
        [
          { id: 'row-2', bucket: 'shared', rank: 2, label: 'two' },
          { id: 'row-1', bucket: 'shared', rank: 1, label: 'one' }
        ]
      );
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
    const scopeA = 'byBucket\0{"bucket":"a"}';
    const scopeB = 'byBucket\0{"bucket":"b"}';

    index.reconcile(scopeA, 'complete', [{ id: 'row-1' }, { id: 'row-2' }]);
    index.reconcile(scopeB, 'complete', [{ id: 'row-1' }]);
    index.reconcile(scopeA, 'complete', [{ id: 'row-2' }]);
    expect(index.keysOf('row-1')).toEqual([scopeB]);

    index.reconcile(scopeA, 'complete', [{ id: 'row-1' }, { id: 'row-2' }]);
    index.trim(scopeA, 0);
    expect(index.keysOf('row-1')).toEqual([scopeB]);

    index.reconcile(scopeA, 'complete', [{ id: 'row-1' }]);
    index.remove(scopeA);
    expect(index.keysOf('row-1')).toEqual([scopeB]);

  });

  it('K3 removes the final reverse membership through the destroy detach path', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeReverseIndexDestroy', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = 'byBucket\0{"bucket":"destroy"}';

    index.reconcile(scopeKey, 'complete', [{ id: 'row-1' }]);
    index.detach(scopeKey, ['row-1']);

    expect(index.keysOf('row-1')).toEqual([]);
  });

  it('keeps the order revision stable for an unchanged complete order', () => {
    const index = createScopeIndex({ modelId: 'SpecIntegrityScopeOrderRevision', storage: createMemoryPlane(), prefix: () => 'dbl:' });
    const scopeKey = 'byBucket\0{"bucket":"stable"}';

    index.reconcile(scopeKey, 'complete', [{ id: 'row-1' }, { id: 'row-2' }]);
    const revision = index.orderRevision(scopeKey);
    index.reconcile(scopeKey, 'complete', [{ id: 'row-1' }, { id: 'row-2' }]);

    expect(index.orderRevision(scopeKey)).toBe(revision);
  });
});

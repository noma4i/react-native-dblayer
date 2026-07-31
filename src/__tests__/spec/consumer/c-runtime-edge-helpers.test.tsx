import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import {
  arraysShallowEqual,
  configureDb,
  compositeKey,
  computePhase,
  createModelReadEngine,
  createModelContext,
  createModelCriteria,
  createModelScopeKeys,
  createProjectionGate,
  defineModelRuntime,
  f,
  getCommitBus,
  getDbRuntimeConfig,
  getDbQueryClient,
  isFetchedResult,
  limitRows,
  isTempRowProtectedByModel,
  refetchActiveFetchReaders,
  registerActiveFetchReaders,
  registerMaterializationReconciler,
  resetRuntime,
  rowsShallowEqual,
  resumeFetchReaders,
  purgeForeignStorageKeys,
  suspendDb,
  sortModelReadRows,
  useLiveRead,
  useMergedScopeRows
} from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('runtime edge helpers', () => {
  it('short-circuits shallow array comparison when both references are identical', () => {
    const rows = [{ id: 'same' }];
    const equals = jest.fn(() => true);
    expect(arraysShallowEqual(rows, rows, equals)).toBe(true);
    expect(equals).not.toHaveBeenCalled();
  });

  it('ignores loss notifications before runtime configuration', () => {
    expect(() => getDbRuntimeConfig()).toThrow('configureDb must be called');
    expect(() => suspendDb()).not.toThrow();
    expect(() =>
      getCommitBus().publish({
        rows: [{ model: 'Rows', id: 'row-1', fields: null, kind: 'destroy' }],
        scopes: [],
        pending: [],
        scopeChanges: []
      })
    ).not.toThrow();
  });

  it('purges foreign storage keys and executes model-owned fetch definitions', async () => {
    const storage = createMemoryPlane();
    storage.set([{ key: 'foreign', value: 'value' }]);
    configureDb({ storage, transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'RuntimeEdgeFetchModel',
      name: 'RuntimeEdgeFetchModel',
      fields: { label: f.str() }
    });
    const defaultKey = model.fetch<{ value: string }, string, string>('default', {
      fetcher: async input => ({ value: input }),
      select: data => data.value
    });
    const explicitKey = model.fetch<{ value: string }, string, string>('explicit', {
      key: 'runtime-edge-explicit-fetch',
      fetcher: async input => ({ value: input }),
      select: data => data.value
    });

    expect(purgeForeignStorageKeys()).toBe(1);
    expect(storage.get('foreign')).toBeUndefined();
    await expect(defaultKey.fetch('default-value')).resolves.toBe('default-value');
    await expect(explicitKey.fetch('explicit-value')).resolves.toBe('explicit-value');
    expect(getDbQueryClient().getQueryCache().getAll().map(query => query.queryKey)).toEqual(
      expect.arrayContaining([
        [`fetch:${compositeKey(model.modelId, 'default')}`, expect.any(String)],
        ['fetch:runtime-edge-explicit-fetch', expect.any(String)]
      ])
    );
  });

  it('memoizes model relations after their first resolution', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const relations = jest.fn(() => ({}));
    const context = createModelContext({
      modelId: 'SpecRuntimeEdgeContext',
      scopeNames: [],
      relations,
      applyWriteGate: (_previous, incoming) => incoming
    });

    expect(context.resolvedRelations()).toBe(context.resolvedRelations());
    expect(relations).toHaveBeenCalledTimes(1);
    expect(context.revision()).toBe(0);
    context.bumpRevision();
    expect(context.revision()).toBe(1);
  });

  it('classifies an error-only observer result as fetched', () => {
    expect(isFetchedResult({ dataUpdatedAt: 0, errorUpdatedAt: 1 })).toBe(true);
    expect(isFetchedResult({ dataUpdatedAt: 0, errorUpdatedAt: 0 })).toBe(false);
    expect(
      computePhase({
        isInactive: false,
        isError: true,
        hasFetchedData: false,
        hasData: false,
        isFetching: false,
        isPaused: false,
        committedRowsDied: false,
        isRefreshing: false,
        isFetchingNextPage: false,
        retryAttempt: 0
      })
    ).toBe('error');
  });

  it('reuses projected rows when equivalent render-key arrays are recreated', () => {
    const gate = createProjectionGate<{ id: string; label: string }, { id: string; label: string }>();
    let labelReads = 0;
    const row = {
      id: 'row-1',
      get label() {
        labelReads += 1;
        return 'first';
      }
    };
    const rows = [row];
    const keys = ['label'] as const;
    const first = gate.projectRows(rows, { renderKeys: keys });
    const readsAfterFirst = labelReads;
    const second = gate.projectRows(rows, { renderKeys: keys });
    const equalKeys = gate.projectRows(rows, { renderKeys: ['label'] });

    expect(second).toBe(first);
    expect(equalKeys).toBe(first);
    expect(labelReads).toBe(readsAfterFirst);

    const withoutKeys = gate.projectRows(rows, {});
    const emptyKeys = gate.projectRows(rows, { renderKeys: [] });
    expect(emptyKeys).toBe(withoutKeys);
    expect(gate.projectRows(rows, { renderKeys: ['label'] })).toBe(withoutKeys);
  });

  it('recomputes a live read between render and subscription and accepts pending dependencies', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    let calls = 0;
    let latest = 0;
    const Probe = () => {
      latest = useLiveRead(
        () => {
          calls += 1;
          return calls;
        },
        [{ kind: 'pending', model: 'RuntimeEdgeRows', id: 'row-1' }]
      );
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Probe));
    });
    expect(latest).toBeGreaterThan(1);
    act(() => root.unmount());
  });

  it('compares row arrays shallowly and applies bounded model read ordering', () => {
    const shared = { id: 'nested' };
    expect(rowsShallowEqual({ values: [shared], label: 'x' }, { values: [shared], label: 'x' })).toBe(true);
    expect(rowsShallowEqual({ values: [shared] }, { values: [{ id: 'nested' }] })).toBe(false);
    expect(rowsShallowEqual({ label: 'x' }, { label: 'y', extra: true })).toBe(false);
    expect(limitRows([1, 2], undefined)).toEqual([1, 2]);
    expect(limitRows([1, 2], -1)).toEqual([]);
    expect(
      sortModelReadRows(
        [
          { id: 'b', rank: 2 },
          { id: 'a', rank: 1 }
        ],
        [{ field: 'rank', direction: 'asc' }],
        1
      )
    ).toEqual([{ id: 'a', rank: 1 }]);
  });

  it('updates row and count engines across membership, value, and rebuild transitions', () => {
    const rows = new Map([
      ['a', { id: 'a', rank: 1, visible: true }],
      ['b', { id: 'b', rank: 2, visible: false }]
    ]);
    const engine = createModelReadEngine({
      signature: 'runtime-edge-engine',
      model: 'RuntimeEdgeRows',
      where: row => row.visible,
      options: { orderBy: [{ field: 'rank', direction: 'asc' }] },
      initial: () => [...rows.values()],
      read: id => rows.get(id),
      select: selected => selected.map(row => row.id)
    });
    const batch = (id: string, fields: string[] | null = null) =>
      ({
        rows: [{ model: 'RuntimeEdgeRows', id, fields, kind: 'update' }],
        scopes: [],
        pending: [],
        scopeChanges: []
      });

    expect(engine.value).toEqual(['a']);
    expect(engine.apply(batch('missing') as never)).toBe(false);
    rows.set('b', { id: 'b', rank: 0, visible: true });
    expect(engine.apply(batch('b') as never)).toBe(true);
    expect(engine.value).toEqual(['b', 'a']);
    rows.set('a', { id: 'a', rank: 3, visible: true });
    expect(engine.apply(batch('a', ['rank']) as never)).toBe(false);
    rows.set('a', { id: 'a', rank: -1, visible: true });
    expect(engine.apply(batch('a', ['rank']) as never)).toBe(true);
    rows.set('a', { id: 'a', rank: 3, visible: false });
    expect(engine.apply(batch('a') as never)).toBe(true);
    expect(engine.apply({ ...batch('b'), mode: 'bulk' } as never)).toBe(true);

    const count = createModelReadEngine({
      signature: 'runtime-edge-count',
      model: 'RuntimeEdgeRows',
      where: row => row.visible,
      countOnly: true,
      initial: () => [...rows.values()],
      read: id => rows.get(id),
      select: (_selected, size) => size
    });
    expect(count.value).toBe(1);
    expect(count.apply(batch('b', []) as never)).toBe(false);
  });

  it('reports an absent maintenance owner as unprotected', () => {
    expect(isTempRowProtectedByModel('MissingMaintenanceModel', 'tmp:1')).toBe(false);
  });

  it('derives missing scope fields through the declared field reader', () => {
    const fields = {
      source: f.str(),
      derived: f.custom<string, { source?: string }>(input => input.source)
    };
    const scopeKeys = createModelScopeKeys(
      { name: 'SpecRuntimeEdgeScopeKeys', fields },
      new Map([['byDerived', { value: 'derived' }]])
    );

    expect(scopeKeys.scopeValueFromRow({ value: 'derived' }, { source: 'value' })).toEqual({ value: 'value' });
    expect(scopeKeys.scopeValueFromRow({ value: 'derived' }, { source: 'source', derived: 'stored' })).toEqual({ value: 'stored' });
  });

  it('normalizes nested logical criteria and unknown fields', () => {
    const criteria = createModelCriteria<{ id: string; count: number; raw: string }>({ id: f.id(), count: f.num() });
    const row = { id: '7', count: 2, raw: 'value' };

    expect(criteria.matches(row, { and: [null as never, { id: 7 as never }, { raw: 'value' }] } as never)).toBe(true);
    expect(criteria.matches(row, { count: { in: [2] } } as never)).toBe(true);
    expect(criteria.matches(row, null as never)).toBe(true);
  });

  it('contains reader refetch failures, respects cancellation, and clears readers on reset', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const refetch = jest.fn(async () => {
      throw new Error('refetch failed');
    });
    const release = registerActiveFetchReaders({
      queryKey: ['runtime-edge', 'reader'],
      markResumeStale: () => true,
      refetch
    });

    refetchActiveFetchReaders(['runtime-edge', 'reader']);
    await Promise.resolve();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(await resumeFetchReaders(1, () => false)).toBe(0);
    expect(await resumeFetchReaders(1, () => true)).toBe(1);

    resetRuntime();
    refetchActiveFetchReaders(['runtime-edge', 'reader']);
    await Promise.resolve();
    expect(refetch).toHaveBeenCalledTimes(2);
    release();
  });

  it('contains a rejected loss-driven refetch', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const queryKey = ['runtime-edge', 'loss'];
    getDbQueryClient().setQueryData(queryKey, {
      ids: [compositeKey('Rows', 'row-1')],
      lastCount: 1,
      cursor: null,
      pages: 1,
      hasNextPage: false,
      resultKind: 'one'
    });
    const refetch = jest.fn(async () => {
      throw new Error('loss refetch failed');
    });
    const release = registerActiveFetchReaders({ queryKey, markResumeStale: () => false, refetch });
    // Materialization loss is judged per registered chain: an unregistered cache entry that merely
    // looks like a chain is never pruned, so the reader is reached through its own registration.
    const releaseChain = registerMaterializationReconciler({
      modelId: 'Rows',
      chains: () => [{ queryKey, scopeKey: null, materialized: () => new Set<string>() }]
    });

    getCommitBus().publish({
      rows: [{ model: 'Rows', id: 'row-1', fields: null, kind: 'destroy' }],
      scopes: [],
      pending: [],
      scopeChanges: []
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(refetch).toHaveBeenCalledTimes(1);
    releaseChain();
    release();
  });
});

describe('merged scope rows memo', () => {
  it('returns the previous result for identical input identities', () => {
    const base = [{ id: 'row-1' }];
    const extras = [{ id: 'row-2' }];
    let latest: ReadonlyArray<{ id: string }> = [];
    const Probe = (_props: { tick: number }) => {
      latest = useMergedScopeRows(base, extras);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Probe, { tick: 0 }));
    });
    const first = latest;
    act(() => root.update(React.createElement(Probe, { tick: 1 })));
    expect(latest).toBe(first);
    act(() => root.unmount());
  });

  it('deduplicates extras, sorts with a comparator, and reuses equivalent output', () => {
    const rowA = { id: 'a', rank: 1 };
    const rowB = { id: 'b', rank: 2 };
    let base = [rowB];
    let extras = [
      rowB,
      rowA
    ];
    const comparator = (left: { rank: number }, right: { rank: number }) => left.rank - right.rank;
    let latest: ReadonlyArray<{ id: string; rank: number }> = [];
    const Probe = () => {
      latest = useMergedScopeRows(base, extras, { comparator });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Probe));
    });
    expect(latest.map(row => row.id)).toEqual(['a', 'b']);
    const first = latest;
    base = [rowB];
    extras = [rowA];
    act(() => root.update(React.createElement(Probe)));
    expect(latest).toBe(first);
    extras = [];
    act(() => root.update(React.createElement(Probe)));
    expect(latest.map(row => row.id)).toEqual(['b']);
    act(() => root.unmount());
  });
});

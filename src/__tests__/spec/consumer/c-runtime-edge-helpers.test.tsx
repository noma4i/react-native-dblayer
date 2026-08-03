import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import {
  arraysShallowEqual,
  configureDb,
  compositeKey,
  computePhase,
  createCommitEnvelope,
  createModelContext,
  createModelCriteria,
  createModelScopeKeys,
  createProjectionGate,
  defineModel,
  defineShape,
  f,
  getCommitBus,
  getDbRuntimeConfig,
  getDbQueryClient,
  getApplyRuntime,
  isFetchedResult,
  limitRows,
  isTempRowProtectedByModel,
  refetchActiveFetchReaders,
  registerActiveFetchReaders,
  registerMaterializationReconciler,
  resetRuntime,
  rowsShallowEqual,
  resumeFetchReaders,
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

  it('memoizes model relations after their first resolution', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const relations = jest.fn(() => ({}));
    const context = createModelContext({
      modelId: 'SpecRuntimeEdgeContext',
      scopeNames: [],
      relations,
      applyWriteGate: (_previous, incoming) => incoming
    });

    const resolvedRelations = context.resolvedRelations();
    expect(context.resolvedRelations()).toBe(resolvedRelations);
    expect(relations).toHaveBeenCalledTimes(1);
  });

  it('enforces revision apply boundaries and filters fields newer than a response', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const context = createModelContext<{ id: string; changed?: string; removed?: string; untouched?: string }>({
      modelId: 'SpecRuntimeEdgeRevisions',
      scopeNames: [],
      relations: () => ({}),
      applyWriteGate: (_previous, incoming) => incoming
    });
    const revisions = context.revisions;

    expect(() => revisions.notePut('row-1', ['changed'], false)).toThrow('revision apply is not active');
    expect(() => revisions.noteDestroy('row-1')).toThrow('revision apply is not active');
    expect(() => revisions.commitApply()).toThrow('revision apply is not active');

    revisions.beginApply(2);
    expect(() => revisions.beginApply(3)).toThrow('revision apply already active');
    revisions.notePut('row-1', ['changed', 'removed'], false);
    revisions.commitApply();

    expect(revisions.admitRow({ id: 'row-1', changed: 'remote' }, undefined, 1)).toBeNull();
    expect(revisions.admitRow({ id: 'row-1', changed: 'remote', removed: 'remote' }, { id: 'row-1', changed: 'local' }, 1)).toEqual({
      id: 'row-1',
      changed: 'local'
    });
    expect(revisions.admitPatch('row-2', { changed: 'remote' }, [], { id: 'row-2' }, 1)).toEqual({
      patch: { changed: 'remote' },
      remove: []
    });
    expect(revisions.admitPatch('row-1', { changed: 'remote' }, ['removed'], { id: 'row-1', changed: 'local' }, 1)).toBeNull();
    expect(
      revisions.admitPatch(
        'row-1',
        { changed: 'remote', untouched: 'accepted' },
        ['removed', 'absent'],
        { id: 'row-1', changed: 'local', removed: 'local' },
        1
      )
    ).toEqual({ patch: { untouched: 'accepted' }, remove: ['absent'] });

    revisions.beginApply(3);
    revisions.noteDestroy('row-3');
    revisions.commitApply();
    expect(revisions.admitPatch('row-3', { changed: 'remote' }, [], { id: 'row-3' }, 2)).toBeNull();
    expect(revisions.admitDestroy('row-3', 2)).toBe(false);
    expect(revisions.admitDestroy('row-3', undefined)).toBe(true);
  });

  it('applies explicit field removal through the shared commit planner', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const schema = defineShape<{ id: string; retained: string; removed?: string }>()({
      retained: f.str(),
      removed: f.str().optional()
    });
    const Model = defineModel('SpecRuntimeEdgeRemove', { schema });
    Model.insert({ id: 'row-1', retained: 'retained', removed: 'remove-me' });

    getApplyRuntime().commit(
      createCommitEnvelope([
        { kind: 'patch', model: Model.key, id: 'row-1', patch: {}, remove: ['removed'] }
      ])
    );

    expect(Model.find('row-1')).toEqual({ id: 'row-1', retained: 'retained' });
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
    expect(gate.projectValue('direct', { version: 1 }, { id: 'direct', label: 'value' })).toEqual({ id: 'direct', label: 'value' });
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

  it('accepts a scope dependency in the shared live-read signature', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Probe = () => {
      useLiveRead(() => 1, [{ kind: 'scope', model: 'RuntimeScopeRows', scopeKey: 'scope-1' }]);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(Probe));
    });
    expect(root.toJSON()).toBeNull();
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

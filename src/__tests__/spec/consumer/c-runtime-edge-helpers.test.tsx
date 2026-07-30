import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import {
  configureDb,
  compositeKey,
  computePhase,
  createModelContext,
  createModelCriteria,
  createModelScopeKeys,
  createProjectionGate,
  f,
  getCommitBus,
  getDbQueryClient,
  isFetchedResult,
  isTempRowProtectedByModel,
  refetchActiveFetchReaders,
  registerActiveFetchReaders,
  resetRuntime,
  resumeFetchReaders,
  suspendDb,
  useMergedScopeRows
} from '../../legacyTestApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

describe('runtime edge helpers', () => {
  it('ignores loss notifications before runtime configuration', () => {
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
    const row = { id: 'row-1', label: 'first' };
    const first = gate.projectRows([row], { renderKeys: ['label'] });
    const second = gate.projectRows([row], { renderKeys: ['label'] });
    const withoutKeys = gate.projectRows([row], {});
    const emptyKeys = gate.projectRows([row], { renderKeys: [] });

    expect(second).toBe(first);
    expect(emptyKeys).toBe(withoutKeys);
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

    getCommitBus().publish({
      rows: [{ model: 'Rows', id: 'row-1', fields: null, kind: 'destroy' }],
      scopes: [],
      pending: [],
      scopeChanges: []
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(refetch).toHaveBeenCalledTimes(1);
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
});

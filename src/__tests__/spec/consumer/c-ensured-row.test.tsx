import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, f, scope, type DbTransport } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; name: string; status: string; updatedAt: string };
type Response = { detail: Row | null };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
};

const createRowsModel = (id: string) =>
  defineModel({
    id,
    name: id,
    fields: { name: f.str(), status: f.str(), updatedAt: f.str() },
    scopes: { byStatus: scope<Row>({ by: { status: 'status' } }) }
  });

const createDetailQuery = (rows: ReturnType<typeof createRowsModel>, key: string) =>
  rows.query<Response, { id: string }, { id: string }, Row>('detail', {
    document,
    key,
    vars: scope => scope,
    select: data => data.detail,
    staleTime: Infinity
  });

const renderEnsured = <T,>(useHook: () => T) => {
  let value!: T;
  let renderCount = 0;
  const Reader = () => {
    value = useHook();
    renderCount += 1;
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });
  return {
    result: () => value,
    renders: () => renderCount,
    unmount: () => act(() => root.unmount())
  };
};

describe('useRowEnsured', () => {
  it('keeps a present row identity stable and does not fetch', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredPresent');
    const query = createDetailQuery(rows, 'ensured-present');
    const scopeQuery = rows.query<Response, { status: string }, { status: string }, Row>('scope-detail', {
      document,
      key: 'ensured-scope-type',
      vars: scopeValue => scopeValue,
      select: data => data.detail,
      into: rows.scopes.byStatus
    });
    // @ts-expect-error Scope destinations do not expose point-row materialization.
    void scopeQuery.useRowEnsured;
    rows.scopes.byStatus.seed({ status: 'ready' }, [{ id: 'row-1', name: 'Local', status: 'ready', updatedAt: '2026-07-20T00:00:00Z' }]);
    const reader = renderEnsured(() => query.useRowEnsured({ id: 'row-1' }, 'row-1'));

    await settle();

    const initial = reader.result().row;
    expect(reader.result().row).toBe(initial);
    expect(transport.calls).toHaveLength(0);
    expect(reader.result().loadingState.hasData).toBe(true);
    reader.unmount();
  });

  it('fetches a missing row and materializes it after initial loading', async () => {
    let resolve!: (value: { data: Response }) => void;
    const transport = createMockTransport({
      query: <TData,>() =>
        new Promise<{ data: TData }>(promiseResolve => {
          resolve = promiseResolve as unknown as (value: { data: Response }) => void;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredMiss');
    const query = createDetailQuery(rows, 'ensured-miss');
    const reader = renderEnsured(() => query.useRowEnsured({ id: 'row-1' }, 'row-1'));

    await settle();
    expect(reader.result().loadingState.phase).toBe('initial_loading');
    await act(async () => {
      resolve({ data: { detail: { id: 'row-1', name: 'Server', status: 'ready', updatedAt: '2026-07-20T00:00:01Z' } } });
      await Promise.resolve();
    });
    await settle();

    expect(reader.result().row).toMatchObject({ id: 'row-1', name: 'Server' });
    expect(reader.result().loadingState.phase).toBe('ready');
    expect(transport.calls).toHaveLength(1);
    reader.unmount();
  });

  it('settles a genuinely absent row without refetching in a loop', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { detail: null } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredEmpty');
    const query = createDetailQuery(rows, 'ensured-empty');
    const reader = renderEnsured(() => query.useRowEnsured({ id: 'missing' }, 'missing'));

    await settle();
    await settle();

    expect(reader.result().row).toBeUndefined();
    expect(transport.calls).toHaveLength(2);
    expect(reader.result().loadingState.phase).toBe('ready');
    expect(reader.result().loadingState.showEmptyState).toBe(true);
    reader.unmount();
  });

  it('recovers a destroyed row on remount even with staleTime Infinity', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { detail: { id: `row-${++calls}`, name: 'Server', status: 'ready', updatedAt: `2026-07-20T00:00:0${calls}Z` } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredRemount');
    const query = createDetailQuery(rows, 'ensured-remount');
    const first = renderEnsured(() => query.useRowEnsured({ id: 'row-1' }, 'row-1'));
    await settle();
    first.unmount();
    act(() => rows.destroy('row-1'));
    const second = renderEnsured(() => query.useRowEnsured({ id: 'row-2' }, 'row-2'));
    await settle();

    expect(calls).toBe(2);
    expect(second.result().row).toMatchObject({ id: 'row-2' });
    second.unmount();
  });

  it('keeps a null row id inactive without fetching or showing empty state', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredNull');
    const query = createDetailQuery(rows, 'ensured-null');
    const reader = renderEnsured(() => query.useRowEnsured({ id: 'unused' }, null));

    await settle();

    expect(transport.calls).toHaveLength(0);
    expect(reader.result().row).toBeUndefined();
    expect(reader.result().loadingState.phase).toBe('idle');
    expect(reader.result().loadingState.showEmptyState).toBe(false);
    reader.unmount();
  });

  it('reenables fetching when a mounted present row is destroyed', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { detail: { id: 'row-1', name: 'Recovered', status: 'ready', updatedAt: '2026-07-20T00:00:01Z' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredDestroyed');
    const query = createDetailQuery(rows, 'ensured-destroyed');
    rows.scopes.byStatus.seed({ status: 'ready' }, [{ id: 'row-1', name: 'Local', status: 'ready', updatedAt: '2026-07-20T00:00:00Z' }]);
    const reader = renderEnsured(() => query.useRowEnsured({ id: 'row-1' }, 'row-1'));

    await settle();
    act(() => rows.destroy('row-1'));
    await settle();

    expect(transport.calls).toHaveLength(1);
    expect(reader.result().row).toMatchObject({ id: 'row-1', name: 'Recovered' });
    reader.unmount();
  });

  it('refetches a fresh detail query when its ensured row changes', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          detail: { id: calls++ === 0 ? 'row-1' : 'row-2', name: calls === 1 ? 'Initial' : 'Recovered', status: 'ready', updatedAt: '2026-07-20T00:00:01Z' }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredFreshDestroyed');
    const query = createDetailQuery(rows, 'ensured-fresh-destroyed');
    const first = renderEnsured(() => query.useRowEnsured({ id: 'shared' }, 'row-1'));

    await settle();
    expect(first.result().row).toMatchObject({ id: 'row-1', name: 'Initial' });
    expect(first.result().loadingState.showEmptyState).toBe(false);
    expect(transport.calls).toHaveLength(1);
    first.unmount();

    const second = renderEnsured(() => query.useRowEnsured({ id: 'shared' }, 'row-2'));
    await settle();

    expect(transport.calls).toHaveLength(2);
    expect(second.result().row).toMatchObject({ id: 'row-2', name: 'Recovered' });
    expect(second.result().loadingState.showEmptyState).toBe(false);
    second.unmount();
  });

  it('rearms one forced refetch when the ensured scope changes', async () => {
    const calls: string[] = [];
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => {
        calls.push(((operation.variables ?? {}) as { id: string }).id);
        return { data: { detail: null } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredScopeRearm');
    const query = createDetailQuery(rows, 'ensured-scope-rearm');
    const warm = renderEnsured(() => query.use({ id: 'S2' }));
    await settle();
    warm.unmount();

    let latest!: ReturnType<typeof query.useRowEnsured>;
    const Reader = ({ scopeId }: { scopeId: string }) => {
      latest = query.useRowEnsured({ id: scopeId }, 'missing');
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader, { scopeId: 'S1' })));
    });
    await settle();
    expect(calls.filter(id => id === 'S1')).toHaveLength(2);
    expect(latest.loadingState.showEmptyState).toBe(true);

    act(() => {
      root.update(React.createElement(DbProvider, null, React.createElement(Reader, { scopeId: 'S2' })));
    });
    await settle();

    expect(calls.filter(id => id === 'S2')).toHaveLength(2);
    expect(latest.loadingState.showEmptyState).toBe(true);
    act(() => root.unmount());
  });

  it('does not rerender for an unrelated field outside renderKeys', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRowsModel('EnsuredRenderKeys');
    const query = createDetailQuery(rows, 'ensured-render-keys');
    rows.scopes.byStatus.seed({ status: 'ready' }, [{ id: 'row-1', name: 'Local', status: 'ready', updatedAt: '2026-07-20T00:00:00Z' }]);
    const reader = renderEnsured(() => query.useRowEnsured({ id: 'row-1' }, 'row-1', { renderKeys: ['name'] }));
    await settle();
    const renders = reader.renders();

    act(() => rows.patch('row-1', { status: 'changed' }));
    await settle();

    expect(reader.renders()).toBe(renders);
    expect(transport.calls).toHaveLength(0);
    reader.unmount();
  });
});

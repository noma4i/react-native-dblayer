import { act } from 'react';
import {
  buildScopeKey,
  compositeKey,
  configureDb,
  defineModelRuntime,
  f,
  getDbQueryClient,
  invalidateModel,
  resetRuntime
} from '../../testApi';
import {
  createMemoryPlane,
  createMockTransport,
  isTestNetworkOnline,
  renderCountedInProvider,
  setTestNetworkOnline,
  settle
} from '../helpers/harness';

type Row = {
  id: string;
  bucket: string;
  label: string;
};

const document = { kind: 'Document', definitions: [] } as never;

const createRows = (suffix: string) =>
  defineModelRuntime({
    id: `SpecQueryRuntimeRows${suffix}`,
    name: `SpecQueryRuntimeRows${suffix}`,
    fields: { bucket: f.str(), label: f.str() },
    scopes: { bucket: ({ by: { bucket: 'bucket' } }) }
  });

describe('query runtime edges', () => {
  it('matches primitive invalidation scopes and refetches only the mounted matching reader', async () => {
    const calls: string[] = [];
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<typeof transport.query>[0]) => {
        const scope = ((operation.variables ?? {}) as { scope: string }).scope;
        calls.push(scope);
        return { data: { rows: [{ id: `row-${scope}`, bucket: scope, label: scope }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('PrimitiveInvalidation');
    const query = rows.query<{ rows: Row[] }, { scope: string }, string, Row>('list', {
      document,
      key: 'query-runtime-primitive-invalidation',
      vars: scope => ({ scope }),
      select: data => data.rows,
      staleTime: Infinity
    });
    const first = renderCountedInProvider(() => query.use('a'));
    const second = renderCountedInProvider(() => query.use('b'));
    await settle();
    await settle(1, { macro: true });
    expect(calls).toEqual(['a', 'b']);
    expect(query.read('a')).toEqual([{ id: 'row-a', bucket: 'a', label: 'a' }]);
    expect(query.read(null)).toBeUndefined();

    act(() => {
      query.invalidate('a');
    });
    await settle();
    await settle(1, { macro: true });

    expect(calls).toEqual(['a', 'b', 'a']);
    act(() => {
      query.invalidate({ scope: 'a' } as never);
    });
    await settle();
    expect(calls).toEqual(['a', 'b', 'a']);
    first.unmount();
    second.unmount();

    rows.destroy('row-a');
    expect(query.read('a')).toEqual([]);
  });

  it('pauses an offline mounted reader and refetches it after reconnect', async () => {
    const wasOnline = isTestNetworkOnline();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { rows: [] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('Reconnect');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-reconnect',
      select: data => data.rows,
      staleTime: 0
    });

    try {
      setTestNetworkOnline(false);
      const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
      await settle();
      expect(calls).toBe(0);
      expect(reader.result().loadingState.isOffline).toBe(true);

      act(() => {
        setTestNetworkOnline(true);
      });
      await settle();
      await settle(1, { macro: true });

      expect(calls).toBe(1);
      expect(reader.result().loadingState.isOffline).toBe(false);
      act(() => {
        setTestNetworkOnline(false);
      });
      expect(calls).toBe(1);
      reader.unmount();
    } finally {
      setTestNetworkOnline(wasOnline);
    }
  });

  it('settles a request whose transport rejects after connectivity drops', async () => {
    const wasOnline = isTestNetworkOnline();
    let reject!: (reason: unknown) => void;
    const transport = createMockTransport({
      query: <TData,>() =>
        new Promise<{ data: TData }>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('OfflineFailure');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-offline-failure',
      select: data => data.rows
    });

    try {
      setTestNetworkOnline(true);
      const pending = query.fetch({ bucket: 'main' });
      setTestNetworkOnline(false);
      reject(new Error('offline'));
      await expect(pending).rejects.toThrow('offline');
    } finally {
      setTestNetworkOnline(wasOnline);
    }
  });

  it('drops a mounted rejection after the runtime generation changes', async () => {
    let reject!: (reason: unknown) => void;
    const transport = createMockTransport({
      query: <TData,>() =>
        new Promise<{ data: TData }>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('StaleFailure');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-stale-failure',
      select: data => data.rows
    });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle(2);
    reader.unmount();

    const replacementTransport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport: replacementTransport });
    reject(new Error('stale'));
    await settle();

    expect(replacementTransport.calls).toHaveLength(0);
  });

  it('refuses a page without connection metadata and reads null and populated scope destinations', async () => {
    let response: { connection: { nodes: Row[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } | null } = { connection: null };
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: response as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ScopeRead');
    const query = rows.query<typeof response, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-scope-read',
      into: rows.scopes.bucket,
      connection: data => data.connection,
      coverage: 'page'
    });

    await expect(query.fetch({ bucket: 'main' })).rejects.toThrow('no usable pageInfo');
    expect(query.read(null)).toEqual([]);
    expect(query.read({ bucket: 'main' })).toEqual([]);

    response = {
      connection: {
        nodes: [
          { id: 'row-1', bucket: 'main', label: 'first' },
          { id: 'row-2', bucket: 'main', label: 'second' }
        ]
      }
    };
    await expect(query.fetch({ bucket: 'main' })).rejects.toThrow('no usable pageInfo');
    expect(query.read({ bucket: 'main' })).toEqual([]);

    response = {
      connection: {
        nodes: [
          { id: 'row-1', bucket: 'main', label: 'first' },
          { id: 'row-2', bucket: 'main', label: 'second' }
        ],
        pageInfo: { hasNextPage: false, endCursor: null }
      }
    };
    await query.fetch({ bucket: 'main' });

    expect(query.read({ bucket: 'main' })).toEqual([
      { id: 'row-1', bucket: 'main', label: 'first' },
      { id: 'row-2', bucket: 'main', label: 'second' }
    ]);
  });

  it('normalizes a non-Error observer failure', async () => {
    const transport = createMockTransport({
      query: async () => Promise.reject('query failed')
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('FailureNormalization');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-failure-normalization',
      select: data => data.rows
    });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();
    await settle(1, { macro: true });

    expect(reader.result().error).toEqual(new Error('query failed'));
    reader.unmount();
  });

  it('normalizes a non-Error imperative failure', async () => {
    const transport = createMockTransport({
      query: async () => Promise.reject('imperative query failed')
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ImperativeFailureNormalization');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-imperative-failure-normalization',
      select: data => data.rows
    });

    await expect(query.fetch({ bucket: 'main' })).rejects.toThrow('imperative query failed');
  });

  it('accepts a raw row response without page or select', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { id: 'raw-row', bucket: 'main', label: 'raw' } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('RawResponse');
    const query = rows.query<Row, Record<string, never>, Record<string, never>, Row>('raw', {
      document,
      key: 'query-runtime-raw-response'
    });

    await query.fetch({});

    expect(query.read({})).toEqual({ id: 'raw-row', bucket: 'main', label: 'raw' });
  });

  it('rejects a scalar selection before it can reach a row destination', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { value: 'invalid' } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ScalarSelection');
    const query = rows.query<{ value: string }, Record<string, never>, Record<string, never>, Row>('scalar', {
      document,
      key: 'query-runtime-scalar-selection',
      select: data => data.value
    });

    await expect(query.fetch({})).rejects.toThrow('defineQuery select/page must return rows, a row, or a connection');
  });

  it('derives backward page metadata from edges and keeps the chain when metadata goes missing', async () => {
    let response: { page: { edges?: Array<{ node: Row }>; pageInfo?: Record<string, never> } } = {
      page: {
        edges: [{ node: { id: 'edge-row', bucket: 'main', label: 'edge' } }],
        pageInfo: {}
      }
    };
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: response as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('BackwardMetadata');
    const query = rows.query<typeof response, Record<string, never>, { bucket: string }, Row>('backward', {
      document,
      key: 'query-runtime-backward-metadata',
      into: rows.scopes.bucket,
      page: data => data.page,
      direction: 'backward',
      coverage: 'page'
    });

    await query.fetch({ bucket: 'main' });
    expect(query.read({ bucket: 'main' })).toEqual([{ id: 'edge-row', bucket: 'main', label: 'edge' }]);

    response = { page: {} };
    await query.fetch({ bucket: 'main' });
    expect(query.read({ bucket: 'main' })).toEqual([{ id: 'edge-row', bucket: 'main', label: 'edge' }]);
  });

  it('exposes an ensured-row refetch that replaces the stored row', async () => {
    const consoleError = jest.spyOn(console, 'error');
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            row: { id: 'row-1', bucket: 'main', label: calls === 1 ? 'first' : 'second' }
          } as TData
        };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('EnsuredRefetch');
    const query = rows.query<{ row: Row }, Record<string, never>, { id: string }, Row>('detail', {
      document,
      key: 'query-runtime-ensured-refetch',
      select: data => data.row
    });
    const reader = renderCountedInProvider(() => query.useRowEnsured({ id: 'row-1' }, 'row-1'));
    await settle();
    await settle(1, { macro: true });
    expect(reader.result().data?.label).toBe('first');

    await act(async () => {
      await reader.result().refresh();
    });

    expect(calls).toBe(2);
    expect(reader.result().data?.label).toBe('second');
    reader.unmount();
    expect(consoleError.mock.calls.some(args => String(args[0]).includes('Cannot update a component'))).toBe(false);
    consoleError.mockRestore();
  });

  it('refetches an imperative query when invalidation lands during transport', async () => {
    const resolvers: Array<(rows: Row[]) => void> = [];
    const transport = createMockTransport({
      query: <TData,>() => new Promise<{ data: TData }>(resolve => {
        resolvers.push(rows => resolve({ data: { rows } as TData }));
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ImperativeInvalidateInFlight');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-imperative-invalidate',
      select: data => data.rows,
      into: rows.scopes.bucket,
      coverage: 'page'
    });
    const scope = { bucket: 'main' };
    const pending = query.fetch(scope);
    await settle();

    query.invalidate(scope);
    resolvers.shift()!([{ id: 'old', bucket: 'main', label: 'old' }]);
    await settle();
    expect(transport.calls).toHaveLength(2);
    resolvers.shift()!([{ id: 'new', bucket: 'main', label: 'new' }]);
    await pending;

    expect(query.read(scope).map(row => row.id).sort()).toEqual(['new', 'old']);
  });

  it('drops an imperative invalidation retry when the runtime resets before the retry', async () => {
    let resolveQuery!: (rows: Row[]) => void;
    const transport = createMockTransport({
      query: <TData,>() => new Promise<{ data: TData }>(resolve => {
        resolveQuery = rows => resolve({ data: { rows } as TData });
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ImperativeInvalidateReset');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-imperative-invalidate-reset',
      select: data => data.rows
    });
    const scope = { bucket: 'main' };
    const client = getDbQueryClient();
    const invalidateQueries = client.invalidateQueries.bind(client);
    let invalidations = 0;
    jest.spyOn(client, 'invalidateQueries').mockImplementation(async filters => {
      invalidations += 1;
      await invalidateQueries(filters);
      if (invalidations === 2) resetRuntime();
    });
    const pending = query.fetch(scope);
    await settle();

    query.invalidate(scope);
    resolveQuery([{ id: 'old', bucket: 'main', label: 'old' }]);

    await expect(pending).rejects.toThrow('runtime was reset before it resolved');
  });

  it('drops an imperative refresh when persisted landing resets the runtime', async () => {
    const storage = createMemoryPlane();
    const write = storage.set.bind(storage);
    let resetOnQueryWrite = false;
    storage.set = (key, value) => {
      write(key, value);
      if (!resetOnQueryWrite || !key.startsWith('dbl:query:')) return;
      resetOnQueryWrite = false;
      resetRuntime();
    };
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', bucket: 'main', label: 'landed' }] } as TData })
    });
    configureDb({ storage, transport });
    const rows = createRows('PersistReset');
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-persist-reset',
      select: data => data.rows,
      staleTime: 60_000
    });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();
    await settle(1, { macro: true });
    resetOnQueryWrite = true;

    await act(async () => {
      await expect(reader.result().refresh()).resolves.toBeUndefined();
    });

    reader.unmount();
  });

  it('invalidates every query registered on its destination model: mounted readers refetch, other models stay fresh', async () => {
    const served: Record<string, number> = {};
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<typeof transport.query>[0]) => {
        const tag = ((operation.variables ?? {}) as { tag: string }).tag;
        served[tag] = (served[tag] ?? 0) + 1;
        return { data: { rows: [{ id: `row-${tag}`, bucket: 'main', label: `${tag}-v${served[tag]}` }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ModelInvalidation');
    const other = createRows('ModelInvalidationOther');
    const makeQuery = (model: ReturnType<typeof createRows>, tag: string) =>
      model.query<{ rows: Row[] }, { tag: string }, { tag: string }, Row>('list', {
        document,
        key: `query-runtime-model-invalidation-${tag}`,
        vars: scope => ({ tag: scope.tag }),
        select: data => data.rows,
        staleTime: Infinity
      });
    const labels = (value: unknown): string[] => (value as Row[]).map(row => row.label);
    const first = renderCountedInProvider(() => makeQuery(rows, 'a').use({ tag: 'a' }));
    const second = renderCountedInProvider(() => makeQuery(rows, 'b').use({ tag: 'b' }));
    const foreign = renderCountedInProvider(() => makeQuery(other, 'c').use({ tag: 'c' }));
    await settle();
    await settle(1, { macro: true });
    expect(labels(first.result().data)).toEqual(['a-v1']);
    expect(labels(second.result().data)).toEqual(['b-v1']);
    expect(labels(foreign.result().data)).toEqual(['c-v1']);

    act(() => {
      invalidateModel(rows.modelId);
    });
    await settle();
    await settle(1, { macro: true });

    // Both queries on the addressed model refetched, the query on the other model kept its value.
    expect(labels(first.result().data)).toEqual(['a-v2']);
    expect(labels(second.result().data)).toEqual(['b-v2']);
    expect(labels(foreign.result().data)).toEqual(['c-v1']);
    first.unmount();
    second.unmount();
    foreign.unmount();
  });

  it('uses the current observer chain when a reset drops the transport result', async () => {
    let resolveQuery!: (rows: Row[]) => void;
    const transport = createMockTransport({
      query: <TData,>() => new Promise<{ data: TData }>(resolve => {
        resolveQuery = rows => resolve({ data: { rows } as TData });
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ObserverCurrentFallback');
    const keyName = 'query-runtime-observer-current';
    const scope = { bucket: 'main' };
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: keyName,
      select: data => data.rows
    });
    const reader = renderCountedInProvider(() => query.use(scope));
    await settle();
    const client = getDbQueryClient();
    const queryKey: [string, string] = [keyName, compositeKey(keyName, buildScopeKey(scope))];
    act(() => resetRuntime());
    client.setQueryData(queryKey, {
      cursor: null,
      pages: 1,
      hasNextPage: false,
      ids: [],
      resultKind: 'many'
    });
    resolveQuery([{ id: 'stale', bucket: 'main', label: 'stale' }]);
    await settle();

    expect(client.getQueryData(queryKey)).toMatchObject({ pages: 1, ids: [] });
    reader.unmount();
  });

  it('uses an empty observer chain when reset drops the first transport result', async () => {
    let resolveQuery!: (rows: Row[]) => void;
    const transport = createMockTransport({
      query: <TData,>() => new Promise<{ data: TData }>(resolve => {
        resolveQuery = rows => resolve({ data: { rows } as TData });
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ObserverEmptyFallback');
    const scope = { bucket: 'main' };
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-observer-empty',
      select: data => data.rows
    });
    const reader = renderCountedInProvider(() => query.use(scope));
    await settle();
    act(() => resetRuntime());
    resolveQuery([{ id: 'stale', bucket: 'main', label: 'stale' }]);
    await settle();

    expect(rows.find('stale')).toBeUndefined();
    reader.unmount();
  });

  it('keeps the first observer result when a reset drops its invalidation retry', async () => {
    const resolvers: Array<(rows: Row[]) => void> = [];
    const transport = createMockTransport({
      query: <TData,>() => new Promise<{ data: TData }>(resolve => {
        resolvers.push(rows => resolve({ data: { rows } as TData }));
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ObserverRetryFallback');
    const scope = { bucket: 'main' };
    const query = rows.query<{ rows: Row[] }, Record<string, never>, { bucket: string }, Row>('list', {
      document,
      key: 'query-runtime-observer-retry-fallback',
      select: data => data.rows,
      into: rows.scopes.bucket,
      coverage: 'page'
    });
    const reader = renderCountedInProvider(() => query.use(scope));
    await settle();
    act(() => query.invalidate(scope));
    resolvers.shift()!([{ id: 'first', bucket: 'main', label: 'first' }]);
    await settle();
    expect(transport.calls).toHaveLength(2);
    act(() => resetRuntime());
    resolvers.shift()!([{ id: 'stale', bucket: 'main', label: 'stale' }]);
    await settle();

    expect(reader.result().data).toEqual([]);
    reader.unmount();
  });
});

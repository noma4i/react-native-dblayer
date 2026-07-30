import { act } from 'react';
import { configureDb, defineModelRuntime, f } from '../../testApi';
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
      await expect(pending).resolves.toBeUndefined();
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

  it('reads null and populated scope destinations when a page omits connection metadata', async () => {
    let response: { connection: { nodes: Row[] } | null } = { connection: null };
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

    await query.fetch({ bucket: 'main' });
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

  it('derives backward page metadata from edges and defaults missing metadata to exhaustion', async () => {
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
      await reader.result().refetch();
    });

    expect(calls).toBe(2);
    expect(reader.result().data?.label).toBe('second');
    reader.unmount();
  });
});

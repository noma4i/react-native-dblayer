import { configureDb, defineFetch, defineModelRuntime, f, resetRuntime, setFetchNetworkOnline } from '../../testApi';
import { backoffDelayMs } from '../../../core/fetch/retryPolicy';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

const configureRetry = (transport: ReturnType<typeof createMockTransport>, classify?: (error: unknown) => 'network' | 'server' | 'retriable' | 'fatal') => {
  configureDb({
    storage: createMemoryPlane(),
    transport,
    defaults: {
      retry: { query: { classify, budgets: { network: 2 }, backoff: { baseMs: 1, maxMs: 1 } } }
    } as never
  });
};

describe('query retry policy', () => {
  it('rejects an offline model-less fetch when no data can be restored', async () => {
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const request = defineFetch<number, void, number>({
        key: 'offline-empty-fetch',
        document,
        select: data => data
      });
      setFetchNetworkOnline(false);

      await expect(request.fetch(undefined)).rejects.toThrow('offline');
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('rejects an offline model query when no data can be restored', async () => {
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const rows = defineModelRuntime({ id: 'OfflineEmptyQuery', name: 'OfflineEmptyQuery', fields: { label: f.str() } });
      const query = rows.query<{ rows: Array<{ id: string; label: string }> }, void, void, { id: string; label: string }>('offline-empty', {
        key: 'offline-empty-query',
        document,
        select: data => data.rows
      });
      setFetchNetworkOnline(false);

      await expect(query.fetch(undefined)).rejects.toThrow('offline');
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('returns cached model-less and model data while offline', async () => {
    try {
      let calls = 0;
      const transport = createMockTransport({
        query: async <TData>() => {
          calls += 1;
          return { data: (calls === 1 ? 7 : { rows: [{ id: 'row-1', label: 'cached' }] }) as TData };
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const request = defineFetch<number, void, number>({
        key: 'offline-cached-fetch',
        document,
        select: data => data,
        staleTime: 0
      });
      const rows = defineModelRuntime({ id: 'OfflineCachedQuery', name: 'OfflineCachedQuery', fields: { label: f.str() } });
      const query = rows.query<{ rows: Array<{ id: string; label: string }> }, void, void, { id: string; label: string }>('offline-cached', {
        key: 'offline-cached-query',
        document,
        select: data => data.rows,
        staleTime: 0
      });

      await expect(request.fetch()).resolves.toBe(7);
      await query.fetch();
      setFetchNetworkOnline(false);

      await expect(request.fetch()).resolves.toBe(7);
      await expect(query.fetch()).resolves.toBeUndefined();
      expect(rows.find('row-1')).toMatchObject({ label: 'cached' });
      expect(calls).toBe(2);
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('keeps cached model-less and model data on a failed stale fetch but rejects refresh', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData>() => {
        calls += 1;
        if (calls === 1) return { data: 7 as TData };
        if (calls === 2) return { data: { rows: [{ id: 'row-1', label: 'cached' }] } as TData };
        throw new Error('network failed');
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const request = defineFetch<number, void, number>({
      key: 'failed-cached-fetch',
      document,
      select: data => data,
      staleTime: 0
    });
    const rows = defineModelRuntime({ id: 'FailedCachedQuery', name: 'FailedCachedQuery', fields: { label: f.str() } });
    const query = rows.query<{ rows: Array<{ id: string; label: string }> }, void, void, { id: string; label: string }>('failed-cached', {
      key: 'failed-cached-query',
      document,
      select: data => data.rows,
      staleTime: 0
    });

    await request.fetch();
    await query.fetch();

    await expect(request.fetch()).resolves.toBe(7);
    await expect(query.fetch()).resolves.toBeUndefined();
    await expect(request.refresh()).rejects.toThrow('network failed');
    await expect(query.refresh()).rejects.toThrow('network failed');
    expect(rows.find('row-1')).toMatchObject({ label: 'cached' });
  });

  it('rejects a model-less request that loses connectivity before its first response', async () => {
    let rejectRequest!: (error: Error) => void;
    try {
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({
          query: () =>
            new Promise((_resolve, reject) => {
              rejectRequest = reject;
            })
        })
      });
      const request = defineFetch<number, void, number>({
        key: 'offline-during-empty-fetch',
        document,
        select: data => data
      });
      const pending = request.fetch();
      await Promise.resolve();
      setFetchNetworkOnline(false);
      rejectRequest(new Error('network dropped'));

      await expect(pending).rejects.toThrow('offline');
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('keeps cached model data when connectivity drops during a stale request', async () => {
    let rejectRequest!: (error: Error) => void;
    let calls = 0;
    try {
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({
          query: async <TData>() => {
            calls += 1;
            if (calls === 1) return { data: { rows: [{ id: 'row-1', label: 'cached' }] } as TData };
            return await new Promise((_resolve, reject) => {
              rejectRequest = reject;
            });
          }
        })
      });
      const rows = defineModelRuntime({ id: 'OfflineDuringCachedQuery', name: 'OfflineDuringCachedQuery', fields: { label: f.str() } });
      const query = rows.query<{ rows: Array<{ id: string; label: string }> }, void, void, { id: string; label: string }>('offline-during-cached', {
        key: 'offline-during-cached-query',
        document,
        select: data => data.rows,
        staleTime: 0
      });
      await query.fetch();
      const pending = query.fetch();
      await Promise.resolve();
      setFetchNetworkOnline(false);
      rejectRequest(new Error('network dropped'));

      await expect(pending).resolves.toBeUndefined();
      expect(rows.find('row-1')).toMatchObject({ label: 'cached' });
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('doubles from the base delay and caps at the declared maximum', () => {
    expect([0, 1, 2, 3].map(attempt => backoffDelayMs(attempt, 100, 250))).toEqual([100, 200, 250, 250]);
  });

  it('retries a classified network failure within its budget', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData>() => {
        calls += 1;
        if (calls < 3) throw new Error('offline');
        return { data: 42 as TData };
      }
    });
    configureRetry(transport, () => 'network');
    const request = defineFetch<number, void, number>({
      key: 'retry-network',
      document,
      select: (data: number) => data
    });

    await expect(request.fetch(undefined)).resolves.toBe(42);
    expect(calls).toBe(3);
  });

  it('does not retry a fatal failure', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async () => {
        calls += 1;
        throw new Error('fatal');
      }
    });
    configureRetry(transport, () => 'fatal');
    const request = defineFetch<number, void, number>({
      key: 'retry-fatal',
      document,
      select: (data: number) => data
    });

    await expect(request.fetch(undefined)).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('does not retry when no classifier is configured', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async () => {
        calls += 1;
        throw new Error('unclassified');
      }
    });
    configureRetry(transport);
    const request = defineFetch<number, void, number>({
      key: 'retry-safe-default',
      document,
      select: (data: number) => data
    });

    await expect(request.fetch(undefined)).rejects.toThrow('unclassified');
    expect(calls).toBe(1);
  });

  it('does not retry an old QueryClient after runtime reset', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const transport = createMockTransport({
        query: async () => {
          calls += 1;
          throw new Error('offline');
        }
      });
      configureDb({
        storage: createMemoryPlane(),
        transport,
        defaults: {
          retry: { query: { classify: () => 'network', budgets: { network: 2 }, backoff: { baseMs: 1000, maxMs: 1000 } } }
        } as never
      });
      const request = defineFetch<number, void, number>({
        key: 'retry-reset-fence',
        document,
        select: (data: number) => data
      });

      const pending = request.fetch(undefined).then(
        () => null,
        error => error as Error
      );
      await Promise.resolve();
      await Promise.resolve();
      resetRuntime();
      await jest.runAllTimersAsync();

      await expect(pending).resolves.toBeInstanceOf(Error);
      expect(calls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not report a stale defineFetch failure after runtime reset', async () => {
    let rejectRequest!: (error: Error) => void;
    const onSyncError = jest.fn();
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: () =>
          new Promise((_resolve, reject) => {
            rejectRequest = reject;
          })
      }),
      defaults: { onSyncError }
    });
    const request = defineFetch<number, void, number>({
      key: 'fetch-error-reset-fence',
      document,
      select: (data: number) => data
    });
    const pending = request.fetch(undefined).catch(error => error as Error);
    await Promise.resolve();

    resetRuntime();
    rejectRequest(new Error('stale fetch failure'));
    await pending;

    expect(onSyncError).not.toHaveBeenCalled();
  });

  it('does not report a stale defineQuery failure after runtime reset', async () => {
    let rejectRequest!: (error: Error) => void;
    const onSyncError = jest.fn();
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: () =>
          new Promise((_resolve, reject) => {
            rejectRequest = reject;
          })
      }),
      defaults: { onSyncError }
    });
    const rows = defineModelRuntime({ id: 'QueryErrorResetFence', name: 'QueryErrorResetFence', fields: { label: f.str() } });
    const query = rows.query<{ rows: Array<{ id: string; label: string }> }, void, void, { id: string; label: string }>('stale-error', {
      key: 'query-error-reset-fence',
      document,
      select: data => data.rows
    });
    const pending = query.fetch(undefined).catch(error => error as Error);
    await Promise.resolve();

    resetRuntime();
    rejectRequest(new Error('stale query failure'));
    await pending;

    expect(onSyncError).not.toHaveBeenCalled();
  });

  it('does not write stale defineFetch pause state into the fresh generation', async () => {
    let rejectRequest!: (error: Error) => void;
    try {
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({
          query: () =>
            new Promise((_resolve, reject) => {
              rejectRequest = reject;
            })
        })
      });
      const request = defineFetch<number, void, number>({
        key: 'fetch-state-reset-fence',
        document,
        enabled: () => false,
        select: (data: number) => data
      });
      const pending = request.fetch(undefined).catch(error => error as Error);
      await Promise.resolve();

      resetRuntime();
      setFetchNetworkOnline(false);
      rejectRequest(new Error('stale fetch failure'));
      await pending;
      const reader = renderCounted(() => request.use(undefined));

      expect(reader.result().loadingState.isOffline).toBe(false);
      reader.unmount();
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('does not write stale defineQuery pause state into the fresh generation', async () => {
    let rejectRequest!: (error: Error) => void;
    let enabled = true;
    try {
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({
          query: () =>
            new Promise((_resolve, reject) => {
              rejectRequest = reject;
            })
        })
      });
      const rows = defineModelRuntime({ id: 'QueryStateResetFence', name: 'QueryStateResetFence', fields: { label: f.str() } });
      const query = rows.query<{ rows: Array<{ id: string; label: string }> }, void, void, { id: string; label: string }>('stale-state', {
        key: 'query-state-reset-fence',
        document,
        enabled: () => enabled,
        select: data => data.rows
      });
      const pending = query.fetch(undefined).catch(error => error as Error);
      await Promise.resolve();

      enabled = false;
      resetRuntime();
      setFetchNetworkOnline(false);
      rejectRequest(new Error('stale query failure'));
      await pending;
      const reader = renderCounted(() => query.use(undefined));

      expect(reader.result().loadingState.isOffline).toBe(false);
      reader.unmount();
    } finally {
      setFetchNetworkOnline(true);
    }
  });
});

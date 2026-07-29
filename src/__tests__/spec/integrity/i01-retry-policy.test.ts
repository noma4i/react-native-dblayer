import { configureDb, defineFetch, defineModel, f, resetRuntime, setFetchNetworkOnline } from '../../../index';
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
    const rows = defineModel({ id: 'QueryErrorResetFence', name: 'QueryErrorResetFence', fields: { label: f.str() } });
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
      const rows = defineModel({ id: 'QueryStateResetFence', name: 'QueryStateResetFence', fields: { label: f.str() } });
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

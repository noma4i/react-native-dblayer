import { configureDb, defineFetch } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const configureRetry = (classify?: (error: unknown) => 'network' | 'server' | 'retriable' | 'fatal') => {
  const transport = createMockTransport();
  configureDb({
    storage: createMemoryPlane(),
    transport,
    defaults: {
      retry: { query: { classify, budgets: { network: 2 }, backoff: { baseMs: 1, maxMs: 1 } } }
    } as never
  });
};

describe('query retry policy', () => {
  it('retries a classified network failure within its budget', async () => {
    configureRetry(() => 'network');
    let calls = 0;
    const request = defineFetch<number, void, number>({
      key: 'retry-network',
      fetcher: async () => {
        calls += 1;
        if (calls < 3) throw new Error('offline');
        return 42;
      },
      select: (data: number) => data
    } as never);

    await expect(request.fetch(undefined)).resolves.toBe(42);
    expect(calls).toBe(3);
  });

  it('does not retry a fatal failure', async () => {
    configureRetry(() => 'fatal');
    let calls = 0;
    const request = defineFetch<number, void, number>({
      key: 'retry-fatal',
      fetcher: async () => {
        calls += 1;
        throw new Error('fatal');
      },
      select: (data: number) => data
    } as never);

    await expect(request.fetch(undefined)).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('does not retry when no classifier is configured', async () => {
    configureRetry();
    let calls = 0;
    const request = defineFetch<number, void, number>({
      key: 'retry-safe-default',
      fetcher: async () => {
        calls += 1;
        throw new Error('unclassified');
      },
      select: (data: number) => data
    } as never);

    await expect(request.fetch(undefined)).rejects.toThrow('unclassified');
    expect(calls).toBe(1);
  });
});

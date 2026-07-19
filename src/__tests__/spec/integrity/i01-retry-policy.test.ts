import { configureDb, defineFetch } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

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
});

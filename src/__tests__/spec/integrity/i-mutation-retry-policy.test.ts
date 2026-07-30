import { configureDb, defineModelRuntime, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

describe('mutation retry policy', () => {
  it('retries a classified network failure within its budget using one operation id', async () => {
    let calls = 0;
    const operationIds: string[] = [];
    const transport = createMockTransport({
      mutation: async operation => {
        calls += 1;
        operationIds.push(((operation.variables as { input: { operationId: string } } | undefined)?.input.operationId)!);
        if (calls === 1) throw new Error('offline');
        return { data: { send: { id: 'server-1' } } } as never;
      }
    });
    configureDb({
      storage: createMemoryPlane(),
      transport,
      defaults: {
        retry: { mutation: { classify: () => 'network', budgets: { network: 2 }, backoff: { baseMs: 1, maxMs: 1 } } }
      }
    });
    const model = defineModelRuntime({ id: 'MutationRetry', name: 'MutationRetry', fields: { id: f.str() } });
    const send = model.mutation<{ send: { id: string } }, { id: string }, { id: string }, { id: string }>('send', {
      document,
      result: 'send',
      dedupe: { key: input => input.id },
      mapInput: (input, context) => ({ input, operationId: context.operationId })
    });

    await expect(send.run({ id: 'client-1' })).resolves.toEqual({ id: 'server-1' });
    expect(calls).toBe(2);
    expect(new Set(operationIds)).toEqual(new Set([operationIds[0]]));
  });

  it('does not retry a server failure without a declared server budget', async () => {
    let calls = 0;
    const transport = createMockTransport({
      mutation: async () => {
        calls += 1;
        throw new Error('server rejected');
      }
    });
    configureDb({
      storage: createMemoryPlane(),
      transport,
      defaults: {
        retry: { mutation: { classify: () => 'server', budgets: { network: 2 }, backoff: { baseMs: 1, maxMs: 1 } } }
      }
    });
    const model = defineModelRuntime({ id: 'MutationRetryServer', name: 'MutationRetryServer', fields: { id: f.str() } });
    const send = model.mutation<{ send: { id: string } }, { id: string }, { id: string }, { id: string }>('send', {
      document,
      result: 'send',
      dedupe: { key: input => input.id }
    });

    await expect(send.run({ id: 'client-1' })).rejects.toThrow('server rejected');
    expect(calls).toBe(1);
  });

  it('does not issue another mutation attempt after runtime reset during backoff', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const transport = createMockTransport({
        mutation: async () => {
          calls += 1;
          throw new Error('offline');
        }
      });
      configureDb({
        storage: createMemoryPlane(),
        transport,
        defaults: {
          retry: { mutation: { classify: () => 'network', budgets: { network: 2 }, backoff: { baseMs: 1000, maxMs: 1000 } } }
        }
      });
      const model = defineModelRuntime({ id: 'MutationRetryReset', name: 'MutationRetryReset', fields: { id: f.str() } });
      const send = model.mutation<{ send: { id: string } }, { id: string }, { id: string }, { id: string }>('send', {
        document,
        result: 'send',
        dedupe: { key: input => input.id }
      });

      const pending = send.run({ id: 'client-1' });
      await Promise.resolve();
      await Promise.resolve();
      resetRuntime();
      await jest.runAllTimersAsync();

      await expect(pending).resolves.toBeNull();
      expect(calls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not schedule retry backoff when an in-flight mutation fails after reset', async () => {
    jest.useFakeTimers();
    try {
      let rejectMutation!: (error: Error) => void;
      let calls = 0;
      const transport = createMockTransport({
        mutation: () => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            rejectMutation = reject;
          });
        }
      });
      configureDb({
        storage: createMemoryPlane(),
        transport,
        defaults: {
          retry: { mutation: { classify: () => 'network', budgets: { network: 2 }, backoff: { baseMs: 1000, maxMs: 1000 } } }
        }
      });
      const model = defineModelRuntime({ id: 'MutationRetryInflightReset', name: 'MutationRetryInflightReset', fields: { id: f.str() } });
      const send = model.mutation<{ send: { id: string } }, { id: string }, { id: string }, { id: string }>('send', {
        document,
        result: 'send',
        dedupe: { key: input => input.id }
      });
      const pending = send.run({ id: 'client-1' });
      await Promise.resolve();

      resetRuntime();
      rejectMutation(new Error('stale failure'));
      await expect(pending).resolves.toBeNull();

      expect(calls).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

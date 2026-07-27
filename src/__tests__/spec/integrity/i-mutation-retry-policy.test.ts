import { configureDb, defineModel, f } from '../../../index';
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
    const model = defineModel({ id: 'MutationRetry', name: 'MutationRetry', fields: { id: f.str() } });
    const send = model.mutation<{ send: { id: string } }, { id: string }, { id: string }, { id: string }>('send', {
      document,
      result: 'send',
      dedupe: { key: input => input.id },
      mapInput: (input, context) => ({ input, operationId: context.operationId })
    });

    await expect(send.run({ id: 'client-1' })).resolves.toEqual({ send: { id: 'server-1' } });
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
    const model = defineModel({ id: 'MutationRetryServer', name: 'MutationRetryServer', fields: { id: f.str() } });
    const send = model.mutation<{ send: { id: string } }, { id: string }, { id: string }, { id: string }>('send', {
      document,
      result: 'send',
      dedupe: { key: input => input.id }
    });

    await expect(send.run({ id: 'client-1' })).rejects.toThrow('server rejected');
    expect(calls).toBe(1);
  });
});

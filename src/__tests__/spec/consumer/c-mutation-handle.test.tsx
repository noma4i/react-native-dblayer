import { act } from 'react';
import { configureDb, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type MessageRow = { id: string; text: string; status: 'Sending' | 'Failed' | 'Sent'; createdAt: string };
type SendInput = { text: string };
type SendResult = { send: { message: MessageRow } };

const document = { kind: 'Document', definitions: [] } as never;

/**
 * Guarantee contracts for the `MutationHandle` React surface returned by `Model.mutation(...).use()`:
 * isPending mirrors the in-flight transport call, error is exposed and cleared per attempt, mutate
 * callbacks fire in a fixed order, and an in-flight mutation survives its reader's unmount.
 */
const createHandleHarness = (suffix: string) => {
  const pendingTransport: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let served = 0;
  const transport = createMockTransport({
    mutation: <TData,>() =>
      new Promise<{ data: TData }>((resolve, reject) => {
        served += 1;
        const serverId = `server-${served}`;
        pendingTransport.push({
          resolve: () => resolve({ data: { send: { message: { id: serverId, text: 'server', status: 'Sent', createdAt: '2026-07-28T00:00:01Z' } } } as TData }),
          reject: error => reject(error)
        });
      })
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const messages = defineModel({
    id: `SpecMutationHandle${suffix}`,
    name: `SpecMutationHandle${suffix}`,
    fields: { text: f.str(), status: f.enum<MessageRow['status']>(['Sending', 'Failed', 'Sent']), createdAt: f.str() },
    maintenance: { dropTempRowsAfterMs: 1000 }
  });
  const send = messages.mutation<SendResult, SendInput, MessageRow, MessageRow>('send', {
    document,
    result: 'send',
    dedupe: false,
    optimistic: {
      model: messages,
      build: (input, context) => ({ id: context.tempId!, text: input.text, status: 'Sending', createdAt: '2026-07-28T00:00:00Z' }),
      selectServerNode: data => data.send.message,
      onFailurePatch: () => ({ status: 'Failed' })
    }
  });
  return { send, pendingTransport };
};

describe('mutation handle contracts', () => {
  it('exposes isPending only while the transport call is in flight and resolves with the server data', async () => {
    const harness = createHandleHarness('Pending');
    const reader = renderCounted(() => harness.send.use());
    expect(reader.result().isPending).toBe(false);

    let promise!: Promise<SendResult | null>;
    act(() => {
      promise = reader.result().mutateAsync({ text: 'hello' });
    });
    expect(reader.result().isPending).toBe(true);

    await act(async () => {
      harness.pendingTransport[0]!.resolve();
      await promise;
    });
    expect(reader.result().isPending).toBe(false);
    await expect(promise).resolves.toMatchObject({ send: { message: { id: 'server-1' } } });
    reader.unmount();
  });

  it('surfaces the transport error on the handle and returns isPending to false', async () => {
    const harness = createHandleHarness('Error');
    const reader = renderCounted(() => harness.send.use());

    let promise!: Promise<SendResult | null>;
    act(() => {
      promise = reader.result().mutateAsync({ text: 'hello' });
    });
    await act(async () => {
      harness.pendingTransport[0]!.reject(new Error('offline'));
      await expect(promise).rejects.toThrow('offline');
    });

    expect(reader.result().error).toMatchObject({ message: 'offline' });
    expect(reader.result().isPending).toBe(false);
    reader.unmount();
  });

  it('runs onSuccess before onSettled on a successful mutate', async () => {
    const harness = createHandleHarness('SuccessOrder');
    const reader = renderCounted(() => harness.send.use());
    const order: string[] = [];
    let received: SendResult | null = null;

    act(() => {
      reader.result().mutate(
        { text: 'hello' },
        {
          onSuccess: data => {
            received = data;
            order.push('success');
          },
          onError: () => order.push('error'),
          onSettled: () => order.push('settled')
        }
      );
    });
    await act(async () => {
      harness.pendingTransport[0]!.resolve();
      await Promise.resolve();
    });

    expect(order).toEqual(['success', 'settled']);
    expect(received).toMatchObject({ send: { message: { id: 'server-1' } } });
    reader.unmount();
  });

  it('runs onError before onSettled on a failed mutate without an unhandled rejection', async () => {
    const harness = createHandleHarness('ErrorOrder');
    const reader = renderCounted(() => harness.send.use());
    const order: string[] = [];
    let received: Error | null = null;

    act(() => {
      reader.result().mutate(
        { text: 'hello' },
        {
          onSuccess: () => order.push('success'),
          onError: error => {
            received = error;
            order.push('error');
          },
          onSettled: () => order.push('settled')
        }
      );
    });
    await act(async () => {
      harness.pendingTransport[0]!.reject(new Error('offline'));
      await Promise.resolve();
    });

    expect(order).toEqual(['error', 'settled']);
    expect(received).toMatchObject({ message: 'offline' });
    reader.unmount();
  });

  it('clears the previous error when a new attempt starts', async () => {
    const harness = createHandleHarness('ClearError');
    const reader = renderCounted(() => harness.send.use());

    let first!: Promise<SendResult | null>;
    act(() => {
      first = reader.result().mutateAsync({ text: 'first' });
    });
    await act(async () => {
      harness.pendingTransport[0]!.reject(new Error('offline'));
      await expect(first).rejects.toThrow('offline');
    });
    expect(reader.result().error).toMatchObject({ message: 'offline' });

    let second!: Promise<SendResult | null>;
    act(() => {
      second = reader.result().mutateAsync({ text: 'second' });
    });
    expect(reader.result().error).toBeNull();

    await act(async () => {
      harness.pendingTransport[1]!.resolve();
      await second;
    });
    expect(reader.result().error).toBeNull();
    reader.unmount();
  });

  it('settles a mutation that outlives its reader unmount', async () => {
    const harness = createHandleHarness('Unmount');
    const reader = renderCounted(() => harness.send.use());

    let promise!: Promise<SendResult | null>;
    act(() => {
      promise = reader.result().mutateAsync({ text: 'hello' });
    });
    reader.unmount();

    await act(async () => {
      harness.pendingTransport[0]!.resolve();
    });
    await expect(promise).resolves.toMatchObject({ send: { message: { id: 'server-1' } } });
  });
});

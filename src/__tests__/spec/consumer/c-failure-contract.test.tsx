import { act } from 'react-test-renderer';
import { bootDb, configureDb, defineModel, f, flushPersistence, reconcileOptimisticRows, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type MessageRow = { id: string; text: string; status: 'Sending' | 'Failed' | 'Sent'; createdAt: string };
type SendInput = { text: string; existingTempId?: string };
type SendResult = { send: { message: MessageRow } };

const document = { kind: 'Document', definitions: [] } as never;

const createMessages = (id: string, transport: ReturnType<typeof createMockTransport>, configure = true) => {
  if (configure) configureDb({ storage: createMemoryPlane(), transport });
  const messages = defineModel({ id, name: id, gc: 'exempt', fields: { text: f.str(), status: f.enum<MessageRow['status']>(['Sending', 'Failed', 'Sent']), createdAt: f.str() } });
  let latestTempId: string | null = null;
  const send = messages.mutation<SendResult, SendInput, MessageRow, MessageRow>('send', {
    document,
    result: 'send',
    optimistic: {
      model: messages,
      existingTempId: input => input.existingTempId ?? null,
      build: (input, context) => {
        latestTempId = context.tempId;
        return { id: context.tempId!, text: input.text, status: 'Sending', createdAt: '2026-07-20T00:00:00Z' };
      },
      selectServerNode: data => data.send.message,
      onFailurePatch: () => ({ status: 'Failed' }),
      onRetryPatch: () => ({ status: 'Sending' })
    }
  });
  return { messages, send, tempId: () => latestTempId };
};

describe('optimistic failure contract', () => {
  it('keeps a failed optimistic send visible with the declared failure patch', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { messages, send, tempId } = createMessages('FailureKeep', transport);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    const failed = renderCounted(() => messages.use.failed(id));
    const pending = renderCounted(() => messages.use.pending(id));

    expect(messages.get(id)).toMatchObject({ text: 'hello', status: 'Failed' });
    expect(failed.result()).toBe(true);
    expect(pending.result()).toBe(false);
    failed.unmount();
    pending.unmount();
  });

  it('retry re-runs the mutation on the same row and commits', async () => {
    let calls = 0;
    let resolve!: (value: { data: SendResult }) => void;
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return new Promise<{ data: TData }>(promiseResolve => {
          resolve = promiseResolve as unknown as (value: { data: SendResult }) => void;
        });
      }
    });
    const { messages, send, tempId } = createMessages('FailureRetry', transport);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    const retry = send.retry(id);

    expect(messages.get(id)).toMatchObject({ status: 'Sending' });
    await act(async () => {
      resolve({ data: { send: { message: { id: 'server-1', text: 'hello', status: 'Sent', createdAt: '2026-07-20T00:00:01Z' } } } });
      await Promise.resolve();
    });
    await expect(retry).resolves.toMatchObject({ send: { message: { id: 'server-1' } } });

    expect(messages.get(id)).toBeUndefined();
    expect(messages.get('server-1')).toMatchObject({ status: 'Sent' });
    const failed = renderCounted(() => messages.use.failed('server-1'));
    expect(failed.result()).toBe(false);
    failed.unmount();
  });

  it('discard removes the failed row and its record', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { messages, send, tempId } = createMessages('FailureDiscard', transport);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    send.discard(id);

    expect(messages.get(id)).toBeUndefined();
    const failed = renderCounted(() => messages.use.failed(id));
    expect(failed.result()).toBe(false);
    failed.unmount();
  });

  it('failure rollback opt-out restores destroy-on-error', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = defineModel({
      id: 'FailureRollback',
      name: 'FailureRollback',
      gc: 'exempt',
      fields: { text: f.str(), status: f.enum<MessageRow['status']>(['Sending', 'Failed', 'Sent']), createdAt: f.str() }
    });
    let id = '';
    const send = messages.mutation<SendResult, SendInput, MessageRow, MessageRow>('send', {
      document,
      result: 'send',
      optimistic: {
        model: messages,
        failure: 'rollback',
        build: (input, context) => {
          id = context.tempId!;
          return { id, text: input.text, status: 'Sending', createdAt: '2026-07-20T00:00:00Z' };
        },
        selectServerNode: data => data.send.message
      }
    });

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');

    expect(messages.get(id)).toBeUndefined();
    const failed = renderCounted(() => messages.use.failed(id));
    expect(failed.result()).toBe(false);
    failed.unmount();
  });

  it('reuse-path failure marks the existing temp row failed', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { messages, send } = createMessages('FailureReuse', transport);
    messages.insertStored({ id: 'temp-upload', text: 'upload', status: 'Sending', createdAt: '2026-07-20T00:00:00Z' });

    await expect(send.run({ text: 'upload', existingTempId: 'temp-upload' })).rejects.toThrow('offline');

    expect(messages.get('temp-upload')).toMatchObject({ status: 'Failed' });
    const failed = renderCounted(() => messages.use.failed('temp-upload'));
    expect(failed.result()).toBe(true);
    failed.unmount();
  });

  it('echo reconcile over a failed row clears its failure', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { messages, send, tempId } = createMessages('FailureReconcile', transport);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    const server = { id: 'server-1', text: 'hello', status: 'Sent' as const, createdAt: '2026-07-20T00:00:01Z' };
    reconcileOptimisticRows(messages, [server], {
      resolveCandidates: () => [messages.get(id)!],
      match: () => true,
      commit: (tempId, node) => messages.replaceRaw(tempId, node)
    });

    expect(messages.get(id)).toBeUndefined();
    expect(messages.get('server-1')).toMatchObject({ status: 'Sent' });
    const failed = renderCounted(() => messages.use.failed('server-1'));
    expect(failed.result()).toBe(false);
    failed.unmount();
  });

  it('failed rows survive journal replay and retry degrades to null after restart', async () => {
    const storage = createMemoryPlane();
    const failingTransport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    configureDb({ storage, transport: failingTransport });
    const { messages, send, tempId } = createMessages('FailureRestart', failingTransport, false);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    flushPersistence();
    const persisted = storage.snapshotKeys().map(key => ({ key, value: storage.get(key)! }));
    resetRuntime();
    storage.set(persisted);
    const restartedTransport = createMockTransport({
      mutation: async <TData,>() => ({ data: { send: { message: { id: 'server-1', text: 'hello', status: 'Sent', createdAt: '2026-07-20T00:00:01Z' } } } as TData })
    });
    configureDb({ storage, transport: restartedTransport });
    const restarted = createMessages('FailureRestart', restartedTransport, false);
    await bootDb();

    expect(restarted.messages.get(id)).toMatchObject({ status: 'Failed' });
    const failed = renderCounted(() => restarted.messages.use.failed(id));
    expect(failed.result()).toBe(true);
    await expect(restarted.send.retry(id)).resolves.toBeNull();
    failed.unmount();
  });

  it('resetRuntime clears failed records and stored inputs', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { messages, send, tempId } = createMessages('FailureReset', transport);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    const failed = renderCounted(() => messages.use.failed(id));
    act(() => resetRuntime());

    expect(failed.result()).toBe(false);
    await expect(send.retry(id)).resolves.toBeNull();
    failed.unmount();
  });
});

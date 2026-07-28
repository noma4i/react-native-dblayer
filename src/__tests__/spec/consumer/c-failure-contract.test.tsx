import { act } from 'react';
import { configureDb, defineModel, f, reconcileOptimisticRows, resetRuntime } from '../../../index';
import { bootDb } from '../../../dsl/lifecycle';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { flushPersistence } from '../../../dsl/configure';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';

type MessageRow = { id: string; text: string; status: 'Sending' | 'Failed' | 'Sent'; createdAt: string };
type SendInput = { text: string; existingTempId?: string };
type SendResult = { send: { message: MessageRow } };

const document = { kind: 'Document', definitions: [] } as never;

const createMessages = (id: string, transport: ReturnType<typeof createMockTransport>, configure = true, onError?: (error: Error) => void, tempTtlMs = 1000) => {
  if (configure) configureDb({ storage: createMemoryPlane(), transport });
  const messages = defineModel({ id, name: id, gc: 'exempt', fields: { text: f.str(), status: f.enum<MessageRow['status']>(['Sending', 'Failed', 'Sent']), createdAt: f.str() }, maintenance: { dropTempRowsAfterMs: tempTtlMs } });
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
    },
    onError: onError ? error => onError(error) : undefined
  });
  return { messages, send, tempId: () => latestTempId };
};

describe('optimistic failure contract', () => {
  it('G1 treats GraphQL errors with data as an optimistic mutation failure', async () => {
    const onError = jest.fn();
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: { id: 'server-1', text: 'server', status: 'Sent', createdAt: '2026-07-20T00:00:01Z' } } } as TData, errors: [{ message: 'denied' }] }) });
    const { messages, send, tempId } = createMessages('FailureGraphql', transport, true, onError);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('denied');

    expect(messages.find(tempId()!)).toMatchObject({ text: 'hello', status: 'Failed' });
    expect(messages.find('server-1')).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'denied' }));
  });

  it('G2 treats an empty GraphQL error array as success', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: { id: 'server-1', text: 'server', status: 'Sent', createdAt: '2026-07-20T00:00:01Z' } } } as TData, errors: [] }) });
    const { messages, send } = createMessages('FailureGraphqlEmpty', transport);

    await expect(send.run({ text: 'hello' })).resolves.toMatchObject({ send: { message: { id: 'server-1' } } });

    expect(messages.find('server-1')).toMatchObject({ status: 'Sent' });
  });

  it('keeps a failed optimistic send visible with the declared failure patch', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { messages, send, tempId } = createMessages('FailureKeep', transport);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    const failed = renderCounted(() => messages.use.failed(id));
    const pending = renderCounted(() => messages.use.pending(id));

    expect(messages.find(id)).toMatchObject({ text: 'hello', status: 'Failed' });
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

    expect(messages.find(id)).toMatchObject({ status: 'Sending' });
    await act(async () => {
      resolve({ data: { send: { message: { id: 'server-1', text: 'hello', status: 'Sent', createdAt: '2026-07-20T00:00:01Z' } } } });
      await Promise.resolve();
    });
    await expect(retry).resolves.toMatchObject({ send: { message: { id: 'server-1' } } });

    expect(messages.find(id)).toBeUndefined();
    expect(messages.find('server-1')).toMatchObject({ status: 'Sent' });
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

    expect(messages.find(id)).toBeUndefined();
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
      fields: { text: f.str(), status: f.enum<MessageRow['status']>(['Sending', 'Failed', 'Sent']), createdAt: f.str() },
      maintenance: { dropTempRowsAfterMs: 1000 }
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

    expect(messages.find(id)).toBeUndefined();
    const failed = renderCounted(() => messages.use.failed(id));
    expect(failed.result()).toBe(false);
    failed.unmount();
  });

  it('reuse-path failure marks the existing temp row failed', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { messages, send } = createMessages('FailureReuse', transport);
    messages.insert({ id: 'temp-upload', text: 'upload', status: 'Sending', createdAt: '2026-07-20T00:00:00Z' });

    await expect(send.run({ text: 'upload', existingTempId: 'temp-upload' })).rejects.toThrow('offline');

    expect(messages.find('temp-upload')).toMatchObject({ status: 'Failed' });
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
      resolveCandidates: () => [messages.find(id)!],
      match: () => true,
      commit: (tempId, node) => messages.replace(tempId, node)
    });

    expect(messages.find(id)).toBeUndefined();
    expect(messages.find('server-1')).toMatchObject({ status: 'Sent' });
    const failed = renderCounted(() => messages.use.failed('server-1'));
    expect(failed.result()).toBe(false);
    failed.unmount();
  });

  it('D1 retries a failed optimistic insert after runtime restart', async () => {
    const storage = createMemoryPlane();
    const failingTransport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    configureDb({ storage, transport: failingTransport });
    const { messages, send, tempId } = createMessages('FailureRestart', failingTransport, false, undefined, Number.POSITIVE_INFINITY);
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });

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
    const restarted = createMessages('FailureRestart', restartedTransport, false, undefined, Number.POSITIVE_INFINITY);
    await bootDb();

    expect(restarted.messages.find(id)).toMatchObject({ text: 'hello', status: 'Failed' });
    const failed = renderCounted(() => restarted.messages.use.failed(id));
    expect(failed.result()).toBe(true);
    await expect(restarted.send.retry(id)).resolves.toMatchObject({ send: { message: { id: 'server-1' } } });
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

  it('D2 reports an unserializable failed input and does not retain it for retry', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { send, tempId } = createMessages('FailureUnserializable', transport);
    const input = { text: 'hello', callback: () => undefined } as SendInput & { callback: () => undefined };

    await expect(send.run(input)).rejects.toThrow('offline');

    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'failed-input-unserializable', model: 'FailureUnserializable', count: 1 });
    await expect(send.retry(tempId()!)).resolves.toBeNull();
  });

  it('D3 clears a failed input when discard removes its kept row', async () => {
    const transport = createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) });
    const { send, tempId } = createMessages('FailureDiscardInput', transport);

    await expect(send.run({ text: 'hello' })).rejects.toThrow('offline');
    const id = tempId()!;
    send.discard(id);

    await expect(send.retry(id)).resolves.toBeNull();
  });

  it('T1 rejects an optimistic insert declaration without a pending temp-row TTL', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModel({ id: 'FailureMissingTempTtl', name: 'FailureMissingTempTtl', fields: { text: f.str() } });

    expect(() =>
      rows.mutation('send', {
        document,
        result: 'send',
        optimistic: { model: rows, build: (_input: Record<string, never>, context: { tempId: string | null }) => ({ id: context.tempId!, text: 'optimistic' }), selectServerNode: (data: { send: { row: { id: string; text: string } } }) => data.send.row }
      })
    ).toThrow('FailureMissingTempTtl must declare maintenance.dropTempRowsAfterMs to be used in an optimistic insert mutation');
  });
});

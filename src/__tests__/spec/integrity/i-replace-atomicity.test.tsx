import { act } from 'react-test-renderer';
import { configureDb, defineModel, defineShape, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

const createThreadMessages = (id: string, options?: { mergeMedia?: boolean }) => {
  const media = defineShape()({ id: f.id(), transcodeStatus: f.enum(['processing', 'completed'] as const), fileUrl: f.str() });
  return defineModel({
    id,
    name: id,
    fields: { chatId: f.id(), body: f.str(), media: f.object(media) },
    scopes: { thread: scope<any>({ by: { chatId: 'chatId' }, sort: { field: 'body', dir: 'asc' } }) },
    ...(options?.mergeMedia
      ? {
          write: {
            groups: [
              {
                fields: ['media'] as const,
                policy: { monotonic: (incoming: any, current: any) => current.media.transcodeStatus !== 'completed' || incoming.media.transcodeStatus === 'completed' }
              }
            ]
          }
        }
      : {})
  });
};

describe('replace atomicity and merge-gate contracts', () => {
  it('keeps the optimistic row and its scope membership when a commit replacement node is invalid', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: { chatId: 'chat-1', body: 'invalid server node' } } } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createThreadMessages('ReplaceAtomicInvalid');
    diagnostics().reset();
    const tempId = 'temp-rejected-replacement';
    messages.scopes.thread.seed(
      { chatId: 'chat-1' },
      [{ id: tempId, chatId: 'chat-1', body: 'optimistic', media: { id: 'media-1', transcodeStatus: 'processing', fileUrl: 'file:///spool.mp4' } }]
    );
    const reader = renderCounted(() => messages.scopes.thread.use({ chatId: 'chat-1' }));
    expect(reader.result().map((row: any) => row.id)).toEqual([tempId]);
    const send = messages.mutation('send-invalid', {
      document,
      result: 'send',
      optimistic: {
        model: messages,
        existingTempId: () => tempId,
        build: () => ({ id: tempId, chatId: 'chat-1', body: 'optimistic', media: { id: 'media-1', transcodeStatus: 'processing', fileUrl: 'file:///spool.mp4' } }),
        selectServerNode: (data: any) => data.send.message
      }
    });

    await expect(
      act(async () => {
        await send.run({});
      })
    ).rejects.toThrow('replace rejected');

    expect(messages.find(tempId)).toMatchObject({ body: 'optimistic' });
    expect(reader.result().map((row: any) => row.id)).toEqual([tempId]);
    expect(diagnostics().snapshot().replaceRejected).toBe(1);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'replacement-rejected', model: messages.modelId, count: 1 });
    reader.unmount();
  });

  it('uses the replaced temp row as merge base while moving identity to the server id', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: { id: 'message-server', chatId: 'chat-1', body: 'server body', media: { id: 'media-1', transcodeStatus: 'processing', fileUrl: 'https://cdn/processing.mp4' } } } } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createThreadMessages('ReplaceMergeBase', { mergeMedia: true });
    const reader = renderCounted(() => messages.scopes.thread.use({ chatId: 'chat-1' }));
    let tempId = '';
    const send = messages.mutation('send-regression', {
      document,
      result: 'send',
      optimistic: {
        model: messages,
        build: (_input: Record<string, never>, context: { tempId: string | null }) => {
          tempId = context.tempId!;
          return { id: tempId, chatId: 'chat-1', body: 'optimistic body', media: { id: 'media-1', transcodeStatus: 'completed', fileUrl: 'file:///terminal.mp4' } };
        },
        selectServerNode: (data: any) => data.send.message
      }
    });

    await act(async () => {
      await send.run({});
    });

    expect(messages.find(tempId)).toBeUndefined();
    expect(messages.find('message-server')).toMatchObject({ body: 'server body', media: { transcodeStatus: 'completed', fileUrl: 'file:///terminal.mp4' } });
    expect(reader.result().map((row: any) => row.id)).toEqual(['message-server']);
    reader.unmount();
  });

  it('keeps valid non-gated replacement behavior and thread membership unchanged', async () => {
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: { id: 'message-server', chatId: 'chat-1', body: 'server body', media: { id: 'media-1', transcodeStatus: 'processing', fileUrl: 'https://cdn/file.mp4' } } } } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createThreadMessages('ReplaceControl');
    const reader = renderCounted(() => messages.scopes.thread.use({ chatId: 'chat-1' }));
    let tempId = '';
    const send = messages.mutation('send-control', {
      document,
      result: 'send',
      optimistic: {
        model: messages,
        build: (_input: Record<string, never>, context: { tempId: string | null }) => {
          tempId = context.tempId!;
          return { id: tempId, chatId: 'chat-1', body: 'optimistic body', media: { id: 'media-1', transcodeStatus: 'processing', fileUrl: 'file:///spool.mp4' } };
        },
        selectServerNode: (data: any) => data.send.message
      }
    });

    await act(async () => {
      await send.run({});
    });

    expect(messages.find(tempId)).toBeUndefined();
    expect(messages.find('message-server')).toMatchObject({ body: 'server body', media: { fileUrl: 'https://cdn/file.mp4' } });
    expect(reader.result().map((row: any) => row.id)).toEqual(['message-server']);
    reader.unmount();
  });
});

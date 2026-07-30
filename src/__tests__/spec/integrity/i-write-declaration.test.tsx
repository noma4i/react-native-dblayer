import { act } from 'react';
import { configureDb, defineModel, defineShape, f } from '../../legacyTestApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

const createMediaModel = (id: string) => {
  const media = defineShape()({ width: f.num().nullable(), height: f.num().nullable(), fileUrl: f.str().nullable(), blurHash: f.str().nullable() });
  return defineModel({
    id,
    name: id,
    fields: { body: f.str(), media: f.object(media) },
    maintenance: { dropTempRowsAfterMs: 1000 },
    write: { groups: [{ fields: ['media'] as const, policy: { keys: { width: 'positive', height: 'positive', fileUrl: 'nonEmpty', thumbUrl: 'nonEmpty', coverUrl: 'nonEmpty', blurHash: 'nonEmpty' } } }] }
  });
};

describe('model-owned write declarations', () => {
  it('G3 does not apply a query response with GraphQL errors', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', body: 'rejected', media: { width: null, height: null, fileUrl: null, blurHash: null } }] } as TData, errors: [{ message: 'forbidden' }] }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createMediaModel('WriteDeclarationGraphqlErrors');
    const query = rows.query<{ rows: Array<{ id: string; body: string; media: { width: number | null; height: number | null; fileUrl: string | null; blurHash: string | null } }> }, void, Record<string, never>, { id: string; body: string; media: { width: number | null; height: number | null; fileUrl: string | null; blurHash: string | null } }>('graphql-errors', { document, select: data => data.rows, into: rows });

    await expect(query.fetch({})).rejects.toThrow('forbidden');

    expect(rows.find('row-1')).toBeUndefined();
  });

  it('keeps an optimistic patch through a foreign event patch and accepts its committed server value', async () => {
    let resolveMutation!: (value: { data: { pin: { id: string; pinned: boolean } } }) => void;
    const transport = createMockTransport({ mutation: async <TData,>() => await new Promise<{ data: TData }>(resolve => (resolveMutation = resolve as typeof resolveMutation)) });
    configureDb({ storage: createMemoryPlane(), transport });
    const chats = defineModel({ id: 'WriteDeclarationOwnedCommit', name: 'WriteDeclarationOwnedCommit', fields: { pinned: f.bool() } });
    chats.insert({ id: 'chat-1', pinned: false });
    const pin = chats.mutation<{ pin: { id: string; pinned: boolean } }, Record<string, never>, { id: string; pinned: boolean }, { id: string; pinned: boolean }>('pin', {
      document,
      result: 'pin',
      dedupe: false,
      optimistic: { method: 'patch', model: chats, selectId: () => 'chat-1', selectPatch: () => ({ pinned: true }) },
      extract: ({ data }) => [{ into: chats, rows: [data.pin] }]
    });
    const ingest = chats.ingest({ remotePatch: { apply: payload => chats.update('chat-1', payload as { pinned: boolean }) } });
    let pending!: Promise<{ id: string; pinned: boolean } | null>;

    act(() => {
      pending = pin.run({});
      ingest.apply('remotePatch', { pinned: false });
    });
    expect(chats.find('chat-1')?.pinned).toBe(true);

    resolveMutation({ data: { pin: { id: 'chat-1', pinned: false } } });
    await act(async () => {
      await pending;
    });
    expect(chats.find('chat-1')?.pinned).toBe(false);
  });

  it('lets its own rollback restore the pre-mutation value after a foreign event patch is dropped', async () => {
    let rejectMutation!: (error: Error) => void;
    const transport = createMockTransport({ mutation: async <TData,>() => await new Promise<{ data: TData }>((_resolve, reject) => (rejectMutation = reject)) });
    configureDb({ storage: createMemoryPlane(), transport });
    const chats = defineModel({ id: 'WriteDeclarationOwnedRollback', name: 'WriteDeclarationOwnedRollback', fields: { pinned: f.bool() } });
    chats.insert({ id: 'chat-1', pinned: false });
    const pin = chats.mutation<{ pin: { id: string; pinned: boolean } }, Record<string, never>, { id: string; pinned: boolean }, { id: string; pinned: boolean }>('pin', {
      document,
      result: 'pin',
      dedupe: false,
      optimistic: { method: 'patch', model: chats, selectId: () => 'chat-1', selectPatch: () => ({ pinned: true }) }
    });
    const ingest = chats.ingest({ remotePatch: { apply: payload => chats.update('chat-1', payload as { pinned: boolean }) } });
    let pending!: Promise<{ id: string; pinned: boolean } | null>;

    act(() => {
      pending = pin.run({});
      ingest.apply('remotePatch', { pinned: false });
    });
    expect(chats.find('chat-1')?.pinned).toBe(true);

    rejectMutation(new Error('pin failed'));
    await act(async () => {
      await expect(pending).rejects.toThrow('pin failed');
    });
    expect(chats.find('chat-1')?.pinned).toBe(false);
  });

  it('keeps media guards for event ingest but lets commit replacement use server values', async () => {
    const server = { id: 'server-1', body: 'server body', media: { width: 0, height: 0, fileUrl: 'https://cdn/file.mp4', blurHash: 'server-blur' } };
    const optimistic = { body: 'optimistic body', media: { width: 320, height: 240, fileUrl: 'file:///local.mp4', blurHash: null } };
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: server } } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const committed = createMediaModel('WriteDeclarationCommit');
    const send = committed.mutation('send', {
      document,
      result: 'send',
      optimistic: {
        model: committed,
        build: (_input: Record<string, never>, context: { tempId: string | null }) => ({ id: context.tempId!, ...optimistic }),
        selectServerNode: (data: any) => data.send.message
      }
    });

    await act(async () => {
      await send.run({});
    });

    const evented = createMediaModel('WriteDeclarationEvent');
    evented.insert({ id: 'event-1', ...optimistic });
    evented.ingest({ received: { handler: () => ({ upsert: { ...server, id: 'event-1' } }) } }).apply('received', {});

    expect(committed.find('server-1')?.media).toEqual({ width: 0, height: 0, fileUrl: 'https://cdn/file.mp4', blurHash: 'server-blur' });
    expect(evented.find('event-1')?.media).toEqual({ width: 320, height: 240, fileUrl: 'https://cdn/file.mp4', blurHash: 'server-blur' });
  });

  it('keeps continuity fields for nullish incoming values but accepts empty strings', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const rows = defineModel({
      id: 'WriteDeclarationContinuity',
      name: 'WriteDeclarationContinuity',
      fields: { localPreviewUrl: f.str().nullable() },
      write: { groups: [{ fields: ['localPreviewUrl'] as const, policy: 'continuity' }] }
    });
    rows.insert({ id: 'row-1', localPreviewUrl: 'file:///preview.jpg' });
    const ingest = rows.ingest({ received: { handler: payload => ({ upsert: payload }) } });

    ingest.apply('received', { id: 'row-1', localPreviewUrl: null });
    expect(rows.find('row-1')?.localPreviewUrl).toBe('file:///preview.jpg');
    ingest.apply('received', { id: 'row-1', localPreviewUrl: 'file:///next.jpg' });
    expect(rows.find('row-1')?.localPreviewUrl).toBe('file:///next.jpg');
    rows.update('row-1', { localPreviewUrl: null });
    expect(rows.find('row-1')?.localPreviewUrl).toBe('file:///next.jpg');
    ingest.apply('received', { id: 'row-1', localPreviewUrl: '' });
    expect(rows.find('row-1')?.localPreviewUrl).toBe('');
  });

  it('uses the server default for ungrouped fields across event, snapshot, and replace writes', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', body: 'next snapshot' }] } as TData }),
      mutation: async <TData,>() => ({ data: { send: { message: { id: 'server-1', body: 'server' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel({
      id: 'WriteDeclarationAccept',
      name: 'WriteDeclarationAccept',
      fields: { body: f.str() },
      maintenance: { dropTempRowsAfterMs: 1000 }
    });
    rows.insert({ id: 'row-1', body: 'snapshot' });
    rows.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', body: 'event' } }) } }).apply('received', {});
    expect(rows.find('row-1')?.body).toBe('event');
    const snapshot = rows.query<{ rows: Array<{ id: string; body: string }> }, void, Record<string, never>, { id: string; body: string }>('snapshot', {
      document,
      key: 'write-declaration-snapshot',
      select: data => data.rows,
      into: rows
    });
    await snapshot.fetch({});
    expect(rows.find('row-1')?.body).toBe('next snapshot');

    const send = rows.mutation('send', {
      document,
      result: 'send',
      optimistic: {
        model: rows,
        build: (_input: Record<string, never>, context: { tempId: string | null }) => ({ id: context.tempId!, body: 'optimistic' }),
        selectServerNode: (data: any) => data.send.message
      }
    });
    await act(async () => {
      await send.run({});
    });
    expect(rows.find('server-1')?.body).toBe('server');
  });
});

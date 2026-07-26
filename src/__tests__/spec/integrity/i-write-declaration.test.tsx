import { act } from 'react-test-renderer';
import { configureDb, defineModel, defineShape, f, mergeOptimisticMedia } from '../../../index';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

const createMediaModel = (id: string) => {
  const media = defineShape()({ width: f.num().nullable(), height: f.num().nullable(), fileUrl: f.str().nullable(), blurHash: f.str().nullable() });
  return defineModel({
    id,
    name: id,
    fields: { body: f.str(), media: f.object(media) },
    write: { groups: [{ fields: ['media'] as const, policy: { merge: (current, incoming) => mergeOptimisticMedia(current, incoming) } }] }
  });
};

describe('model-owned write declarations', () => {
  it('applies the same media merge group to commit replacement and event ingest', async () => {
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

    expect(committed.find('server-1')?.media).toEqual({ width: 320, height: 240, fileUrl: 'https://cdn/file.mp4', blurHash: 'server-blur' });
    expect(evented.find('event-1')?.media).toEqual(committed.find('server-1')?.media);
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

  it('passes origin to accept and bypasses acceptance for replace', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', body: 'next snapshot' }] } as TData }),
      mutation: async <TData,>() => ({ data: { send: { message: { id: 'server-1', body: 'server' } } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel({
      id: 'WriteDeclarationAccept',
      name: 'WriteDeclarationAccept',
      fields: { body: f.str() },
      write: { accept: (_existing, _incoming, ctx) => ctx.origin !== 'event' }
    });
    rows.insert({ id: 'row-1', body: 'snapshot' });
    rows.ingest({ received: { handler: () => ({ upsert: { id: 'row-1', body: 'event' } }) } }).apply('received', {});
    expect(rows.find('row-1')?.body).toBe('snapshot');
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

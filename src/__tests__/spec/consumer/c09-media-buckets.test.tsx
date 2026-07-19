import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type MediaRow = { id: string; chatId: string; mediaBucket: string; sequenceNumber: number; label: string };
type MediaScopeValue = { chatId: string; mediaBucket: string };
type MediaResponse = {
  mediaItems: {
    nodes: Array<MediaRow>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type CallEntry = { kind: 'query'; operation: { variables: MediaScopeValue & { after?: string | null } } };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const createMediaModel = () =>
  defineModel({
    id: 'SpecConsumerMediaBuckets',
    name: 'SpecConsumerMediaBuckets',
    fields: {
      id: f.str(),
      chatId: f.str(),
      mediaBucket: f.str(),
      sequenceNumber: f.num(),
      label: f.str()
    },
    scopes: {
      media: scope<MediaRow>({
        by: { chatId: 'chatId', mediaBucket: 'mediaBucket' },
        sort: { field: 'sequenceNumber', dir: 'desc' }
      })
    }
  });

const createQueueTransport = (responses: MediaResponse[]) => {
  const transport = createMockTransport({
    query: async <TData,>() => {
      const next = responses.shift();
      if (!next) throw new Error('Unexpected query response');
      return { data: next as TData };
    }
  });
  return transport as unknown as ReturnType<typeof createMockTransport> & { calls: Array<CallEntry> };
};

const renderCountedInProvider = <T,>(useHook: () => T) => {
  let value!: T;
  let renderCount = 0;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    value = useHook();
    renderCount += 1;
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });

  return {
    result: () => value,
    renders: () => renderCount,
    unmount: () => act(() => root.unmount())
  };
};

describe('media scope bucket behavior', () => {
  it('isolates composite bucket scope by chatId and mediaBucket', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const media = createMediaModel();
    media.insertStored({ id: 'a-1', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 10, label: 'A-1' });
    media.insertStored({ id: 'a-2', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 8, label: 'A-2' });
    media.insertStored({ id: 'b-1', chatId: 'chat-1', mediaBucket: 'B', sequenceNumber: 9, label: 'B-1' });

    const bucketAReader = renderCounted(() => media.scopes.media.use({ chatId: 'chat-1', mediaBucket: 'A' }));
    const before = bucketAReader.renders();

    act(() => {
      media.patch('b-1', { label: 'B-1-updated' });
    });

    expect(bucketAReader.renders() - before).toBe(0);
    expect(bucketAReader.result().map(row => row.id)).toEqual(['a-1', 'a-2']);
    bucketAReader.unmount();
  });

  it('uses forward direction cursor from last row and preserves scope sort while appending pages', async () => {
    const responses = [
      {
        mediaItems: {
          nodes: [
            { id: 'a-1', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 30, label: 'first' },
            { id: 'a-2', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 20, label: 'second' }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-20' }
        }
      },
      {
        mediaItems: {
          nodes: [
            { id: 'a-4', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 5, label: 'last-unsorted' },
            { id: 'a-3', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 12, label: 'middle' }
          ],
          pageInfo: { hasNextPage: false, endCursor: 'cursor-5' }
        }
      }
    ];

    const transport = createQueueTransport(responses);
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createMediaModel();
    const query = media.query<MediaResponse, MediaScopeValue & { after?: string | null }, MediaScopeValue, MediaRow>('media', {
      document,
      vars: value => ({ chatId: value.chatId, mediaBucket: value.mediaBucket }),
      page: data => ({ nodes: data.mediaItems.nodes, pageInfo: data.mediaItems.pageInfo }),
      into: media.scopes.media,
      coverage: 'page',
      direction: 'forward'
    });

    const queryReader = renderCountedInProvider(() => query.use({ chatId: 'chat-1', mediaBucket: 'A' }));
    const bucketAReader = renderCounted(() => media.scopes.media.use({ chatId: 'chat-1', mediaBucket: 'A' }));

    await settle();
    expect(bucketAReader.result().map(row => row.id)).toEqual(['a-1', 'a-2']);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();

    const secondCallVariables = transport.calls[1]?.operation.variables;
    expect(secondCallVariables?.after).toBe('cursor-20');
    expect(bucketAReader.result().map(row => row.id)).toEqual(['a-1', 'a-2', 'a-3', 'a-4']);

    queryReader.unmount();
    bucketAReader.unmount();
  });

  it.failing('writes query rows to matching composite buckets in destination scope', async () => {
    // GAP: query destination writes are still assigned by query scope, so mixed-bucket payloads can be added to the requested bucket.
    const transport = createMockTransport({
      query: async <TData,>() =>
        ({
          data: {
            mediaItems: {
              nodes: [
                { id: 'a-1', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 30, label: 'bucket-a' },
                { id: 'b-1', chatId: 'chat-1', mediaBucket: 'B', sequenceNumber: 28, label: 'bucket-b' },
                { id: 'a-2', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 22, label: 'bucket-a-2' }
              ],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
              } as TData
            })
    });

    configureDb({ storage: createMemoryPlane(), transport });
    const media = createMediaModel();
    const query = media.query<MediaResponse, MediaScopeValue, MediaScopeValue, MediaRow>('media-mixed', {
      document,
      vars: value => ({ chatId: value.chatId, mediaBucket: value.mediaBucket }),
      page: data => ({ nodes: data.mediaItems.nodes, pageInfo: data.mediaItems.pageInfo }),
      into: media.scopes.media,
      coverage: 'page',
      direction: 'forward'
    });

    const queryReader = renderCountedInProvider(() => query.use({ chatId: 'chat-1', mediaBucket: 'A' }));
    await settle();

    const bucketA = media.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'A' });
    const bucketB = media.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'B' });

    expect(bucketA.map(row => row.id).sort()).toEqual(['a-1', 'a-2']);
    expect(bucketB.map(row => row.id).sort()).toEqual(['b-1']);

    queryReader.unmount();
  });
});

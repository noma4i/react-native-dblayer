import { act } from 'react';
import { configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, settle, renderCountedInProvider } from '../helpers/harness';

type MediaRow = { id: string; chatId: string; mediaBucket: string; sequenceNumber: number; label: string };
type MediaScopeValue = { chatId: string; mediaBucket: string };
type DerivedMediaInput = { id: string; chatId: string; media?: { kind?: 'audio' | 'video' | null } | null; sequenceNumber: number; label: string };
type DerivedMediaRow = { id: string; chatId: string; bucket: 'audio' | 'visual' | null; sequenceNumber: number; label: string };
type DerivedMediaScopeValue = { chatId: string; bucket: 'audio' | 'visual' };
type MediaResponse = {
  mediaItems: {
    nodes: Array<MediaRow>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type CallEntry = { kind: 'query'; operation: { variables: MediaScopeValue & { after?: string | null } } };

const document = { kind: 'Document', definitions: [] } as never;

const createMediaModel = (onCompare?: () => void) =>
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
        sort:
          onCompare === undefined
            ? { field: 'sequenceNumber', dir: 'desc' }
            : {
                comparator: (left, right) => {
                  onCompare();
                  return right.sequenceNumber - left.sequenceNumber;
                },
                orderFields: ['sequenceNumber']
              }
      })
    }
  });

const createDerivedMediaModel = () =>
  defineModel({
    id: 'SpecConsumerDerivedMediaBuckets',
    name: 'SpecConsumerDerivedMediaBuckets',
    fields: {
      id: f.str(),
      chatId: f.str(),
      bucket: f.custom<'audio' | 'visual' | null, DerivedMediaInput>(input => (input.media?.kind === 'audio' ? 'audio' : input.media?.kind ? 'visual' : null)).nullable(),
      sequenceNumber: f.num(),
      label: f.str()
    },
    scopes: {
      media: scope<DerivedMediaRow>({
        by: { chatId: 'chatId', bucket: 'bucket' },
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

describe('media scope bucket behavior', () => {
  it('keeps derived custom bucket membership instances distinct', async () => {
    const responses = [
      { mediaItems: { nodes: [{ id: 'audio-1', chatId: 'chat-1', media: { kind: 'audio' as const }, sequenceNumber: 20, label: 'audio' }] } },
      { mediaItems: { nodes: [{ id: 'visual-1', chatId: 'chat-1', media: { kind: 'video' as const }, sequenceNumber: 10, label: 'visual' }] } }
    ];
    const transport = createMockTransport({ query: async <TData,>() => ({ data: responses.shift() as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createDerivedMediaModel();
    const query = media.query<{ mediaItems: { nodes: DerivedMediaInput[] } }, DerivedMediaScopeValue, DerivedMediaScopeValue, DerivedMediaRow>('derived-media-membership', {
      document,
      vars: value => value,
      select: data => data.mediaItems.nodes,
      into: media.scopes.media
    });
    const audio = { chatId: 'chat-1', bucket: 'audio' } as const;
    const visual = { chatId: 'chat-1', bucket: 'visual' } as const;

    await query.fetch(audio);
    await query.fetch(visual);

    expect(media.scopes.media.read(audio).map(row => row.id)).toEqual(['audio-1']);
    expect(media.scopes.media.read(visual).map(row => row.id)).toEqual(['visual-1']);
  });

  it('counts only rows from the selected derived custom bucket', async () => {
    const responses = [
      { mediaItems: { nodes: [{ id: 'audio-1', chatId: 'chat-1', media: { kind: 'audio' as const }, sequenceNumber: 20, label: 'audio' }] } },
      { mediaItems: { nodes: [{ id: 'visual-1', chatId: 'chat-1', media: { kind: 'video' as const }, sequenceNumber: 10, label: 'visual' }] } }
    ];
    const transport = createMockTransport({ query: async <TData,>() => ({ data: responses.shift() as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createDerivedMediaModel();
    const query = media.query<{ mediaItems: { nodes: DerivedMediaInput[] } }, DerivedMediaScopeValue, DerivedMediaScopeValue, DerivedMediaRow>('derived-media-count', {
      document,
      vars: value => value,
      select: data => data.mediaItems.nodes,
      into: media.scopes.media
    });
    const audio = { chatId: 'chat-1', bucket: 'audio' } as const;
    const visual = { chatId: 'chat-1', bucket: 'visual' } as const;

    await query.fetch(audio);
    await query.fetch(visual);

    const audioCount = renderCounted(() => media.scopes.media.useCount(audio));
    const visualCount = renderCounted(() => media.scopes.media.useCount(visual));
    expect(audioCount.result()).toBe(1);
    expect(visualCount.result()).toBe(1);
    audioCount.unmount();
    visualCount.unmount();
  });

  it('matches derived custom query destination keys with row membership keys', async () => {
    const responses = [
      {
        mediaItems: {
          nodes: [{ id: 'audio-1', chatId: 'chat-1', media: { kind: 'audio' as const }, sequenceNumber: 20, label: 'audio' }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      },
      {
        mediaItems: {
          nodes: [{ id: 'visual-1', chatId: 'chat-1', media: { kind: 'video' as const }, sequenceNumber: 10, label: 'visual' }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    ];
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createDerivedMediaModel();
    const query = media.query<{ mediaItems: { nodes: DerivedMediaInput[] } }, DerivedMediaScopeValue, DerivedMediaScopeValue, DerivedMediaRow>('derived-media', {
      document,
      vars: value => value,
      select: data => data.mediaItems.nodes,
      into: media.scopes.media
    });
    const audio = { chatId: 'chat-1', bucket: 'audio' } as const;
    const visual = { chatId: 'chat-1', bucket: 'visual' } as const;

    await query.fetch(audio);
    await query.fetch(visual);

    expect(media.scopes.media.read(audio).map(row => row.id)).toEqual(['audio-1']);
    expect(media.scopes.media.read(visual).map(row => row.id)).toEqual(['visual-1']);
  });

  it('preserves derived behavior through nullable custom field chaining', () => {
    const field = f.custom<'audio' | 'visual' | null, DerivedMediaInput>(input => (input.media?.kind === 'audio' ? 'audio' : input.media?.kind ? 'visual' : null)).nullable();

    expect(field.derived).toBe(true);
  });

  it('isolates composite bucket scope by chatId and mediaBucket', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const media = createMediaModel();
    media.insert({ id: 'a-1', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 10, label: 'A-1' });
    media.insert({ id: 'a-2', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 8, label: 'A-2' });
    media.insert({ id: 'b-1', chatId: 'chat-1', mediaBucket: 'B', sequenceNumber: 9, label: 'B-1' });

    const bucketAReader = renderCounted(() => media.scopes.media.use({ chatId: 'chat-1', mediaBucket: 'A' }));
    const before = bucketAReader.renders();

    act(() => {
      media.update('b-1', { label: 'B-1-updated' });
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

  it('globally resorts retained pages with a refreshed first page', async () => {
    const responses: MediaResponse[] = [
      {
        mediaItems: {
          nodes: [
            { id: 'old-30', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 30, label: 'old-head' },
            { id: 'old-20', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 20, label: 'old-second' }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-20' }
        }
      },
      {
        mediaItems: {
          nodes: [
            { id: 'old-5', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 5, label: 'old-tail' },
            { id: 'old-12', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 12, label: 'old-third' }
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      },
      {
        mediaItems: {
          nodes: [
            { id: 'new-25', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 25, label: 'new-second' },
            { id: 'new-40', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 40, label: 'new-head' }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-25' }
        }
      }
    ];
    let comparisons = 0;
    const transport = createQueueTransport(responses);
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createMediaModel(() => {
      comparisons += 1;
    });
    const query = media.query<MediaResponse, MediaScopeValue & { after?: string | null }, MediaScopeValue, MediaRow>('media-refresh-order', {
      document,
      vars: value => ({ chatId: value.chatId, mediaBucket: value.mediaBucket }),
      page: data => data.mediaItems,
      into: media.scopes.media,
      coverage: 'page',
      direction: 'forward'
    });
    const scopeValue = { chatId: 'chat-1', mediaBucket: 'A' };
    const queryReader = renderCountedInProvider(() => query.use(scopeValue));

    await settle();
    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    comparisons = 0;
    await act(async () => {
      await queryReader.result().refetch();
    });

    expect(media.scopes.media.read(scopeValue).map(row => row.id)).toEqual(['new-40', 'old-30', 'new-25', 'old-20', 'old-12', 'old-5']);
    expect(comparisons).toBeLessThanOrEqual(30);
    queryReader.unmount();
  });

  it('refreshes an invalidated active page without continuing its cursor', async () => {
    const responses: MediaResponse[] = [
      {
        mediaItems: {
          nodes: [{ id: 'old-30', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 30, label: 'old' }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-30' }
        }
      },
      {
        mediaItems: {
          nodes: [{ id: 'new-40', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 40, label: 'new' }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-40' }
        }
      }
    ];
    const transport = createQueueTransport(responses);
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createMediaModel();
    const query = media.query<MediaResponse, MediaScopeValue & { after?: string | null }, MediaScopeValue, MediaRow>('media-invalidate-reset', {
      document,
      vars: value => ({ chatId: value.chatId, mediaBucket: value.mediaBucket }),
      page: data => data.mediaItems,
      into: media.scopes.media,
      coverage: 'page',
      direction: 'forward'
    });
    const scopeValue = { chatId: 'chat-1', mediaBucket: 'A' };
    const queryReader = renderCountedInProvider(() => query.use(scopeValue));

    await settle();
    query.invalidate(scopeValue);
    await settle();

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]?.operation.variables).not.toHaveProperty('after');
    queryReader.unmount();
  });

  it('writes query rows to matching composite buckets in destination scope', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
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

  it('derives composite membership for query extract sinks', async () => {
    type ExtractResponse = { carrier: { id: string; label: string }; media: MediaRow[] };
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          carrier: { id: 'carrier-1', label: 'carrier' },
          media: [{ id: 'b-1', chatId: 'chat-1', mediaBucket: 'B', sequenceNumber: 10, label: 'bucket-b' }]
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createMediaModel();
    const carriers = defineModel({ id: 'SpecCompositeCarrierQuery', name: 'SpecCompositeCarrierQuery', fields: { label: f.str() } });
    const query = carriers.query<ExtractResponse, Record<string, never>, Record<string, never>, { id: string; label: string }>('with-media', {
      document,
      vars: value => value,
      select: data => data.carrier,
      into: carriers,
      extract: ({ data }) => [{ into: media, rows: data.media }]
    });

    await query.fetch({});

    expect(media.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'B' }).map(row => row.id)).toEqual(['b-1']);
  });

  it('keeps composite membership derivation for mutation extract sinks', async () => {
    type MutationResponse = { save: { id: string; label: string }; media: MediaRow[] };
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: {
          save: { id: 'carrier-1', label: 'carrier' },
          media: [{ id: 'a-1', chatId: 'chat-1', mediaBucket: 'A', sequenceNumber: 10, label: 'bucket-a' }]
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const media = createMediaModel();
    const carriers = defineModel({ id: 'SpecCompositeCarrierMutation', name: 'SpecCompositeCarrierMutation', fields: { label: f.str() } });
    const mutation = carriers.mutation<MutationResponse, Record<string, never>, { id: string; label: string }, never>('with-media', {
      document,
      result: 'save',
      extract: ({ data }) => [{ into: media, rows: data.media }]
    });

    await mutation.run({});

    expect(media.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'A' }).map(row => row.id)).toEqual(['a-1']);
  });

  it('keeps composite membership derivation for ingest upserts', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const media = createMediaModel();
    const ingest = media.ingest({ mediaReceived: { apply: 'upsert' } });

    ingest.apply('mediaReceived', { id: 'b-1', chatId: 'chat-1', mediaBucket: 'B', sequenceNumber: 10, label: 'bucket-b' });

    expect(media.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'B' }).map(row => row.id)).toEqual(['b-1']);
  });

  it('places optimistic rows into the selected composite server-order scope', () => {
    const transport = createMockTransport({ mutation: () => new Promise(() => undefined) });
    configureDb({ storage: createMemoryPlane(), transport });
    const media = defineModel({
      id: 'SpecCompositePlacement',
      name: 'SpecCompositePlacement',
      fields: { chatId: f.str(), mediaBucket: f.str(), label: f.str() },
      maintenance: { dropTempRowsAfterMs: 1000 },
      scopes: { media: scope<{ id: string; chatId: string; mediaBucket: string; label: string }>({ by: { chatId: 'chatId', mediaBucket: 'mediaBucket' }, sort: 'server-order' }) }
    });
    const mutation = media.mutation<
      { save: { id: string; chatId: string; mediaBucket: string; label: string } },
      MediaScopeValue,
      { id: string; chatId: string; mediaBucket: string; label: string },
      { id: string; chatId: string; mediaBucket: string; label: string }
    >('create', {
      document,
      result: 'save',
      optimistic: {
        model: media,
        build: input => ({ id: '', chatId: input.chatId, mediaBucket: input.mediaBucket, label: 'pending' }),
        selectServerNode: data => data.save,
        prependTo: { scope: media.scopes.media, value: input => input }
      }
    });

    void mutation.run({ chatId: 'chat-1', mediaBucket: 'B' });

    expect(media.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'A' })).toEqual([]);
    expect(media.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'B' }).map(row => row.label)).toEqual(['pending']);
  });
});

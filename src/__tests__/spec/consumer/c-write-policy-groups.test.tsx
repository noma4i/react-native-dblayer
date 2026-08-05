import { act } from 'react';
import { configureDb, createCommitEnvelope, defineModelRuntime, f, getApplyRuntime, getInternalModelHandle } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type ChatRow = {
  id: string;
  name: string;
  lastMessageId: string;
  lastMessageAt: string;
  lastSequenceNumber: number;
  mediaStatus: string;
  mediaSequenceNumber: number;
};

const createChatModel = (id: string, groups = true) =>
  defineModelRuntime({
    id,
    name: id,
    fields: {
      name: f.str(),
      lastMessageId: f.str(),
      lastMessageAt: f.str(),
      lastSequenceNumber: f.num(),
      mediaStatus: f.str(),
      mediaSequenceNumber: f.num()
    },
    ...(groups
      ? {
          write: {
            groups: [
              {
                fields: ['lastMessageId', 'lastMessageAt', 'lastSequenceNumber'] as const,
                policy: { monotonic: { tuple: ['lastSequenceNumber', 'lastMessageAt', 'lastMessageId'] } }
              },
              {
                fields: ['mediaStatus', 'mediaSequenceNumber'] as const,
                policy: { monotonic: { tuple: ['mediaSequenceNumber'] } }
              }
            ]
          }
        }
      : {})
  });

const row = (overrides: Partial<ChatRow> = {}): ChatRow => ({
  id: 'chat-1',
  name: 'Original',
  lastMessageId: 'message-10',
  lastMessageAt: '2026-07-20T00:00:10Z',
  lastSequenceNumber: 10,
  mediaStatus: 'queued',
  mediaSequenceNumber: 10,
  ...overrides
});

describe('per-field write policy', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
  });

  it('[W32] runs a replace onto an already-landed row through snapshot-mode policies', () => {
    const chats = createChatModel('WritePolicyReplaceLanded');
    chats.insert(row());

    // The replace target ALREADY landed through another channel: the response merges into it
    // under snapshot-mode policies, so the guarded group still rejects the older tuple.
    getApplyRuntime().commit(
      createCommitEnvelope(
        getInternalModelHandle(chats).planReplace(
          'chat-1',
          row({ name: 'Swapped', lastMessageId: 'message-5', lastMessageAt: '2026-07-20T00:00:05Z', lastSequenceNumber: 5 })
        )
      )
    );

    expect(chats.find('chat-1')).toMatchObject({
      name: 'Swapped',
      lastMessageId: 'message-10',
      lastMessageAt: '2026-07-20T00:00:10Z',
      lastSequenceNumber: 10
    });
  });

  it('[W33] carries continuity fields through the temp merge base on a fresh replace swap', () => {
    const media = defineModelRuntime({
      id: 'WritePolicyReplaceFresh',
      name: 'WritePolicyReplaceFresh',
      fields: { url: f.str().nullable(), localPreviewUrl: f.str().nullable() },
      write: { groups: [{ fields: ['localPreviewUrl'] as const, policy: 'continuity' }] }
    });
    media.insert({ id: 'tmp:swap-1', url: null, localPreviewUrl: 'file://local-preview' });

    // A fresh swap (the server id never landed): the destroyed temp row is the merge base, so
    // continuity fields the response dropped survive the identity swap.
    getApplyRuntime().commit(
      createCommitEnvelope(getInternalModelHandle(media).planReplace('tmp:swap-1', { id: 'server-1', url: 'https://cdn/1.mp4', localPreviewUrl: null }))
    );

    expect(media.find('tmp:swap-1')).toBeUndefined();
    expect(media.find('server-1')).toMatchObject({ url: 'https://cdn/1.mp4', localPreviewUrl: 'file://local-preview' });
  });

  it('rejects an older bulk snapshot for the guarded group while applying its other fields', () => {
    const chats = createChatModel('WritePolicyOlderBulk');
    chats.insert(row());

    chats.insertMany([row({ name: 'Renamed', lastMessageId: 'message-5', lastMessageAt: '2026-07-20T00:00:05Z', lastSequenceNumber: 5 })]);

    expect(chats.find('chat-1')).toMatchObject({
      name: 'Renamed',
      lastMessageId: 'message-10',
      lastMessageAt: '2026-07-20T00:00:10Z',
      lastSequenceNumber: 10
    });
  });

  it('accepts a newer write for the guarded group', () => {
    const chats = createChatModel('WritePolicyNewer');
    chats.insert(row());

    chats.insert(row({ lastMessageId: 'message-12', lastMessageAt: '2026-07-20T00:00:12Z', lastSequenceNumber: 12 }));

    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'message-12', lastMessageAt: '2026-07-20T00:00:12Z', lastSequenceNumber: 12 });
  });

  it('bypasses guards for brand-new rows', () => {
    const chats = createChatModel('WritePolicyNewRow');

    chats.insert(row({ id: 'chat-2', lastMessageId: 'message-1', lastMessageAt: '2026-07-20T00:00:01Z', lastSequenceNumber: 1 }));

    expect(chats.find('chat-2')).toMatchObject({ lastMessageId: 'message-1', lastSequenceNumber: 1 });
  });

  it('leaves patch writes server-authoritative by default', () => {
    const chats = createChatModel('WritePolicyPatch');
    chats.insert(row());
    const reader = renderCounted(() => chats.use.find('chat-1'));
    const before = reader.renders();

    act(() => {
      chats.update('chat-1', { lastMessageId: 'message-5', lastMessageAt: '2026-07-20T00:00:05Z', lastSequenceNumber: 5 });
    });

    expect(reader.renders() - before).toBe(1);
    expect(reader.result()).toMatchObject({ lastMessageId: 'message-5', lastSequenceNumber: 5 });
    reader.unmount();
  });

  it('emits no wave when a rejected write leaves the row value-equal', () => {
    const chats = createChatModel('WritePolicyNoWave');
    chats.insert(row());
    const reader = renderCounted(() => chats.use.find('chat-1'));
    const before = reader.renders();
    const identity = reader.result();

    act(() => {
      chats.insert(row({ lastMessageId: 'message-5', lastMessageAt: '2026-07-20T00:00:05Z', lastSequenceNumber: 5 }));
    });

    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(identity);
    reader.unmount();
  });

  it('independent groups reject and accept separately in one write', () => {
    const chats = createChatModel('WritePolicyIndependentGroups');
    chats.insert(row());

    chats.insert(row({
      name: 'Renamed',
      lastMessageId: 'message-5',
      lastMessageAt: '2026-07-20T00:00:05Z',
      lastSequenceNumber: 5,
      mediaStatus: 'complete',
      mediaSequenceNumber: 12
    }));

    expect(chats.find('chat-1')).toMatchObject({
      name: 'Renamed',
      lastMessageId: 'message-10',
      lastSequenceNumber: 10,
      mediaStatus: 'complete',
      mediaSequenceNumber: 12
    });
  });

  it('rejects unknown fields and overlapping groups at define time', () => {
    expect(() =>
      defineModelRuntime({
        id: 'WritePolicyUnknownField',
        name: 'WritePolicyUnknownField',
        fields: { name: f.str() },
        write: { groups: [{ fields: ['missing'] as never, policy: 'server' }] }
      })
    ).toThrow('write field missing is not declared');
    expect(() =>
      defineModelRuntime({
        id: 'WritePolicyEmpty',
        name: 'WritePolicyEmpty',
        fields: { name: f.str() },
        write: { groups: [{ fields: [], policy: 'server' }] }
      })
    ).toThrow('write groups must not be empty');
    expect(() =>
      defineModelRuntime({
        id: 'WritePolicyOverlap',
        name: 'WritePolicyOverlap',
        fields: { name: f.str(), status: f.str() },
        write: {
          groups: [
            { fields: ['name'] as const, policy: 'server' },
            { fields: ['name', 'status'] as const, policy: 'server' }
          ]
        }
      })
    ).toThrow('write field name appears in more than one group');
  });
});

import { act } from 'react-test-renderer';
import { configureDb, defineModel, f } from '../../../index';
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
  defineModel({
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
          mergePolicy: {
            groups: [
              {
                fields: ['lastMessageId', 'lastMessageAt', 'lastSequenceNumber'] as const,
                allowWrite: (incoming, current) => (incoming.lastSequenceNumber ?? -1) >= current.lastSequenceNumber
              },
              {
                fields: ['mediaStatus', 'mediaSequenceNumber'] as const,
                allowWrite: (incoming, current) => (incoming.mediaSequenceNumber ?? -1) >= current.mediaSequenceNumber
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

describe('per-field merge policy', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
  });

  it('rejects an older bulk snapshot for the guarded group while applying its other fields', () => {
    const chats = createChatModel('MergePolicyOlderBulk');
    chats.insertStored(row());

    chats.insertStoredMany([row({ name: 'Renamed', lastMessageId: 'message-5', lastMessageAt: '2026-07-20T00:00:05Z', lastSequenceNumber: 5 })]);

    expect(chats.get('chat-1')).toMatchObject({
      name: 'Renamed',
      lastMessageId: 'message-10',
      lastMessageAt: '2026-07-20T00:00:10Z',
      lastSequenceNumber: 10
    });
  });

  it('accepts a newer write for the guarded group', () => {
    const chats = createChatModel('MergePolicyNewer');
    chats.insertStored(row());

    chats.insertStored(row({ lastMessageId: 'message-12', lastMessageAt: '2026-07-20T00:00:12Z', lastSequenceNumber: 12 }));

    expect(chats.get('chat-1')).toMatchObject({ lastMessageId: 'message-12', lastMessageAt: '2026-07-20T00:00:12Z', lastSequenceNumber: 12 });
  });

  it('bypasses guards for brand-new rows', () => {
    const chats = createChatModel('MergePolicyNewRow');

    chats.insertStored(row({ id: 'chat-2', lastMessageId: 'message-1', lastMessageAt: '2026-07-20T00:00:01Z', lastSequenceNumber: 1 }));

    expect(chats.get('chat-2')).toMatchObject({ lastMessageId: 'message-1', lastSequenceNumber: 1 });
  });

  it('guards the patch path with the same policy', () => {
    const chats = createChatModel('MergePolicyPatch');
    chats.insertStored(row());
    const reader = renderCounted(() => chats.use.row('chat-1'));
    const before = reader.renders();

    act(() => {
      chats.patch('chat-1', { lastMessageId: 'message-5', lastMessageAt: '2026-07-20T00:00:05Z', lastSequenceNumber: 5 });
    });

    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toMatchObject({ lastMessageId: 'message-10', lastSequenceNumber: 10 });
    reader.unmount();
  });

  it('emits no wave when a rejected write leaves the row value-equal', () => {
    const chats = createChatModel('MergePolicyNoWave');
    chats.insertStored(row());
    const reader = renderCounted(() => chats.use.row('chat-1'));
    const before = reader.renders();
    const identity = reader.result();

    act(() => {
      chats.insertStored(row({ lastMessageId: 'message-5', lastMessageAt: '2026-07-20T00:00:05Z', lastSequenceNumber: 5 }));
    });

    expect(reader.renders() - before).toBe(0);
    expect(reader.result()).toBe(identity);
    reader.unmount();
  });

  it('independent groups reject and accept separately in one write', () => {
    const chats = createChatModel('MergePolicyIndependentGroups');
    chats.insertStored(row());

    chats.insertStored(row({
      name: 'Renamed',
      lastMessageId: 'message-5',
      lastMessageAt: '2026-07-20T00:00:05Z',
      lastSequenceNumber: 5,
      mediaStatus: 'complete',
      mediaSequenceNumber: 12
    }));

    expect(chats.get('chat-1')).toMatchObject({
      name: 'Renamed',
      lastMessageId: 'message-10',
      lastSequenceNumber: 10,
      mediaStatus: 'complete',
      mediaSequenceNumber: 12
    });
  });

  it('rejects unknown fields and overlapping groups at define time', () => {
    expect(() =>
      defineModel({
        id: 'MergePolicyUnknownField',
        name: 'MergePolicyUnknownField',
        fields: { name: f.str() },
        mergePolicy: { groups: [{ fields: ['missing'] as never, allowWrite: () => true }] }
      })
    ).toThrow('mergePolicy field missing is not declared');
    expect(() =>
      defineModel({
        id: 'MergePolicyEmpty',
        name: 'MergePolicyEmpty',
        fields: { name: f.str() },
        mergePolicy: { groups: [{ fields: [], allowWrite: () => true }] }
      })
    ).toThrow('mergePolicy groups must not be empty');
    expect(() =>
      defineModel({
        id: 'MergePolicyNoGroups',
        name: 'MergePolicyNoGroups',
        fields: { name: f.str() },
        mergePolicy: { groups: [] }
      })
    ).toThrow('mergePolicy groups must not be empty');
    expect(() =>
      defineModel({
        id: 'MergePolicyOverlap',
        name: 'MergePolicyOverlap',
        fields: { name: f.str(), status: f.str() },
        mergePolicy: {
          groups: [
            { fields: ['name'] as const, allowWrite: () => true },
            { fields: ['name', 'status'] as const, allowWrite: () => true }
          ]
        }
      })
    ).toThrow('mergePolicy field name appears in more than one group');
  });
});

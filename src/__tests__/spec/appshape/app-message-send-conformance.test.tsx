import { act } from 'react';
import { configureDb } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';
import { createAppModels } from './appModels';

const document = { kind: 'Document', definitions: [] } as never;
const ownId = 'me';
const time = '2026-07-27T00:00:00Z';

const insertChat = (models: ReturnType<typeof createAppModels>) => {
  models.currentUser.insert({ id: ownId, uuid: ownId, fullName: 'Me', username: 'me', name: null, avatarUrl: null, fullAvatarUrl: null, age: null, gender: null, description: null, story: null, connectionStatus: null, connectionChatId: null, lastInteraction: null, online: true, lastSeenAt: null, distance: null, shareUrl: '', countryName: null, countryCode: null, createdAt: time, updatedAt: time, email: null, phone: null, registrationCompleted: true, balance: 0, premiumGrant: null, dob: null, locationCity: null, locationName: null, locationLat: null, locationLng: null, filterDistance: null, filterGender: 'all', filterMinAge: 18, filterMaxAge: 99, kind: 'user', hasCompass: false, hasMoments: false, hasPhoto: false, hasGoodPhoto: false, hasInitialMoment: false, stickyLocation: false, status: 'active', preferenceNotifyConnection: true, preferenceNotifyMessage: true, preferenceVibration: true, receivedGifts: [] });
  models.chats.insert({ id: 'chat-1', uuid: null, kind: 'personal', status: 'active', premium: false, name: null, logoUrl: null, description: null, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt: time, lastMessageAt: null, lastSequenceNumber: null, lastMessageId: null, readMarksSummary: null, summary: null, connectionStatus: null, userIds: [], ownerId: null, createdAt: time, updatedAt: time });
};

const message = (id: string, overrides: Record<string, unknown> = {}) => ({ id, chatId: 'chat-1', userId: ownId, body: 'hello', kind: 'text', status: 'Sending' as const, createdAt: time, updatedAt: time, sequenceNumber: 1, mediaGroupId: null, replyToId: null, media: null, mediaBucket: null, localPreviewUrl: null, clientId: id, ...overrides });

describe('app message send conformance', () => {
  it('C1 text success keeps one UI row while replacing the optimistic id with the server id', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => ({ data: { send: { message: message('server-1', { status: 'Sent', clientId: 'temp-1' }) } } as TData }) }) });
    const models = createAppModels('MessageConformanceSuccess');
    insertChat(models);
    const reader = renderCounted(() => models.messages.scopes.thread.use({ chatId: 'chat-1' }));
    const send = models.messages.mutation('send', { document, result: 'send', optimistic: { model: models.messages, existingTempId: () => 'temp-1', build: () => message('temp-1'), selectServerNode: (data: any) => data.send.message } });
    models.messages.scopes.thread.seed({ chatId: 'chat-1' }, [message('temp-1')]);

    await act(async () => { await send.run({}); });

    expect(models.messages.find('temp-1')).toBeUndefined();
    expect(models.messages.find('server-1')).toMatchObject({ id: 'server-1', body: 'hello', status: 'Sent', clientId: 'temp-1' });
    expect(reader.result().map((row: any) => row.id)).toEqual(['server-1']);
    reader.unmount();
  });

  it('C2 incoming other-user message through ingest updates the thread, preview, and unread counter', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('MessageConformanceIncoming');
    insertChat(models);
    const ingest = models.messages.ingest({ messageCreated: { handler: (payload: unknown) => ({ upsert: (payload as { message: Record<string, unknown> }).message }) } });

    act(() => { ingest.apply('messageCreated', { message: message('server-other', { userId: 'other', status: 'Sent', sequenceNumber: 2, createdAt: '2026-07-27T00:01:00Z', updatedAt: '2026-07-27T00:01:00Z' }) }); });

    expect(models.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id)).toEqual(['server-other']);
    expect(models.chats.find('chat-1')).toMatchObject({ lastMessageId: 'server-other', unreadCount: 1 });
  });

  it('C3 media and thread scopes share sequence-first order with a createdAt fallback for optimistic rows', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('MessageConformanceMediaOrder');
    insertChat(models);
    models.messages.insert(
      message('confirmed', {
        kind: 'photo',
        status: 'Sent',
        sequenceNumber: 10,
        createdAt: '2026-07-27T00:00:00Z',
        media: { id: 'media-confirmed', kind: 'photo', fileUrl: 'https://cdn/confirmed.jpg' }
      })
    );
    models.messages.insert(
      message('optimistic', {
        kind: 'photo',
        sequenceNumber: null,
        createdAt: '2026-07-27T00:01:00Z',
        media: { id: 'media-optimistic', kind: 'photo', fileUrl: 'file:///optimistic.jpg' }
      })
    );

    const expected = ['optimistic', 'confirmed'];
    expect(models.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id)).toEqual(expected);
    expect(models.messages.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'visual' }).map((row: any) => row.id)).toEqual(expected);

    models.messages.update('optimistic', { sequenceNumber: 11 });

    expect(models.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id)).toEqual(expected);
    expect(models.messages.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'visual' }).map((row: any) => row.id)).toEqual(expected);
  });
});

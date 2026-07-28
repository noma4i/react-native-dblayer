import { act } from 'react';
import { configureDb, resetRuntime } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';
import { createAppModels } from './appModels';

const setup = (tag: string) => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() as never });
  return { storage, models: createAppModels(tag) };
};

const write = (model: any, row: unknown): void => model.insert(row);
const writeMany = (model: any, rows: unknown[]): void => model.insertMany(rows);

const addAccount = (models: ReturnType<typeof createAppModels>, account: string) => {
  const now = `2026-07-26T00:00:${account === 'A' ? '00' : '01'}Z`;
  write(models.currentUser, { id: `current-${account}`, uuid: `uuid-${account}`, fullName: `Current ${account}`, username: `current-${account}`, online: true, createdAt: now, updatedAt: now, registrationCompleted: true, balance: 0, filterGender: 'all', filterMinAge: 18, filterMaxAge: 99, kind: 'user', hasCompass: false, hasMoments: false, hasPhoto: false, hasGoodPhoto: false, hasInitialMoment: false, stickyLocation: false, status: 'active', preferenceNotifyConnection: true, preferenceNotifyMessage: true, preferenceVibration: true, receivedGifts: [] });
  write(models.users, { id: `user-${account}`, uuid: `user-uuid-${account}`, fullName: `User ${account}`, username: `user-${account}`, online: false, createdAt: now, updatedAt: now });
  writeMany(models.chats, [
    { id: `chat-${account}-1`, kind: 'personal', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 3, messagesCount: 1, lastActivityAt: now, userIds: [`user-${account}`], createdAt: now, updatedAt: now },
    { id: `chat-${account}-2`, kind: 'group', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 1, lastActivityAt: now, userIds: [`user-${account}`], createdAt: now, updatedAt: now }
  ]);
  writeMany(models.messages, [
    { id: `message-${account}-1`, chatId: `chat-${account}-1`, userId: `user-${account}`, kind: 'text', body: `message-${account}-1`, createdAt: now, updatedAt: now, sequenceNumber: 1 },
    { id: `message-${account}-2`, chatId: `chat-${account}-2`, userId: `user-${account}`, kind: 'text', body: `message-${account}-2`, createdAt: now, updatedAt: now, sequenceNumber: 1 }
  ]);
  write(models.moments, { id: `moment-${account}`, uuid: `moment-uuid-${account}`, userId: `user-${account}`, createdAt: now, updatedAt: now });
  models.counters.upsertCurrent({ unreadChatsCount: account === 'A' ? 7 : 0, unreadCompassCount: account === 'A' ? 5 : 0 });
  write(models.vibes, { id: `vibe-${account}`, name: `Vibe ${account}`, color: 'blue', position: account === 'A' ? 1 : 2, createdAt: now, updatedAt: now });
  write(models.walletTransactions, { id: `wallet-${account}`, amount: 1, kind: 'gift', createdAt: now, updatedAt: now });
};

describe('app-shaped data mixing contracts', () => {
  it('S1 keeps feed byIds rows aligned to their actual ids when found and missing ids mix', () => {
    const { models } = setup('S1');
    writeMany(models.moments, [
      { id: 'moment-author-a', uuid: 'moment-a', userId: 'author-A', createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' },
      { id: 'moment-author-b', uuid: 'moment-b', userId: 'author-B', createdAt: '2026-07-26T00:00:01Z', updatedAt: '2026-07-26T00:00:01Z' }
    ]);
    const reader = renderCounted(() => models.moments.use.byIds(['moment-author-b', 'missing', 'moment-author-a']));

    expect(reader.result().byId.get('missing')).toBeUndefined();
    expect(reader.result().rows.map(row => row.id)).toEqual(['moment-author-b', 'moment-author-a']);
    expect(reader.result().byId.get('moment-author-a')?.userId).toBe('author-A');
    expect(reader.result().byId.get('moment-author-b')?.userId).toBe('author-B');
    reader.unmount();
  });

  it('S2 removes every account A row and persisted marker before account B starts', () => {
    const { storage, models } = setup('S2');
    addAccount(models, 'A');
    expect(storage.snapshotKeys().some(key => (storage.get(key) ?? '').includes('message-A-1'))).toBe(true);

    resetRuntime();
    addAccount(models, 'B');

    expect(models.chats.scopes.list.read({ statusFilter: 'active' }).every((row: any) => !row.id.includes('-A-'))).toBe(true);
    expect(models.messages.scopes.thread.read({ chatId: 'chat-B-1' }).every((row: any) => !row.id.includes('-A-'))).toBe(true);
    expect(models.moments.scopes.byUser.read({ userId: 'user-B' }).every((row: any) => !row.id.includes('-A'))).toBe(true);
    expect(models.counters.current()?.unreadChatsCount).toBe(0);
    const momentByIds = renderCounted(() => models.moments.use.byIds(['moment-A', 'moment-B']));
    expect(momentByIds.result().byId.get('moment-A')).toBeUndefined();
    expect(momentByIds.result().byId.get('moment-B')?.id).toBe('moment-B');
    momentByIds.unmount();
    const persisted = storage.snapshotKeys().map(key => `${key}:${storage.get(key) ?? ''}`).join('\n');
    expect(persisted).not.toContain('message-A');
    expect(persisted).not.toContain('chat-A');
    expect(persisted).not.toContain('user-A');
  });

  it('S3 isolates thread and two-field media scopes across chats and buckets', () => {
    const { models } = setup('S3');
    writeMany(models.chats, [
      { id: 'chat-1', kind: 'personal', status: 'active', premium: false, isPublic: false, history: 'all', pinned: true, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt: '2026-07-26T00:00:00Z', userIds: [], createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' },
      { id: 'chat-2', kind: 'system', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt: '2026-07-26T00:00:00Z', userIds: [], createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' }
    ]);
    const threadOne = renderCounted(() => models.messages.scopes.thread.useWindow({ chatId: 'chat-1' }, { pageSize: 10 }));
    const threadTwo = renderCounted(() => models.messages.scopes.thread.useWindow({ chatId: 'chat-2' }, { pageSize: 10 }));
    const visual = renderCounted(() => models.messages.scopes.media.useWindow({ chatId: 'chat-1', mediaBucket: 'visual' }, { pageSize: 10 }));
    const audio = renderCounted(() => models.messages.scopes.media.useWindow({ chatId: 'chat-1', mediaBucket: 'audio' }, { pageSize: 10 }));
    const audioCount = renderCounted(() => models.messages.scopes.media.useCount({ chatId: 'chat-1', mediaBucket: 'audio' }));

    act(() => {
      writeMany(models.messages, [
        { id: 'message-visual', chatId: 'chat-1', userId: 'other', kind: 'photo', createdAt: '2026-07-26T00:00:02Z', updatedAt: '2026-07-26T00:00:02Z', sequenceNumber: 2, media: { id: 'media-visual', kind: 'photo', fileUrl: 'visual' } },
        { id: 'message-audio', chatId: 'chat-1', userId: 'other', kind: 'audio', createdAt: '2026-07-26T00:00:03Z', updatedAt: '2026-07-26T00:00:03Z', sequenceNumber: 3, media: { id: 'media-audio', kind: 'audio', fileUrl: 'audio' } },
        { id: 'message-other-chat', chatId: 'chat-2', userId: 'other', kind: 'text', createdAt: '2026-07-26T00:00:04Z', updatedAt: '2026-07-26T00:00:04Z', sequenceNumber: 4 }
      ]);
    });

    expect(threadOne.result().rows.map((row: any) => row.id)).toEqual(['message-audio', 'message-visual']);
    expect(threadTwo.result().rows.map((row: any) => row.id)).toEqual(['message-other-chat']);
    expect(visual.result().rows.map((row: any) => row.id)).toEqual(['message-visual']);
    expect(audio.result().rows.map((row: any) => row.id)).toEqual(['message-audio']);
    expect(audioCount.result()).toBe(1);
    expect(models.chats.scopes.pinnedNonSystem.read({ statusFilter: 'active' }).map((row: any) => row.id)).toEqual(['chat-1']);
    expect(models.chats.scopes.pinnedOrSystem.read({ statusFilter: 'active' }).map((row: any) => row.id)).toEqual(['chat-2', 'chat-1']);
    threadOne.unmount(); threadTwo.unmount(); visual.unmount(); audio.unmount(); audioCount.unmount();
  });

  it('S4 confines touches, counter cache, and member references to the owning chat', () => {
    const { models } = setup('S4');
    write(models.currentUser, { id: 'me', uuid: 'me', fullName: 'Me', username: 'me', online: true, createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z', registrationCompleted: true, balance: 0, filterGender: 'all', filterMinAge: 18, filterMaxAge: 99, kind: 'user', hasCompass: false, hasMoments: false, hasPhoto: false, hasGoodPhoto: false, hasInitialMoment: false, stickyLocation: false, status: 'active', preferenceNotifyConnection: true, preferenceNotifyMessage: true, preferenceVibration: true, receivedGifts: [] });
    writeMany(models.users, [
      { id: 'member-1', uuid: 'member-1', fullName: 'Member One', username: 'member-1', online: false, createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' },
      { id: 'member-2', uuid: 'member-2', fullName: 'Member Two', username: 'member-2', online: false, createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' }
    ]);
    writeMany(models.chats, [
      { id: 'chat-1', kind: 'personal', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt: '2026-07-26T00:00:00Z', userIds: ['member-1'], createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' },
      { id: 'chat-2', kind: 'personal', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt: '2026-07-26T00:00:00Z', userIds: ['member-2'], createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' }
    ]);
    const memberUsers = renderCounted(() => models.users.use.byIds(models.chats.find('chat-1')?.userIds ?? []));

    act(() => {
      writeMany(models.messages, [
        { id: 'own-message', chatId: 'chat-1', userId: 'me', kind: 'text', createdAt: '2026-07-26T00:00:01Z', updatedAt: '2026-07-26T00:00:01Z', sequenceNumber: 1 },
        { id: 'other-message', chatId: 'chat-1', userId: 'member-1', kind: 'text', createdAt: '2026-07-26T00:00:02Z', updatedAt: '2026-07-26T00:00:02Z', sequenceNumber: 2 }
      ]);
    });

    expect(models.chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'other-message', lastActivityAt: '2026-07-26T00:00:02Z' });
    expect(models.chats.find('chat-2')).toMatchObject({ unreadCount: 0, lastActivityAt: '2026-07-26T00:00:00Z' });
    expect(models.chats.find('chat-2')?.lastMessageId).toBeUndefined();
    expect(memberUsers.result().rows.map((row: any) => row.id)).toEqual(['member-1']);
    expect(memberUsers.result().byId.get('member-2')).toBeUndefined();
    memberUsers.unmount();
  });
});

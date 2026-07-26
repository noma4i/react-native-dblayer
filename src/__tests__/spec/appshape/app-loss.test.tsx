import { act } from 'react-test-renderer';
import { configureDb } from '../../../index';
import { bootDb } from '../../../dsl/lifecycle';
import { flushPersistence } from '../../../dsl/configure';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { stableSerialize } from '../../../core/serialize';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';
import { createAppModels } from './appModels';

const document = { kind: 'Document', definitions: [] } as never;

const write = (model: any, row: unknown): void => model.insert(row);
const writeMany = (model: any, rows: unknown[]): void => model.insertMany(rows);

const addAccount = (models: ReturnType<typeof createAppModels>, account: string, messageCount = 2): void => {
  const now = '2026-07-26T00:00:00Z';
  write(models.currentUser, { id: `current-${account}`, uuid: `uuid-${account}`, fullName: `Current ${account}`, username: `current-${account}`, online: true, createdAt: now, updatedAt: now, registrationCompleted: true, balance: 0, filterGender: 'all', filterMinAge: 18, filterMaxAge: 99, kind: 'user', hasCompass: false, hasMoments: false, hasPhoto: false, hasGoodPhoto: false, hasInitialMoment: false, stickyLocation: false, status: 'active', preferenceNotifyConnection: true, preferenceNotifyMessage: true, preferenceVibration: true, receivedGifts: [] });
  write(models.users, { id: `user-${account}`, uuid: `user-uuid-${account}`, fullName: `User ${account}`, username: `user-${account}`, online: false, createdAt: now, updatedAt: now });
  writeMany(models.chats, Array.from({ length: 2 }, (_, index) => ({ id: `chat-${account}-${index + 1}`, kind: index === 0 ? 'personal' : 'group', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: messageCount, lastActivityAt: now, userIds: [`user-${account}`], createdAt: now, updatedAt: now })));
  writeMany(models.messages, Array.from({ length: messageCount }, (_, index) => ({ id: `message-${account}-${index + 1}`, chatId: `chat-${account}-1`, userId: `user-${account}`, kind: index === 0 ? 'photo' : 'text', body: `message-${account}-${index + 1}`, createdAt: `2026-07-26T00:00:${String(index).padStart(2, '0')}Z`, updatedAt: now, sequenceNumber: index + 1, ...(index === 0 ? { media: { id: `media-${account}`, kind: 'photo', fileUrl: `https://cdn/${account}.jpg` } } : {}) })));
  write(models.moments, { id: `moment-${account}`, uuid: `moment-uuid-${account}`, userId: `user-${account}`, media: { id: `moment-media-${account}`, kind: 'photo', fileUrl: `https://cdn/moment-${account}.jpg` }, createdAt: now, updatedAt: now });
  models.counters.upsertCurrent({ unreadChatsCount: 2, unreadCompassCount: 1 });
  write(models.vibes, { id: `vibe-${account}`, name: `Vibe ${account}`, color: 'blue', position: 1, createdAt: now, updatedAt: now });
  write(models.walletTransactions, { id: `wallet-${account}`, amount: 1, kind: 'gift', createdAt: now, updatedAt: now });
};

const allModels = (models: ReturnType<typeof createAppModels>) => [models.users, models.chats, models.messages, models.moments, models.currentUser, models.counters, models.vibes, models.walletTransactions];

describe('app-shaped loss contracts', () => {
  it('L1 replaces an optimistic media message without losing its thread membership or continuity fields', async () => {
    let resolve!: (value: { data: any }) => void;
    const transport = createMockTransport({ mutation: async <TData,>() => new Promise<{ data: TData }>(nextResolve => { resolve = nextResolve as never; }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const models = createAppModels('LossL1');
    write(models.chats, { id: 'chat-1', kind: 'personal', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt: '2026-07-26T00:00:00Z', userIds: [], createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' });
    const reader = renderCounted(() => models.messages.scopes.thread.useWindow({ chatId: 'chat-1' }, { pageSize: 30 }));
    let tempId = '';
    const send = models.messages.mutation('send-media', {
      document,
      result: 'send',
      optimistic: {
        model: models.messages,
        build: (_input: void, context: { tempId: string | null }) => {
          tempId = context.tempId!;
          return { id: context.tempId!, chatId: 'chat-1', userId: 'me', kind: 'photo', status: 'Sending', body: 'optimistic', createdAt: '2026-07-26T00:00:01Z', updatedAt: '2026-07-26T00:00:01Z', sequenceNumber: 1, localPreviewUrl: 'file:///spool/preview.jpg', media: { id: 'media-1', kind: 'photo', fileUrl: 'file:///spool/upload.jpg', thumbUrl: 'file:///spool/upload.jpg', width: 320, height: 240 } };
        },
        selectServerNode: (data: any) => data.send.message
      }
    });

    const pending = send.run();
    await act(async () => {
      await Promise.resolve();
    });
    expect(reader.result().rows.map((row: any) => row.id)).toEqual([tempId]);
    await act(async () => {
      resolve({ data: { send: { message: { id: 'message-server', chatId: 'chat-1', userId: 'me', kind: 'photo', status: 'Sent', body: 'server', createdAt: '2026-07-26T00:00:01Z', updatedAt: '2026-07-26T00:00:02Z', sequenceNumber: 1, media: { id: 'media-1', kind: 'photo', fileUrl: 'https://cdn/media.jpg', thumbUrl: 'https://cdn/thumb.jpg', blurHash: 'server-blur', width: null, height: null } } } } });
      await pending;
    });

    expect(models.messages.find(tempId)).toBeUndefined();
    expect(models.messages.find('message-server')).toMatchObject({ localPreviewUrl: 'file:///spool/preview.jpg', media: { fileUrl: 'https://cdn/media.jpg', blurHash: 'server-blur', width: 320, height: 240 } });
    expect(reader.result().rows.map((row: any) => row.id)).toEqual(['message-server']);
    reader.unmount();
  });

  it('L2 restores every app-shaped row and scope order byte-for-byte after configure and boot', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const tag = 'LossL2';
    const beforeModels = createAppModels(tag);
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });
    addAccount(beforeModels, 'A');
    flushPersistence();
    const beforeRows = allModels(beforeModels).map(model => stableSerialize(model.all()));
    const beforeScopes = {
      chats: beforeModels.chats.scopes.list.read({ statusFilter: 'active' }).map((row: any) => row.id),
      thread: beforeModels.messages.scopes.thread.read({ chatId: 'chat-A-1' }).map((row: any) => row.id),
      media: beforeModels.messages.scopes.media.read({ chatId: 'chat-A-1', mediaBucket: 'visual' }).map((row: any) => row.id)
    };

    configureDb({ storage, transport: createMockTransport() });
    const afterModels = createAppModels(tag);
    await bootDb();

    expect(allModels(afterModels).map(model => stableSerialize(model.all()))).toEqual(beforeRows);
    expect({
      chats: afterModels.chats.scopes.list.read({ statusFilter: 'active' }).map((row: any) => row.id),
      thread: afterModels.messages.scopes.thread.read({ chatId: 'chat-A-1' }).map((row: any) => row.id),
      media: afterModels.messages.scopes.media.read({ chatId: 'chat-A-1', mediaBucket: 'visual' }).map((row: any) => row.id)
    }).toEqual(beforeScopes);
  });

  it('L3 keeps a chat last-message protection while trimming only older unprotected thread rows', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('LossL3');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });
    writeMany(models.messages, Array.from({ length: 305 }, (_, index) => ({ id: `message-${index + 1}`, chatId: 'chat-1', userId: 'other', kind: 'text', body: String(index + 1), createdAt: `2026-07-26T00:00:${String(index % 60).padStart(2, '0')}Z`, updatedAt: '2026-07-26T00:00:00Z', sequenceNumber: index + 1 })));
    write(models.chats, { id: 'chat-1', kind: 'personal', status: 'active', premium: false, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 305, lastActivityAt: '2026-07-26T00:00:00Z', lastMessage: { id: 'message-1' }, userIds: [], createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:00Z' });

    await bootDb();

    const ids = models.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id);
    expect(ids).toHaveLength(301);
    expect(ids).toContain('message-1');
    expect(ids).toEqual(expect.arrayContaining(['message-305', 'message-304', 'message-6']));
    expect(ids).not.toEqual(expect.arrayContaining(['message-2', 'message-3', 'message-4', 'message-5']));
  });

  it('L4 keeps a failed optimistic message, then retries into one committed thread row', async () => {
    let calls = 0;
    const transport = createMockTransport({ mutation: async <TData,>() => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { data: { send: { message: { id: 'message-server', chatId: 'chat-1', userId: 'me', kind: 'text', status: 'Sent', body: 'server', createdAt: '2026-07-26T00:00:01Z', updatedAt: '2026-07-26T00:00:02Z', sequenceNumber: 1 } } } as TData };
    } });
    configureDb({ storage: createMemoryPlane(), transport });
    const models = createAppModels('LossL4');
    const reader = renderCounted(() => models.messages.scopes.thread.useWindow({ chatId: 'chat-1' }, { pageSize: 30 }));
    let tempId = '';
    const send = models.messages.mutation('send-retry', {
      document,
      result: 'send',
      optimistic: {
        model: models.messages,
        failure: 'keep',
        build: (_input: Record<string, never>, context: { tempId: string | null }) => {
          tempId = context.tempId!;
          return { id: tempId, chatId: 'chat-1', userId: 'me', kind: 'text', status: 'Sending', body: 'optimistic', createdAt: '2026-07-26T00:00:01Z', updatedAt: '2026-07-26T00:00:01Z', sequenceNumber: 1 };
        },
        selectServerNode: (data: any) => data.send.message,
        onFailurePatch: () => ({ status: 'Failed' }),
        onRetryPatch: () => ({ status: 'Sending' })
      }
    });

    await expect(send.run({})).rejects.toThrow('offline');
    expect(models.messages.find(tempId)).toMatchObject({ status: 'Failed' });
    await expect(send.retry(tempId)).resolves.toMatchObject({ send: { message: { id: 'message-server' } } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.messages.find(tempId)).toBeUndefined();
    expect(reader.result().rows.map((row: any) => row.id)).toEqual(['message-server']);
    expect(models.messages.scopes.thread.read({ chatId: 'chat-1' })).toHaveLength(1);
    reader.unmount();
  });
});

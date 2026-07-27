import { act } from 'react-test-renderer';
import { belongsTo, configureDb, defineModel, f, scope } from '../../../index';
import { getApplyTarget } from '../../../core/apply/transaction';
import { flushPersistence, getOperationState } from '../../../dsl/configure';
import { bootDb } from '../../../dsl/lifecycle';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Chat = { id: string; unreadCount: number; lastMessageId: string | null; lastActivityAt: number };
type Message = { id: string; chatId: string; body: string; createdAt: number };

describe('effects derive from accepted rows', () => {
  it('drops relation effects for an event row rejected by the write gate', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const chats = defineModel({
      id: 'EffectsAcceptanceChat',
      name: 'EffectsAcceptanceChat',
      fields: { unreadCount: f.num(), lastMessageId: f.str().nullable(), lastActivityAt: f.num() }
    });
    const messages = defineModel({
      id: 'EffectsAcceptanceMessage',
      name: 'EffectsAcceptanceMessage',
      fields: { chatId: f.str(), body: f.str(), createdAt: f.num() },
      scopes: { byChat: scope<Message>({ by: { chatId: 'chatId' } }) },
      relations: () => ({
        chat: belongsTo<Message, Chat>(chats, {
          foreignKey: 'chatId',
          touch: (message, chat) => message.createdAt > chat.lastActivityAt ? { lastMessageId: message.id, lastActivityAt: message.createdAt } : null,
          counterCache: { field: 'unreadCount' }
        })
      }),
      write: { accept: existing => existing === undefined }
    });
    chats.insertMany([
      { id: 'chat-1', unreadCount: 0, lastMessageId: null, lastActivityAt: 0 },
      { id: 'chat-2', unreadCount: 0, lastMessageId: null, lastActivityAt: 0 }
    ]);
    messages.insert({ id: 'message-1', chatId: 'chat-1', body: 'stored', createdAt: 1 });

    messages.ingest({ received: { handler: () => ({ upsert: { id: 'message-1', chatId: 'chat-2', body: 'rejected', createdAt: 2 } }) } }).apply('received', {});

    expect(messages.find('message-1')).toEqual({ id: 'message-1', chatId: 'chat-1', body: 'stored', createdAt: 1 });
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'message-1', lastActivityAt: 1 });
    expect(chats.find('chat-2')).toMatchObject({ unreadCount: 0, lastMessageId: null, lastActivityAt: 0 });
    expect(messages.scopes.byChat.read({ chatId: 'chat-1' }).map(row => row.id)).toEqual(['message-1']);
    expect(messages.scopes.byChat.read({ chatId: 'chat-2' })).toEqual([]);
  });

  it('does not commit a method patch ledger entry when its response apply fails', async () => {
    let resolveMutation!: (value: { data: { pin: { id: string; pinned: boolean } } }) => void;
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => await new Promise<{ data: TData }>(resolve => (resolveMutation = resolve as typeof resolveMutation)) }) });
    const chats = defineModel({ id: 'EffectsAcceptanceLedger', name: 'EffectsAcceptanceLedger', fields: { pinned: f.bool() } });
    chats.insert({ id: 'chat-1', pinned: false });
    const mutation = chats.mutation<{ pin: { id: string; pinned: boolean } }, Record<string, never>, { id: string; pinned: boolean }, { id: string; pinned: boolean }>('pin', {
      document: { kind: 'Document', definitions: [] } as never,
      result: 'pin',
      dedupe: false,
      optimistic: { method: 'patch', model: chats, selectId: () => 'chat-1', selectPatch: () => ({ pinned: true }) },
      extract: ({ data }) => [{ into: chats, rows: [data.pin] }]
    });
    const target = getApplyTarget(chats.modelId);
    const originalUpsert = target.upsert;
    let failApply = false;
    target.upsert = (...args) => {
      if (failApply) throw new Error('injected apply failure');
      return originalUpsert(...args);
    };
    let pending!: Promise<unknown>;
    act(() => {
      pending = mutation.run({});
    });
    failApply = true;
    resolveMutation({ data: { pin: { id: 'chat-1', pinned: false } } });
    await expect(pending).rejects.toThrow('injected apply failure');

    expect(getOperationState().pendingForRow(chats.modelId, 'chat-1')).toEqual([]);
    expect(getOperationState().failedForRow(chats.modelId, 'chat-1').map(operation => operation.status)).not.toContain('committed');
    expect(chats.find('chat-1')?.pinned).toBe(false);
    target.upsert = originalUpsert;
  });

  it('stores only raw relation intent and re-derives effects during journal replay', async () => {
    const storage = createMemoryPlane();
    const defineRows = () => {
      const chats = defineModel({ id: 'EffectsAcceptanceReplayChat', name: 'EffectsAcceptanceReplayChat', gc: 'exempt', fields: { unreadCount: f.num(), lastMessageId: f.str().nullable(), lastActivityAt: f.num() } });
      const messages = defineModel({
        id: 'EffectsAcceptanceReplayMessage',
        name: 'EffectsAcceptanceReplayMessage',
        gc: 'exempt',
        fields: { chatId: f.str(), body: f.str(), createdAt: f.num() },
        relations: () => ({
          chat: belongsTo<Message, Chat>(chats, {
            foreignKey: 'chatId',
            touch: (message, chat) => ({ lastMessageId: message.id, lastActivityAt: Math.max(chat.lastActivityAt, message.createdAt) }),
            counterCache: { field: 'unreadCount' }
          })
        })
      });
      return { chats, messages };
    };
    configureDb({ storage, transport: createMockTransport() });
    const first = defineRows();
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });
    first.chats.insert({ id: 'chat-1', unreadCount: 0, lastMessageId: null, lastActivityAt: 0 });
    first.messages.insert({ id: 'message-1', chatId: 'chat-1', body: 'stored', createdAt: 1 });

    const records = storage.keys('dbl:journal:').map(key => JSON.parse(storage.get(key)!) as { ops: Array<{ model: string; kind: string }> });
    expect(records.find(record => record.ops.some(op => op.model === first.messages.modelId))?.ops.map(op => ({ kind: op.kind, model: op.model }))).toEqual([{ kind: 'upsert', model: first.messages.modelId }]);
    expect(first.chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'message-1' });

    configureDb({ storage, transport: createMockTransport() });
    const replayed = defineRows();
    await expect(bootDb()).resolves.toMatchObject({ reset: false, replayed: 2 });

    expect(replayed.messages.find('message-1')).toMatchObject({ chatId: 'chat-1', body: 'stored' });
    expect(replayed.chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'message-1' });
    flushPersistence();
  });
});

import { belongsTo, defineModel, f, hasOne, references, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type UserRow = { id: string; name: string; role?: string };
type MessageRow = { id: string; chatId: string; sentAt: number; text: string };
type ChatRow = { id: string; inboxId: string; authorId: string; pinnedMessageId: string };

/**
 * Contracts for `Model.view` include resolution: define-time validation (unknown scope, foreign
 * scope, unknown relation, unsupported references), belongsTo null semantics, computed tuple
 * includes, scalar-id resolution, require filtering, and hasOne without a comparator.
 */
const createViewModels = (suffix: string) => {
  setupSpecRuntime();
  const users = defineModel({
    id: `SpecViewUsers${suffix}`,
    name: `SpecViewUsers${suffix}`,
    fields: { name: f.str(), role: f.str() }
  });
  const messages = defineModel({
    id: `SpecViewMessages${suffix}`,
    name: `SpecViewMessages${suffix}`,
    fields: { chatId: f.str(), sentAt: f.num(), text: f.str() }
  });
  const chats = defineModel({
    id: `SpecViewChats${suffix}`,
    name: `SpecViewChats${suffix}`,
    fields: { inboxId: f.str(), authorId: f.str(), pinnedMessageId: f.str() },
    scopes: { list: scope<ChatRow>({ by: { inboxId: 'inboxId' } }) },
    relations: () => ({
      author: belongsTo(users, { foreignKey: 'authorId' }),
      latest: hasOne(messages, { foreignKey: 'chatId' }),
      tagged: references(users, { ids: () => [] })
    })
  });
  return { users, messages, chats };
};

describe('view include contracts', () => {
  it('throws at define time when the named source scope does not exist', () => {
    const { chats } = createViewModels('MissingScope');

    expect(() => chats.view('broken', { source: 'missing', include: {} })).toThrow(/has no scope missing/);
  });

  it('throws at define time when the source scope belongs to another model', () => {
    const { chats, messages } = createViewModels('ForeignScope');
    const foreign = defineModel({
      id: 'SpecViewForeignScope',
      name: 'SpecViewForeignScope',
      fields: { inboxId: f.str() },
      scopes: { list: scope<{ id: string; inboxId: string }>({ by: { inboxId: 'inboxId' } }) }
    });
    void messages;

    expect(() => chats.view('broken', { source: foreign.scopes.list as never, include: {} })).toThrow(/has no scope/);
  });

  it('throws at define time when an include names an unknown relation', () => {
    const { chats } = createViewModels('UnknownRelation');

    expect(() => chats.view('broken', { source: 'list', include: { ghost: 'ghost' } })).toThrow(/has no relation ghost/);
  });

  it('throws at define time for a references include', () => {
    const { chats } = createViewModels('References');

    expect(() => chats.view('broken', { source: 'list', include: { tagged: 'tagged' } })).toThrow(/does not support references includes/);
  });

  it('resolves a belongsTo include to the referenced row', () => {
    const { users, chats } = createViewModels('BelongsTo');
    users.insert({ id: 'user-1', name: 'Ann', role: 'admin' });
    chats.insert({ id: 'chat-1', inboxId: 'main', authorId: 'user-1', pinnedMessageId: '' });
    const view = chats.view('withAuthor', { source: 'list', include: { author: 'author' }, select: (row, included) => ({ id: row.id, author: included.author as UserRow | null }) });

    const reader = renderCounted(() => view.use({ inboxId: 'main' } as never));

    expect(reader.result()).toEqual([{ id: 'chat-1', author: expect.objectContaining({ id: 'user-1', name: 'Ann' }) }]);
    reader.unmount();
  });

  it('yields null for a belongsTo include whose target row is missing', () => {
    const { chats } = createViewModels('BelongsToMissing');
    chats.insert({ id: 'chat-1', inboxId: 'main', authorId: 'ghost-user', pinnedMessageId: '' });
    const view = chats.view('withAuthor', { source: 'list', include: { author: 'author' }, select: (row, included) => ({ id: row.id, author: included.author as UserRow | null }) });

    const reader = renderCounted(() => view.use({ inboxId: 'main' } as never));

    expect(reader.result()).toEqual([{ id: 'chat-1', author: null }]);
    reader.unmount();
  });

  it('resolves a computed tuple include to a single row for a scalar id', () => {
    const { messages, chats } = createViewModels('Tuple');
    messages.insert({ id: 'msg-1', chatId: 'chat-1', sentAt: 1, text: 'pinned' });
    chats.insert({ id: 'chat-1', inboxId: 'main', authorId: 'user-1', pinnedMessageId: 'msg-1' });
    const view = chats.view('withPinned', {
      source: 'list',
      include: { pinned: [messages, (row: { pinnedMessageId: string }) => row.pinnedMessageId] as never },
      select: (row, included) => ({ id: row.id, pinned: included.pinned as MessageRow | null })
    });

    const reader = renderCounted(() => view.use({ inboxId: 'main' } as never));

    expect(reader.result()).toEqual([{ id: 'chat-1', pinned: expect.objectContaining({ id: 'msg-1', text: 'pinned' }) }]);
    reader.unmount();
  });

  it('yields null for a scalar-id include whose target row is missing', () => {
    const { messages, chats } = createViewModels('ScalarMissing');
    void messages;
    chats.insert({ id: 'chat-1', inboxId: 'main', authorId: 'user-1', pinnedMessageId: 'ghost-msg' });
    const view = chats.view('withPinned', {
      source: 'list',
      include: { pinned: { model: messages, ids: (row: { pinnedMessageId: string }) => row.pinnedMessageId } as never },
      select: (row, included) => ({ id: row.id, pinned: included.pinned as MessageRow | null })
    });

    const reader = renderCounted(() => view.use({ inboxId: 'main' } as never));

    expect(reader.result()).toEqual([{ id: 'chat-1', pinned: null }]);
    reader.unmount();
  });

  it('drops an included row that misses a required field', () => {
    const { users, chats } = createViewModels('Require');
    users.insert({ id: 'user-1', name: 'Ann' } as never);
    chats.insert({ id: 'chat-1', inboxId: 'main', authorId: 'user-1', pinnedMessageId: '' });
    const view = chats.view('withVerifiedAuthor', {
      source: 'list',
      include: { author: { model: users, ids: (row: { authorId: string }) => row.authorId, require: ['role'] } as never },
      select: (row, included) => ({ id: row.id, author: included.author as UserRow | null })
    });

    const reader = renderCounted(() => view.use({ inboxId: 'main' } as never));

    expect(reader.result()).toEqual([{ id: 'chat-1', author: null }]);
    reader.unmount();
  });

  it('picks the first indexed row for hasOne without a comparator', () => {
    const { messages, chats } = createViewModels('HasOnePlain');
    messages.insertMany([
      { id: 'msg-1', chatId: 'chat-1', sentAt: 1, text: 'first' },
      { id: 'msg-2', chatId: 'chat-1', sentAt: 2, text: 'second' }
    ]);
    chats.insert({ id: 'chat-1', inboxId: 'main', authorId: 'user-1', pinnedMessageId: '' });
    const view = chats.view('withLatest', { source: 'list', include: { latest: 'latest' }, select: (row, included) => ({ id: row.id, latest: included.latest as MessageRow | null }) });

    const reader = renderCounted(() => view.use({ inboxId: 'main' } as never));

    expect(reader.result()).toEqual([{ id: 'chat-1', latest: expect.objectContaining({ id: 'msg-1' }) }]);
    reader.unmount();
  });
});
